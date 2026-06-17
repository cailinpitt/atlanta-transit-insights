#!/usr/bin/env node
// Export MARTA official alerts + bot detections as schema-v2 incidents for the
// public web data payload.

require('../../src/shared/env');

const Fs = require('node:fs');
const Path = require('node:path');
const Database = require('better-sqlite3');
const { canonicalMode, canonicalRoute, routeMatchKey } = require('../../src/marta/routeKeys');
const { describeBotEvidenceBullets } = require('../../src/shared/observationDescribe');
const { classifyRailCancellation } = require('../../src/marta/alert/cancellation');
const { ensureSchema: ensureAlertSchema } = require('../../src/marta/alert/store');

const DB_PATH =
  process.env.MARTA_HISTORY_DB_PATH || Path.join(__dirname, '..', '..', 'state', 'marta.sqlite');

const PAIR_BUFFER_MS = 2 * 60 * 60 * 1000;
const PAIR_GRACE_MS = 10 * 60 * 1000;

function atUriToUrl(uri) {
  if (!uri) return null;
  const parts = uri.split('/');
  if (parts.length < 5) return null;
  const did = parts[2];
  const rkey = parts[4];
  if (!did || !rkey) return null;
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

function postUrlRkey(postUrl) {
  if (!postUrl) return null;
  const m = /\/post\/([^/?#]+)/.exec(postUrl);
  return m ? m[1] : null;
}

function parseRoutes(routes) {
  return String(routes || '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
}

function normalizeRoute(route) {
  return routeMatchKey(route);
}

function titleCaseRoute(route) {
  const s = String(route || '').trim();
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function modeForKind(kind) {
  return kind === 'rail' ? 'rail' : kind;
}

function canonicalRoutes(routes) {
  return (routes || []).map(canonicalRoute);
}

function lifecycleBlock({ firstSeenTs, resolvedTs, active, durationMs }) {
  return {
    first_seen_ts: firstSeenTs ?? null,
    resolved_ts: resolvedTs ?? null,
    active,
    duration_ms:
      durationMs ??
      (resolvedTs != null && firstSeenTs != null ? Math.max(0, resolvedTs - firstSeenTs) : null),
  };
}

// Parse a JSON station array stored on the alert row; tolerant of null / bad
// JSON (returns []).
function parseStationList(json) {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function officialScope(alert) {
  return {
    routes: canonicalRoutes(alert.routes),
    agency_wide: alert.routes.length === 0,
    // Structured station fields extracted from rail-alert prose at ingest
    // (src/marta/alert/stations.js). The website ties the alert to its
    // /station/:slug pages from these. Omitted (null/[]) for bus, streetcar,
    // and rail alerts whose text names no station.
    from_station: alert.affected_from_station ?? null,
    to_station: alert.affected_to_station ?? null,
    mentioned_stations: parseStationList(alert.mentioned_stations),
  };
}

function officialAlertBlock(alert) {
  const routes = canonicalRoutes(alert.routes);
  const block = {
    id: alert.alert_id,
    mode: canonicalMode(alert.mode, routes),
    routes,
    headline: alert.headline ?? null,
    description: alert.description ?? null,
    cause: alert.cause ?? null,
    effect: alert.effect ?? null,
    post_url: alert.post_url,
    resolved_reply_url: alert.resolved_reply_url,
    lifecycle: lifecycleBlock({
      firstSeenTs: alert.first_seen_ts,
      resolvedTs: alert.resolved_ts ?? null,
      active: alert.resolved_ts == null,
    }),
    scope: officialScope(alert),
    agency_event_window: {
      start_ts: alert.active_start_ts ?? null,
      end_ts: alert.active_end_ts ?? null,
    },
  };
  if (alert.versions?.length > 1) block.versions = alert.versions;
  return block;
}

function detectionScope(det) {
  return {
    route: canonicalRoute(det.route),
    direction: det.direction ?? null,
    near_stop: det.near_stop ?? null,
  };
}

function detectionBlock(det) {
  return {
    id: det.id,
    source: det.source,
    scope: detectionScope(det),
    lifecycle: lifecycleBlock({
      firstSeenTs: det.ts,
      resolvedTs: det.resolved_ts ?? null,
      active: det.resolved_ts == null,
    }),
    post_url: det.post_url,
    resolved_post_url: det.resolved_post_url ?? null,
    description: det.description,
    evidence: {
      details: det.evidence,
      // Roundups bundle several detectors; surface the real sub-signals
      // ('ghost', 'gap', …) so the event page shows them as Signal chips.
      // Single detectors carry their own source as the lone signal.
      signals: det.source === 'roundup' ? (det.evidence?.signals ?? []) : [det.source],
      bullets: det.bullets,
    },
  };
}

function roundupDetection(row) {
  const route = String(row.line);
  const kind = row.kind;
  const outRoute = canonicalRoute(route);
  const mode = canonicalMode(modeForKind(kind), outRoute);
  const signals = String(row.signals || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  let rawBullets = [];
  try {
    rawBullets = row.bullets ? JSON.parse(row.bullets) : [];
  } catch (_) {
    rawBullets = [];
  }
  // Pre-render the per-source picks into plain-English strings here, the same
  // way CTA's export does. The roundup_anchors.bullets column stores raw
  // {source, detail} objects; shipping those to the web app crashes its bullet
  // renderer (it calls String.prototype.replace on each entry). The shared
  // renderer keeps post and web wording in one place.
  const bullets =
    describeBotEvidenceBullets({
      detection_source: 'roundup',
      kind: mode === 'rail' ? 'train' : 'bus',
      bullets: rawBullets,
    }) ?? [];
  const description =
    mode === 'rail'
      ? `${titleCaseRoute(route)} Line service signals`
      : mode === 'streetcar'
        ? 'Streetcar service signals'
        : `Route ${route} service signals`;
  return {
    id: `marta-roundup-${row.id}`,
    source: 'roundup',
    kind,
    mode,
    route: outRoute,
    direction: null,
    near_stop: null,
    ts: row.ts,
    resolved_ts: row.resolved_ts ?? null,
    post_url: atUriToUrl(row.post_uri),
    resolved_post_url: atUriToUrl(row.resolution_post_uri),
    description,
    evidence: {
      signals,
    },
    bullets,
  };
}

function gapDetection(row) {
  const route = String(row.route);
  const outRoute = canonicalRoute(route);
  const mode = canonicalMode(modeForKind(row.kind), outRoute);
  const gapMin = Math.round(row.gap_min);
  const expectedMin = Math.round(row.expected_min);
  const description =
    mode === 'rail'
      ? `${titleCaseRoute(route)} Line ${gapMin} min gap`
      : mode === 'streetcar'
        ? `Streetcar ${gapMin} min gap`
        : `Route ${route} ${gapMin} min gap`;
  return {
    id: `marta-gap-${row.id}`,
    source: 'gap',
    kind: row.kind,
    mode,
    route: outRoute,
    direction: row.direction ?? null,
    near_stop: row.near_stop ?? null,
    ts: row.ts,
    resolved_ts: row.resolved_ts ?? null,
    post_url: atUriToUrl(row.post_uri),
    resolved_post_url: atUriToUrl(row.resolved_post_uri),
    description,
    evidence: {
      gap_ft: row.gap_ft,
      gap_min: row.gap_min,
      expected_min: row.expected_min,
      ratio: row.ratio,
    },
    bullets: [
      `~${gapMin} min gap`,
      `scheduled around every ${expectedMin} min`,
      `${Number(row.ratio).toFixed(1)}x scheduled headway`,
    ],
  };
}

function bunchingDetection(row) {
  const route = String(row.route);
  const outRoute = canonicalRoute(route);
  const mode = canonicalMode(modeForKind(row.kind), outRoute);
  const spanMi = row.severity_ft / 5280;
  const vehicleWord = mode === 'rail' ? 'trains' : mode === 'streetcar' ? 'streetcars' : 'buses';
  const description =
    mode === 'rail'
      ? `${titleCaseRoute(route)} Line ${row.vehicle_count} trains bunched`
      : mode === 'streetcar'
        ? `Streetcar ${row.vehicle_count} streetcars bunched`
        : `Route ${route} ${row.vehicle_count} buses bunched`;
  return {
    id: `marta-bunching-${row.id}`,
    source: 'bunching',
    kind: row.kind,
    mode,
    route: outRoute,
    direction: row.direction ?? null,
    near_stop: row.near_stop ?? null,
    ts: row.ts,
    resolved_ts: row.resolved_ts ?? null,
    post_url: atUriToUrl(row.post_uri),
    resolved_post_url: atUriToUrl(row.resolved_post_uri),
    description,
    evidence: {
      vehicle_count: row.vehicle_count,
      severity_ft: row.severity_ft,
    },
    bullets: [`${row.vehicle_count} ${vehicleWord} bunched`, `${spanMi.toFixed(2)} mi span`],
  };
}

function ghostDetection(row) {
  const route = String(row.route);
  const outRoute = canonicalRoute(route);
  const mode = canonicalMode(modeForKind(row.kind), outRoute);
  const missingPct =
    row.expected && row.expected > 0
      ? Math.round((Number(row.missing) / Number(row.expected)) * 100)
      : null;
  const description =
    mode === 'rail'
      ? `${titleCaseRoute(route)} Line missing trains`
      : mode === 'streetcar'
        ? 'Streetcar missing vehicles'
        : `Route ${route} missing buses`;
  const bullets = [`${Number(row.missing).toFixed(0)} missing`];
  if (missingPct != null) bullets.push(`${missingPct}% missing`);
  if (row.canceled_trips > 0) {
    bullets.push(`${row.canceled_trips} MARTA-canceled trip${row.canceled_trips === 1 ? '' : 's'}`);
  }
  return {
    id: `marta-ghost-${row.id}`,
    source: 'ghost',
    kind: row.kind,
    mode,
    route: outRoute,
    direction: row.direction ?? null,
    near_stop: null,
    ts: row.ts,
    resolved_ts: row.resolved_ts ?? null,
    post_url: atUriToUrl(row.post_uri),
    resolved_post_url: atUriToUrl(row.resolved_post_uri),
    description,
    evidence: {
      observed: row.observed,
      expected: row.expected,
      missing: row.missing,
      canceled_trips: row.canceled_trips ?? null,
      unexplained_missing: row.unexplained_missing ?? null,
    },
    bullets,
  };
}

// Incident-level cancellation status for a rail alert whose prose names a
// specific cancelled departure, else null. The MARTA analog of the CTA export's
// `statusBlock` — it carries the rider-facing label + the (server-computed)
// upcoming→cancelled state so the frontend stays a dumb renderer. `state` is
// derived here from `now` vs the parsed departure (no client-side clock math).
function cancellationStatus(alert, now) {
  const routes = canonicalRoutes(alert.routes);
  if (canonicalMode(alert.mode, routes) !== 'rail') return null;
  const c = classifyRailCancellation({
    headline: alert.headline,
    description: alert.description,
    line: routes[0] ?? null,
    anchorTs: alert.first_seen_ts,
  });
  if (!c) return null;
  const state = c.scheduledDepMs != null && c.scheduledDepMs > now ? 'upcoming' : 'cancelled';
  return {
    type: 'cancellation',
    state,
    scheduled_departure_ts: c.scheduledDepMs ?? null,
    origin: c.origin ?? null,
    line: c.line ?? null,
    title: c.title,
  };
}

function routeMatches(alert, det) {
  if (!alert.routes || alert.routes.length === 0) return true;
  const detRoute = normalizeRoute(det.route);
  return alert.routes.some((r) => normalizeRoute(r) === detRoute);
}

function modeMatches(alert, det) {
  const alertMode = canonicalMode(alert.mode, alert.routes);
  if (alertMode === 'general') return true;
  return alertMode === det.mode;
}

function timeMatches(alert, det) {
  if (Math.abs(det.ts - alert.first_seen_ts) > PAIR_BUFFER_MS) return false;
  const alertEnd = alert.resolved_ts ?? Number.POSITIVE_INFINITY;
  if (alertEnd + PAIR_GRACE_MS < det.ts) return false;
  return true;
}

function findMatches(alert, detections, usedIds) {
  return detections
    .filter((det) => {
      if (usedIds.has(det.id)) return false;
      if (!modeMatches(alert, det)) return false;
      if (!routeMatches(alert, det)) return false;
      return timeMatches(alert, det);
    })
    .sort((a, b) => Math.abs(a.ts - alert.first_seen_ts) - Math.abs(b.ts - alert.first_seen_ts));
}

function buildIncidentFromAlert(alert, matches, status = null) {
  const active = alert.resolved_ts == null || matches.some((det) => det.resolved_ts == null);
  const routeSet = new Set(canonicalRoutes(alert.routes));
  for (const det of matches) routeSet.add(det.route);
  const routes = [...routeSet];
  const firstSeen = Math.min(
    alert.first_seen_ts,
    ...matches.map((det) => det.ts).filter((ts) => ts != null),
  );
  const primaryPost = alert.post_url || matches[0]?.post_url || null;
  const incident = {
    id: postUrlRkey(primaryPost) ?? alert.alert_id,
    agency: 'marta',
    mode: canonicalMode(alert.mode, routes),
    routes,
    sources: matches.length > 0 ? ['marta', 'bot'] : ['marta'],
    lifecycle: lifecycleBlock({
      firstSeenTs: Number.isFinite(firstSeen) ? firstSeen : alert.first_seen_ts,
      resolvedTs: active ? null : alert.resolved_ts,
      active,
    }),
    official_alert: officialAlertBlock(alert),
    detections: matches.map(detectionBlock),
  };
  if (status) incident.status = status;
  return incident;
}

function rowsByAlertId(rows) {
  const out = new Map();
  for (const row of rows) {
    let list = out.get(row.alert_id);
    if (!list) {
      list = [];
      out.set(row.alert_id, list);
    }
    list.push({
      ts: row.ts,
      headline: row.headline ?? null,
      description: row.description ?? null,
      routes: parseRoutes(row.routes),
    });
  }
  return out;
}

function tableExists(db, tableName) {
  return (
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName)
      ?.ok === 1
  );
}

function columnExists(db, tableName, columnName) {
  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .some((row) => row.name === columnName);
}

function readAlerts(db) {
  if (!tableExists(db, 'alert_posts')) return [];
  // The station columns may be newer than the prod DB; ensure the migration has
  // run before the SELECT references them (no-op once applied).
  ensureAlertSchema();
  const rows = db
    .prepare(
      `SELECT alert_id, mode, routes, headline, description, cause, effect,
              active_start_ts, active_end_ts, first_seen_ts, last_seen_ts,
              post_uri, resolved_ts, resolved_reply_uri,
              affected_from_station, affected_to_station, mentioned_stations
       FROM alert_posts
       ORDER BY first_seen_ts DESC, alert_id ASC`,
    )
    .all();
  const versionRows = tableExists(db, 'alert_versions')
    ? db
        .prepare(
          `SELECT alert_id, ts, headline, description, routes
           FROM alert_versions
           ORDER BY alert_id, ts ASC, id ASC`,
        )
        .all()
    : [];
  const versions = rowsByAlertId(versionRows);
  return rows.map((row) => ({
    ...row,
    routes: parseRoutes(row.routes),
    post_url: atUriToUrl(row.post_uri),
    resolved_reply_url: atUriToUrl(row.resolved_reply_uri),
    versions: versions.get(row.alert_id) || [],
  }));
}

function readDetections(db) {
  if (!tableExists(db, 'gap_events')) return [];
  const ghostCanceledExpr = columnExists(db, 'ghost_events', 'canceled_trips')
    ? 'canceled_trips'
    : 'NULL AS canceled_trips';
  const ghostUnexplainedExpr = columnExists(db, 'ghost_events', 'unexplained_missing')
    ? 'unexplained_missing'
    : 'NULL AS unexplained_missing';
  const gaps = db
    .prepare(
      `SELECT id, ts, kind, route, direction, gap_ft, gap_min, expected_min,
              ratio, near_stop, post_uri, resolved_ts, resolved_post_uri
       FROM gap_events
       WHERE posted = 1 AND post_uri IS NOT NULL
       ORDER BY ts DESC, id DESC`,
    )
    .all()
    .map(gapDetection);
  const bunches = db
    .prepare(
      `SELECT id, ts, kind, route, direction, vehicle_count, severity_ft,
              near_stop, post_uri, resolved_ts, resolved_post_uri
       FROM bunching_events
       WHERE posted = 1 AND post_uri IS NOT NULL
       ORDER BY ts DESC, id DESC`,
    )
    .all()
    .map(bunchingDetection);
  const ghosts = db
    .prepare(
      `SELECT id, ts, kind, route, direction, observed, expected, missing,
              ${ghostCanceledExpr}, ${ghostUnexplainedExpr},
              post_uri, resolved_ts, resolved_post_uri
       FROM ghost_events
       WHERE post_uri IS NOT NULL
       ORDER BY ts DESC, id DESC`,
    )
    .all()
    .map(ghostDetection);
  return [...gaps, ...bunches, ...ghosts].sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id));
}

function readRoundups(db) {
  if (!tableExists(db, 'roundup_anchors')) return [];
  const rows = db
    .prepare(
      `SELECT id, kind, line, post_uri, ts, resolved_ts, resolution_post_uri, signals, bullets
       FROM roundup_anchors
       WHERE post_uri IS NOT NULL
       ORDER BY ts DESC, id DESC`,
    )
    .all();
  return rows.map(roundupDetection);
}

// Route-silence disruptions (thin-gap firings + pulse blackouts). Unlike a lone
// gap/bunch/ghost, these DO surface standalone — a fully-silent route produces
// no co-occurring signal to fold into a roundup, so they'd otherwise never reach
// the site. Each posted firing is paired with the earliest 'observed-clear' on
// the same line after it; absence of one means still-active. Mirrors CTA's
// export disruption_events('observed','observed-held','observed-thin') union.
const DISRUPTION_WEB_SOURCE = { 'observed-thin': 'thin-gap', observed: 'pulse-cold' };

function readDisruptions(db) {
  if (!tableExists(db, 'disruption_events')) return [];
  const rows = db
    .prepare(
      `SELECT d.id, d.kind, d.line, d.direction, d.source, d.ts, d.post_uri, d.evidence,
              (SELECT MIN(c.ts) FROM disruption_events c
                 WHERE c.kind = d.kind AND c.source = 'observed-clear'
                   AND c.line = d.line AND c.ts >= d.ts) AS resolved_ts
       FROM disruption_events d
       WHERE d.source IN ('observed-thin', 'observed')
         AND d.posted = 1 AND d.post_uri IS NOT NULL
       ORDER BY d.ts DESC, d.id DESC`,
    )
    .all();
  return rows.map(disruptionDetection);
}

function disruptionDetection(row) {
  const route = String(row.line);
  const outRoute = canonicalRoute(route);
  const mode = canonicalMode(modeForKind(row.kind), outRoute);
  const webSource = DISRUPTION_WEB_SOURCE[row.source] || 'thin-gap';
  let evidence = null;
  try {
    evidence = row.evidence ? JSON.parse(row.evidence) : null;
  } catch (_) {
    evidence = null;
  }
  const description =
    webSource === 'thin-gap'
      ? `Route ${route} thin-service gap`
      : `Route ${route} no buses running`;
  return {
    id: `marta-${webSource}-${row.id}`,
    source: webSource,
    kind: row.kind,
    mode,
    route: outRoute,
    direction: row.direction ?? null,
    near_stop: null,
    ts: row.ts,
    resolved_ts: row.resolved_ts ?? null,
    post_url: atUriToUrl(row.post_uri),
    resolved_post_url: null,
    description,
    evidence,
    bullets: [],
  };
}

function buildIncidentFromDisruption(det) {
  return {
    id: postUrlRkey(det.post_url) ?? det.id,
    agency: 'marta',
    mode: det.mode,
    routes: [canonicalRoute(det.route)],
    sources: ['bot'],
    lifecycle: lifecycleBlock({
      firstSeenTs: det.ts,
      resolvedTs: det.resolved_ts ?? null,
      active: det.resolved_ts == null,
    }),
    official_alert: null,
    detections: [detectionBlock(det)],
  };
}

function dataStart(alerts, detections, roundups = [], disruptions = []) {
  const times = [
    ...alerts.map((a) => a.first_seen_ts),
    ...detections.map((d) => d.ts),
    ...roundups.map((r) => r.ts),
    ...disruptions.map((d) => d.ts),
  ].filter((ts) => ts != null);
  return times.length > 0 ? Math.min(...times) : null;
}

function detectorMatchesRoundup(roundup, det) {
  if (roundup.id === det.id) return false;
  if (roundup.mode !== det.mode) return false;
  if (normalizeRoute(roundup.route) !== normalizeRoute(det.route)) return false;
  if (Math.abs(det.ts - roundup.ts) > PAIR_BUFFER_MS) return false;
  const roundupEnd = roundup.resolved_ts ?? Number.POSITIVE_INFINITY;
  if (roundupEnd + PAIR_GRACE_MS < det.ts) return false;
  return true;
}

function buildIncidentFromRoundup(roundup, matches) {
  // The roundup anchor owns the incident lifecycle, matching CTA: the anchor's
  // own clear-ticks resolution sweep (bin/marta/incident-roundup.js) decides when
  // service is back to normal. Paired gap/bunch/ghost detectors are evidence only
  // — their individual lifecycles must NOT gate the incident, or a single detector
  // that never reconciles would pin the event active long after the anchor cleared.
  const active = roundup.resolved_ts == null;
  const firstSeen = Math.min(
    roundup.ts,
    ...matches.map((det) => det.ts).filter((ts) => ts != null),
  );
  const resolved = active ? null : roundup.resolved_ts;
  return {
    id: postUrlRkey(roundup.post_url) ?? roundup.id,
    agency: 'marta',
    mode: roundup.mode,
    routes: [canonicalRoute(roundup.route)],
    sources: ['bot'],
    lifecycle: lifecycleBlock({
      firstSeenTs: Number.isFinite(firstSeen) ? firstSeen : roundup.ts,
      resolvedTs: resolved || null,
      active,
    }),
    official_alert: null,
    detections: [detectionBlock(roundup), ...matches.map(detectionBlock)],
  };
}

function buildIncidents(alerts, detections, roundups = [], disruptions = [], now = Date.now()) {
  const usedDetections = new Set();
  const incidents = [];
  for (const alert of alerts) {
    const status = cancellationStatus(alert, now);
    // A single-departure cancellation is a point-in-time fact, not an open
    // disruption — it must NOT absorb unrelated same-line gap/bunch/ghost
    // detections that merely fall in the time window (mirrors the CTA export's
    // planned-Metra merge guard). Leave it a marta-only incident.
    const matches =
      status?.type === 'cancellation' ? [] : findMatches(alert, detections, usedDetections);
    for (const det of matches) usedDetections.add(det.id);
    incidents.push(buildIncidentFromAlert(alert, matches, status));
  }
  for (const roundup of roundups) {
    const matches = detections
      .filter((det) => !usedDetections.has(det.id) && detectorMatchesRoundup(roundup, det))
      .sort((a, b) => Math.abs(a.ts - roundup.ts) - Math.abs(b.ts - roundup.ts));
    for (const det of matches) usedDetections.add(det.id);
    incidents.push(buildIncidentFromRoundup(roundup, matches));
  }
  // Route-silence disruptions stand alone (see readDisruptions) — they have no
  // co-occurring signal to pair into a roundup or alert.
  for (const det of disruptions) {
    incidents.push(buildIncidentFromDisruption(det));
  }
  // Unpaired single detectors do NOT become their own incidents — matching CTA,
  // where website events come only from official alerts and multi-signal
  // roundups. A lone gap/bunch/ghost still posts to Bluesky from the insights
  // account, but it only surfaces on the site as evidence once it's folded into
  // a roundup or an official alert above. This is what keeps a single detector
  // from spawning a standalone event page.
  incidents.sort(
    (a, b) =>
      (b.lifecycle.first_seen_ts ?? 0) - (a.lifecycle.first_seen_ts ?? 0) ||
      String(a.id).localeCompare(String(b.id)),
  );
  return incidents;
}

function buildExport(db, now = Date.now()) {
  const alerts = readAlerts(db);
  const detections = readDetections(db);
  const roundups = readRoundups(db);
  const disruptions = readDisruptions(db);
  return {
    schema_version: 2,
    generated_at: now,
    data_start_ts: dataStart(alerts, detections, roundups, disruptions),
    incidents: buildIncidents(alerts, detections, roundups, disruptions, now),
  };
}

function writeOutput(out, outputPath) {
  if (!outputPath) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  Fs.mkdirSync(Path.dirname(outputPath), { recursive: true });
  const dataOnly = JSON.stringify({
    data_start_ts: out.data_start_ts,
    schema_version: out.schema_version,
    incidents: out.incidents,
  });
  let existingDataOnly = null;
  if (Fs.existsSync(outputPath)) {
    try {
      const existing = JSON.parse(Fs.readFileSync(outputPath, 'utf8'));
      existingDataOnly = JSON.stringify({
        data_start_ts: existing.data_start_ts,
        schema_version: existing.schema_version,
        incidents: existing.incidents,
      });
    } catch (_) {}
  }
  if (dataOnly === existingDataOnly) {
    console.error('marta export-web: no data changes, skipping write');
    return;
  }
  Fs.writeFileSync(outputPath, `${JSON.stringify(out)}\n`, 'utf8');
  console.error(`marta export-web: wrote ${out.incidents.length} incidents to ${outputPath}`);
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    writeOutput(buildExport(db), process.argv[2]);
  } finally {
    db.close();
  }
}

if (require.main === module) main();

module.exports = {
  atUriToUrl,
  buildExport,
  buildIncidents,
  postUrlRkey,
};
