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
const { resolvedEventLink, rkeyFromAtUri } = require('../../src/marta/shared/eventLink');
const { eventAssociatedRefs } = require('../../src/marta/shared/standardSite');
const { findUnresolvedAlertForRoundup } = require('../../src/marta/alert/store');
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
// A bus cancellation surge stands up its own roundup incident (below the score
// threshold) only when it's severe: at least half the route's scheduled service
// shed AND a real count behind it. A milder surge stays a weak `cancellation`
// signal that must COMPOUND with gaps/ghosts to fire — mirroring the ghost
// override, and keeping announced-but-modest cancellations from re-opening the
// pin-forever problem that commit 83b3ecb fixed.
const CANCEL_OVERRIDE_FRAC = 0.5;
const CANCEL_OVERRIDE_MIN = 6;
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
  // Count only the shortfall MARTA hasn't already announced as cancellations;
  // an officially-curtailed route shouldn't open a degraded-service roundup on
  // its own. Falls back to raw missing for signals without cancellation context
  // (e.g. rail ghosts, legacy rows).
  const missing = Number.isFinite(Number(detail.unexplainedMissing))
    ? Number(detail.unexplainedMissing)
    : Number(detail.missing);
  const expected = Number(detail.expected);
  if (!Number.isFinite(missing) || !Number.isFinite(expected) || expected <= 0) return false;
  if (missing < GHOST_OVERRIDE_MIN_MISSING) return false;
  return missing / expected >= GHOST_OVERRIDE_PCT;
}

// A cancellation surge severe enough to be an incident on its own (see the
// CANCEL_OVERRIDE_* rationale). Reads the share of scheduled service lost that
// the cancellation detector stored, so the bar is the same "fraction" the
// detector gated on, just higher.
function cancellationOverrideQualifies(signal) {
  if (signal.source !== 'cancellation') return false;
  let detail = {};
  try {
    detail = signal.detail ? JSON.parse(signal.detail) : {};
  } catch (_e) {
    return false;
  }
  const canceled = Number(detail.canceled);
  const fraction = Number(detail.fraction);
  if (!Number.isFinite(canceled) || !Number.isFinite(fraction)) return false;
  if (canceled < CANCEL_OVERRIDE_MIN) return false;
  return fraction >= CANCEL_OVERRIDE_FRAC;
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
  return {
    total,
    bySource,
    ghostOverride: signals.some(ghostOverrideQualifies),
    cancellationOverride: signals.some(cancellationOverrideQualifies),
  };
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

    const { total, bySource, ghostOverride, cancellationOverride } = scoreSignals(signals);
    const label = `${kind}/${line}`;
    const ghostOverrideAlreadyPosted = signals.some(
      (s) => s.source === 'ghost' && s.posted === 1 && ghostOverrideQualifies(s),
    );
    if (ghostOverrideAlreadyPosted) {
      console.log(`marta-roundup: ${label} suppressed - ghost standalone already posted`);
      continue;
    }
    if (total < SCORE_THRESHOLD && !ghostOverride && !cancellationOverride) {
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
      // Thread the roundup UNDER an open official alert for the same line, if one
      // exists, so the bot's "degraded service" post and MARTA's official word
      // share one Bluesky thread (CTA parity). Standalone otherwise.
      let replyRef = null;
      const openAlertUri = findUnresolvedAlertForRoundup({ kind, line });
      if (openAlertUri) {
        try {
          replyRef = await resolveReplyRef(agent, openAlertUri);
        } catch (e) {
          console.warn(`marta-roundup: ${label} could not resolve open-alert thread: ${e.message}`);
        }
      }
      const result = replyRef ? await postText(agent, text, replyRef) : await postText(agent, text);
      console.log(
        `Posted MARTA roundup ${label}: ${result.url}${replyRef ? ' (threaded under open alert)' : ''}`,
      );
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
    const { total, ghostOverride, cancellationOverride } = scoreSignals(signals);
    const label = `${kind}/${row.line}`;
    // An override-qualifying surge holds the incident open even if its scaled
    // score sits under the resolve threshold — the route is still gutted. (No-op
    // for ghosts, whose override already implies a score ≥ the threshold.)
    if (total >= RESOLVE_SCORE_THRESHOLD || ghostOverride || cancellationOverride) {
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
      // Mint the event's standard.site document + attach associatedRefs so the
      // resolution card renders enhanced immediately (the root post rkey, = the
      // event slug, is known here), instead of waiting on the page-side rebuild.
      const rkey = rkeyFromAtUri(row.post_uri);
      const associatedRefs =
        link && rkey
          ? await eventAssociatedRefs(agent, {
              rkey,
              title: buildResolutionCardTitle({ kind, line: row.line, name }),
              publishedAt: now,
            })
          : null;
      const result = link
        ? await postWithExternal(agent, text, link, replyRef, associatedRefs)
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
  ghostOverrideQualifies,
  cancellationOverrideQualifies,
  scoreSignals,
  buildRoundupText,
  buildResolutionText,
  processKind,
  sweepResolutions,
  routeMaps,
};

if (require.main === module) runBin(main);
