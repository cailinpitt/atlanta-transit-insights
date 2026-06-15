#!/usr/bin/env node
// MARTA alert-bot roundup for bot-detected issues. Detector accounts still own
// the detailed gap/bunching/ghost posts; this job mirrors CTA's alerts account
// behavior by posting a correlated "service appears degraded" alert from
// martaalertinsights, then a threaded resolution reply when signals quiet.

require('../../src/shared/env');

const Path = require('node:path');
const { setup, runBin } = require('../../src/marta/shared/runBin');
const { loadGtfs } = require('../../src/marta/gtfs');
const {
  getDb,
  getRecentMetaSignals,
  recordRoundupAnchor,
  listUnresolvedRoundupAnchors,
  updateRoundupClearTicks,
  markRoundupResolved,
} = require('../../src/marta/shared/incidents');
const { acquireCooldown } = require('../../src/marta/shared/state');
const {
  loginAlerts,
  postText,
  postWithExternal,
  resolveReplyRef,
} = require('../../src/marta/shared/bluesky');
const { resolvedEventLink } = require('../../src/marta/shared/eventLink');
const { describeSignal } = require('../../src/shared/observationDescribe');
const { lineTitle } = require('../../src/marta/rail/post');

const GTFS_DIR =
  process.env.MARTA_GTFS_DIR || Path.join(__dirname, '..', '..', 'data', 'marta', 'gtfs');

const WINDOW_MS = 30 * 60 * 1000;
const SCORE_THRESHOLD = 1.75;
const RESOLVE_SCORE_THRESHOLD = 1.0;
const RESOLVE_MIN_CLEAR_TICKS = 3;
const ROUNDUP_COOLDOWN_MS = 60 * 60 * 1000;
const PERSISTENCE_BONUS_PER_REPEAT = 0.15;
const PERSISTENCE_BONUS_CAP = 0.5;
const GHOST_OVERRIDE_PCT = 0.5;
const GHOST_OVERRIDE_MIN_MISSING = 3;
const DRY_RUN = process.env.ROUNDUP_DRY_RUN === '1' || process.argv.includes('--dry-run');

function routeMaps(gtfs) {
  const byMode = { bus: [], rail: [] };
  const names = { bus: new Map(), rail: new Map() };
  for (const r of gtfs.routes || []) {
    const short = String(r.route_short_name || '').trim();
    if (!short) continue;
    const type = String(r.route_type);
    const kind = type === '1' ? 'rail' : type === '3' ? 'bus' : null;
    if (!kind) continue;
    byMode[kind].push(short);
    if (r.route_long_name) names[kind].set(short, r.route_long_name);
  }
  byMode.rail.sort();
  byMode.bus.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  return { identifiers: byMode, names };
}

function routeLabel(kind, line, name = null) {
  if (kind === 'bus') return name ? `Route ${line} (${name})` : `Route ${line}`;
  return lineTitle(line);
}

function postPrefix(kind, resolved = false) {
  if (kind === 'bus') return resolved ? '🚌✅' : '🚌⚠️';
  return resolved ? '🚇✅' : '🚇⚠️';
}

function ghostOverrideQualifies(signal) {
  if (signal.source !== 'ghost') return false;
  let detail = {};
  try {
    detail = signal.detail ? JSON.parse(signal.detail) : {};
  } catch (_e) {
    return false;
  }
  const missing = Number(detail.missing);
  const expected = Number(detail.expected);
  if (!Number.isFinite(missing) || !Number.isFinite(expected) || expected <= 0) return false;
  if (missing < GHOST_OVERRIDE_MIN_MISSING) return false;
  return missing / expected >= GHOST_OVERRIDE_PCT;
}

function scoreSignals(signals) {
  const bySource = new Map();
  for (const s of signals) {
    const cur = bySource.get(s.source) || { severity: 0, count: 0 };
    bySource.set(s.source, {
      severity: Math.max(cur.severity, s.severity),
      count: cur.count + 1,
    });
  }
  let total = 0;
  for (const v of bySource.values()) {
    const bonus = Math.min(PERSISTENCE_BONUS_CAP, PERSISTENCE_BONUS_PER_REPEAT * (v.count - 1));
    v.contribution = v.severity + bonus;
    v.bonus = bonus;
    total += v.contribution;
  }
  return { total, bySource, ghostOverride: signals.some(ghostOverrideQualifies) };
}

function severityFor(s) {
  if (s.source === 'ghost') {
    try {
      const d = s.detail ? JSON.parse(s.detail) : {};
      const missing = Number(d.missing);
      const expected = Number(d.expected);
      if (Number.isFinite(missing) && expected > 0) return missing / expected;
    } catch (_e) {}
    return 0;
  }
  return Number.isFinite(s.severity) ? s.severity : 0;
}

function pickBestBySource(signals) {
  const bestBySource = new Map();
  for (const s of signals) {
    const cur = bestBySource.get(s.source);
    if (!cur || severityFor(s) > severityFor(cur)) bestBySource.set(s.source, s);
  }
  return [...bestBySource.values()];
}

function buildRoundupText({ kind, line, name, signals }) {
  const picks = pickBestBySource(signals);
  const bullets = picks.map((s) => describeSignal(s, kind === 'bus' ? 'bus' : 'train'));
  const multi = bullets.length > 1;
  return [
    `${postPrefix(kind)} ${routeLabel(kind, line, name)} · ${multi ? 'multiple signals' : 'signal'}`,
    ...bullets,
    '',
    multi
      ? 'Multiple signals suggest service may be degraded.'
      : 'Signal suggests service may be degraded.',
  ].join('\n');
}

function buildResolutionText({ kind, line, name }) {
  return `${postPrefix(kind, true)} ${routeLabel(kind, line, name)} · service signals back to normal`;
}

function buildResolutionCardTitle({ kind, line, name }) {
  return `${routeLabel(kind, line, name)} · service signals back to normal`;
}

async function processKind({ kind, identifiers, getName, agentGetter, now }) {
  const openLines = new Set(listUnresolvedRoundupAnchors(kind).map((row) => String(row.line)));
  for (const line of identifiers) {
    if (openLines.has(String(line))) continue;
    const signals = getRecentMetaSignals({ kind, line, withinMs: WINDOW_MS }, now);
    if (signals.length === 0) continue;

    const { total, bySource, ghostOverride } = scoreSignals(signals);
    const label = `${kind}/${line}`;
    const ghostOverrideAlreadyPosted = signals.some(
      (s) => s.source === 'ghost' && s.posted === 1 && ghostOverrideQualifies(s),
    );
    if (ghostOverrideAlreadyPosted) {
      console.log(`marta-roundup: ${label} suppressed - ghost standalone already posted`);
      continue;
    }
    if (total < SCORE_THRESHOLD && !ghostOverride) {
      console.log(
        `marta-roundup: ${label} score=${total.toFixed(2)} sources=${[...bySource.keys()].join(',')} below threshold`,
      );
      continue;
    }

    const text = buildRoundupText({ kind, line, name: getName(line), signals });
    if (DRY_RUN) {
      console.log(`--- DRY RUN marta-roundup ${label} score=${total.toFixed(2)} ---\n${text}`);
      continue;
    }
    if (!acquireCooldown(`roundup_${kind}_${line}`, now, ROUNDUP_COOLDOWN_MS)) {
      console.log(`marta-roundup: ${label} cooldown active, skipping`);
      continue;
    }

    try {
      const agent = await agentGetter();
      const result = await postText(agent, text);
      console.log(`Posted MARTA roundup ${label}: ${result.url}`);
      const earliestSignalTs = signals.reduce((m, s) => (s.ts < m ? s.ts : m), now);
      const bullets = pickBestBySource(signals).map((s) => {
        let detail = null;
        try {
          detail = s.detail
            ? typeof s.detail === 'string'
              ? JSON.parse(s.detail)
              : s.detail
            : null;
        } catch (_e) {
          detail = null;
        }
        return { source: s.source, detail };
      });
      recordRoundupAnchor({
        kind,
        line,
        postUri: result.uri,
        postCid: result.cid,
        ts: earliestSignalTs,
        signals: signals.map((s) => s.source),
        bullets,
      });
      const ids = signals.map((s) => s.id);
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        getDb()
          .prepare(`UPDATE meta_signals SET posted = 1 WHERE id IN (${placeholders})`)
          .run(...ids);
      }
    } catch (e) {
      console.error(`marta-roundup post failed for ${label}: ${e.stack || e.message}`);
    }
  }
}

async function sweepResolutions({ kind, getName, agentGetter, now }) {
  for (const row of listUnresolvedRoundupAnchors(kind)) {
    const signals = getRecentMetaSignals({ kind, line: row.line, withinMs: WINDOW_MS }, now);
    const { total } = scoreSignals(signals);
    const label = `${kind}/${row.line}`;
    if (total >= RESOLVE_SCORE_THRESHOLD) {
      if (row.clear_ticks !== 0) updateRoundupClearTicks(row.id, 0, now);
      continue;
    }

    const newClearTicks = (row.clear_ticks || 0) + 1;
    const latestSignalTs = signals.reduce((m, s) => (m == null || s.ts > m ? s.ts : m), null);
    if (newClearTicks < RESOLVE_MIN_CLEAR_TICKS) {
      updateRoundupClearTicks(row.id, newClearTicks, now, latestSignalTs ?? now);
      console.log(
        `marta-roundup-resolve: ${label} clear tick ${newClearTicks}/${RESOLVE_MIN_CLEAR_TICKS} (score=${total.toFixed(2)})`,
      );
      continue;
    }

    const name = getName(row.line);
    const text = buildResolutionText({ kind, line: row.line, name });
    const link = resolvedEventLink(
      row.post_uri,
      buildResolutionCardTitle({ kind, line: row.line, name }),
    );
    if (DRY_RUN) {
      console.log(`--- DRY RUN marta-roundup-resolve ${label} (link: ${link?.url}) ---\n${text}`);
      continue;
    }

    try {
      const agent = await agentGetter();
      const replyRef = await resolveReplyRef(agent, row.post_uri);
      if (!replyRef) {
        markRoundupResolved(row.id, null, now);
        console.log(
          `marta-roundup-resolve: ${label} source post missing - marked resolved silently`,
        );
        continue;
      }
      const result = link
        ? await postWithExternal(agent, text, link, replyRef)
        : await postText(agent, text, replyRef);
      markRoundupResolved(row.id, result.uri, now);
      console.log(`Posted MARTA roundup resolution ${label}: ${result.url}`);
    } catch (e) {
      console.error(`marta-roundup-resolve post failed for ${label}: ${e.stack || e.message}`);
    }
  }
}

async function main() {
  setup();
  const now = Date.now();
  const gtfs = loadGtfs(GTFS_DIR);
  const { identifiers, names } = routeMaps(gtfs);
  let agent = null;
  const agentGetter = async () => {
    if (!agent) agent = await loginAlerts();
    return agent;
  };

  await processKind({
    kind: 'rail',
    identifiers: identifiers.rail,
    getName: (line) => names.rail.get(line) || null,
    agentGetter,
    now,
  });
  await processKind({
    kind: 'bus',
    identifiers: identifiers.bus,
    getName: (route) => names.bus.get(route) || null,
    agentGetter,
    now,
  });
  await sweepResolutions({
    kind: 'rail',
    getName: (line) => names.rail.get(line) || null,
    agentGetter,
    now,
  });
  await sweepResolutions({
    kind: 'bus',
    getName: (route) => names.bus.get(route) || null,
    agentGetter,
    now,
  });
}

module.exports = {
  scoreSignals,
  buildRoundupText,
  buildResolutionText,
  processKind,
  sweepResolutions,
  routeMaps,
};

if (require.main === module) runBin(main);
