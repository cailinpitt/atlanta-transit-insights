#!/usr/bin/env node
// Export MARTA official alerts + bot detections as schema-v2 incidents for the
// public web data payload.

require('../../src/shared/env');

const Fs = require('node:fs');
const Path = require('node:path');
const Database = require('better-sqlite3');
const { canonicalMode, canonicalRoute, routeMatchKey } = require('../../src/marta/routeKeys');
const {
  describeBotObservation,
  describeBotResolution,
  describeBotOnset,
  describeBotEvidenceBullets,
} = require('../../src/shared/observationDescribe');
const { classifyRailCancellation } = require('../../src/marta/alert/cancellation');
const { ensureSchema: ensureAlertSchema } = require('../../src/marta/alert/store');
const { buildAlertDisplayName, alertNature } = require('../../src/marta/alert/displayName');
const { alertsChainable } = require('../../src/marta/alert/chain');

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

// Absence-style sources whose start we back-date: a cold stretch / thin-service
// gap was already happening for some minutes before we posted. Mirrors CTA's
// onset back-dating (other sources start at their post ts).
const COLD_ONSET_SOURCES = new Set(['pulse-cold', 'thin-gap']);

// Minutes-since-last-vehicle to back-date by, from a cold-source evidence object
// (rail pulse carries minutesSinceLastTrain / coldThresholdMin). Null otherwise.
function coldBackdateMin(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  const m = evidence.minutesSinceLastTrain ?? evidence.coldThresholdMin ?? null;
  return typeof m === 'number' && Number.isFinite(m) ? m : null;
}

// Back-dated onset for a disruption row, or null when its source/evidence gives
// no earlier start (consumers then fall back to the post ts).
function onsetTsForDisruption(webSource, evidence, ts) {
  if (!COLD_ONSET_SOURCES.has(webSource)) return null;
  const min = coldBackdateMin(evidence);
  return min != null ? ts - min * 60_000 : null;
}

// Back-dated onset for a roundup, taken from the earliest-starting cold-source
// bullet it bundles (max minutes-since-last). Null when no cold signal — most
// MARTA roundups (gap/bunch/ghost) have none, and start at their post ts.
function onsetTsFromBullets(rawBullets, ts) {
  let backdateMin = null;
  for (const b of rawBullets || []) {
    if (!COLD_ONSET_SOURCES.has(b?.source)) continue;
    const m = coldBackdateMin(b?.detail);
    if (m != null && (backdateMin == null || m > backdateMin)) backdateMin = m;
  }
  return backdateMin != null ? ts - backdateMin * 60_000 : null;
}

function canonicalRoutes(routes) {
  return (routes || []).map(canonicalRoute);
}

function lifecycleBlock({ firstSeenTs, onsetTs = null, resolvedTs, active, durationMs }) {
  // duration reconciles with the published start: resolved - (onset ?? first_seen),
  // so a consumer subtracting the displayed start gets the same number.
  const startTs = onsetTs ?? firstSeenTs;
  return {
    first_seen_ts: firstSeenTs ?? null,
    onset_ts: onsetTs ?? null,
    resolved_ts: resolvedTs ?? null,
    active,
    duration_ms:
      durationMs ??
      (resolvedTs != null && startTs != null ? Math.max(0, resolvedTs - startTs) : null),
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

// Synthesize the scannable display title for an official alert (or one of its
// text versions) from the affected routes + the nature of the disruption. The
// generic MARTA header ("Rail Service Alert for Green Line") is replaced by this
// for the event title; MARTA's verbatim prose is preserved in `description`. The
// affected station segment is NOT folded in here — the website renders it as a
// separate "from → to" subtitle from `scope`.
function displayHeadline(alert, mode, routes, { header, description } = {}) {
  return buildAlertDisplayName({
    header: header ?? alert.headline ?? null,
    description: description ?? alert.description ?? null,
    mode,
    routes,
    effect: alert.effect ?? null,
  });
}

function officialAlertBlock(alert) {
  const routes = canonicalRoutes(alert.routes);
  const mode = canonicalMode(alert.mode, routes);
  const block = {
    id: alert.alert_id,
    mode,
    routes,
    headline: displayHeadline(alert, mode, routes),
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
  // Rewrite each text version's headline through the same synthesizer so the
  // website's "stable first-version headline" title is the descriptive name too
  // (not the raw MARTA header). The version's own routes/text drive it, falling
  // back to the alert's mode/routes/effect; `description` is left untouched so
  // the "Per MARTA" timeline still shows MARTA's verbatim prose.
  if (alert.versions?.length > 1) {
    block.versions = alert.versions.map((v) => {
      const vRoutes = v.routes != null ? canonicalRoutes(parseRoutes(v.routes)) : routes;
      return {
        ...v,
        headline: displayHeadline(alert, mode, vRoutes.length ? vRoutes : routes, {
          header: v.headline,
          description: v.description,
        }),
      };
    });
  }
  return block;
}

function detectionScope(det) {
  return {
    route: canonicalRoute(det.route),
    direction: det.direction ?? null,
    // Pre-computed rider-facing direction ("northbound") for the renderer; null
    // when the detection carries no usable direction.
    direction_label: det.direction_label ?? null,
    // Cold-stretch endpoints + every roster stop inside the run (raw
    // rail-stations.json names, which the website resolves to /station/:slug).
    // Null/[] for whole-route bus silences and roundups. Mirrors CTA's
    // detection scope shape so the event map highlights the affected segment.
    from_station: det.from_station ?? null,
    to_station: det.to_station ?? null,
    stations: det.stations ?? [],
  };
}

function detectionBlock(det) {
  return {
    id: det.id,
    source: det.source,
    scope: detectionScope(det),
    lifecycle: lifecycleBlock({
      firstSeenTs: det.ts,
      onsetTs: det.onset_ts ?? null,
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
      // Pre-rendered timeline sentences for absence-style detections (cold
      // stretches): the back-dated onset entry and the resolution line. Null
      // for detections that have none, matching CTA's evidence shape.
      onset_description: det.onset_description ?? null,
      resolved_description: det.resolved_description ?? null,
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
    onset_ts: onsetTsFromBullets(rawBullets, row.ts),
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

// True when a set of detection records includes a headway gap — a felt delay.
// Accepts raw detector records (with `.source`) and/or built detection blocks (a
// roundup block carries its sub-signals in `.evidence.signals`). Bunching,
// ghost, thin-gap, and pulse are deliberately NOT treated as delays.
function recordsIncludeGap(records) {
  for (const d of records || []) {
    if (d?.source === 'gap') return true;
    const sigs = d?.evidence?.signals;
    if (Array.isArray(sigs) && sigs.includes('gap')) return true;
  }
  return false;
}

// True when an official alert's nature is "delays" — reuses the display-name
// synthesizer's classification (SIGNIFICANT_DELAYS effect or "delay" wording),
// so a more-specific nature like detour / partial-service correctly does NOT
// count as a delay even if the prose mentions delays in passing.
function alertReportsDelay(alert) {
  return (
    alertNature({
      header: alert.headline,
      description: alert.description,
      effect: alert.effect,
      mode: canonicalMode(alert.mode, canonicalRoutes(alert.routes)),
    }) === 'delays'
  );
}

// True when an official alert's nature is a route detour — reuses the display-
// name synthesizer's classification (DETOUR effect or detour/reroute/bypass
// wording), the same source the bus display names draw on, so the status and
// the rendered name never disagree.
function alertReportsDetour(alert) {
  return (
    alertNature({
      header: alert.headline,
      description: alert.description,
      effect: alert.effect,
      mode: canonicalMode(alert.mode, canonicalRoutes(alert.routes)),
    }) === 'detour'
  );
}

// Incident-level "detour" status — the producer-classified signal the website
// reads to show its blue "Detour" badge and lift the incident into the
// homepage's collapsed "Detours" band. MARTA posts these in bulk, so pulling
// them out of the live disruptions keeps the homepage legible. Set only from an
// official alert's nature (bot detections never carry detour semantics); null
// otherwise. A cancellation status (terminal) takes precedence and is set by
// the caller, which also prefers a detour over a delay.
function detourStatus({ alert = null }) {
  if (alert && alertReportsDetour(alert)) return { type: 'detour' };
  return null;
}

// Incident-level "delays" status — the producer-classified signal the website
// reads to show its amber "Delays" badge (the MARTA analog of CTA's Metra delay
// status). Set when an official alert reports delays OR a bot headway gap is
// present; null otherwise. A cancellation status (terminal) takes precedence and
// is set separately by the caller.
function delayStatus({ alert = null, records = [] }) {
  if ((alert && alertReportsDelay(alert)) || recordsIncludeGap(records)) {
    return { type: 'delay' };
  }
  return null;
}

function routeMatches(alert, det) {
  // An alert with no scoped routes (agency-wide / general notice) matches NO bot
  // obs — mirrors CTA's `alert.routes.includes(obs.line)`. Otherwise a single
  // system-wide alert would vacuum up every roundup/disruption in the window
  // across all lines. Unscoped bot incidents stand alone instead.
  if (!alert.routes || alert.routes.length === 0) return false;
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
  // Interval-overlap guard (mirrors CTA's buildIncidents): a detection whose own
  // interval ENDED before the alert began can't merge on proximity alone — this
  // is what stops a bunch that cleared two hours earlier from attaching to a
  // later official alert.
  const detEnd = det.resolved_ts ?? det.ts;
  if (detEnd + PAIR_GRACE_MS < alert.first_seen_ts) return false;
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

// Detection blocks for one matched observation. A roundup expands into its own
// block plus its interval-guarded raw-detector evidence (so the website still
// shows the underlying gap/bunch/ghost signals it bundles); a disruption is a
// single block. Mirrors how buildIncidentFromRoundup lays out [anchor, …evidence].
function obsDetectionBlocks(obs, roundupEvidence) {
  if (obs.source === 'roundup') {
    const evidence = roundupEvidence.get(obs.id) || [];
    return [detectionBlock(obs), ...evidence.map(detectionBlock)];
  }
  return [detectionBlock(obs)];
}

function buildIncidentFromAlert(alert, matches, status = null, roundupEvidence = new Map()) {
  const active = alert.resolved_ts == null || matches.some((det) => det.resolved_ts == null);
  // Union routes from the alert's current value AND every text version's routes
  // (alert_posts.routes is overwritten last-write-wins, so a multi-line alert
  // narrowed before resolving would otherwise drop the dropped lines) plus the
  // matched detector lines. Mirrors CTA's incident-route re-derivation.
  const routeSet = new Set(canonicalRoutes(alert.routes));
  for (const v of alert.versions || []) {
    for (const r of canonicalRoutes(v.routes || [])) routeSet.add(r);
  }
  for (const det of matches) routeSet.add(det.route);
  const routes = [...routeSet];
  // Incident onset prefers a paired bot detection's back-dated onset — a
  // pulse/thin-gap can catch a problem before MARTA posts, and the incident's
  // "first seen" should reflect that lead (mirrors CTA's earliestObs). onset_ts
  // falls back to the detection's post ts.
  const firstSeen = Math.min(
    alert.first_seen_ts,
    ...matches.map((det) => det.onset_ts ?? det.ts).filter((ts) => ts != null),
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
      // While active, report no resolution. Once inactive, fall back to a paired
      // obs's resolution if the alert itself carries none (CTA parity).
      resolvedTs: active ? null : (alert.resolved_ts ?? matches[0]?.resolved_ts ?? null),
      active,
    }),
    official_alert: officialAlertBlock(alert),
    detections: matches.flatMap((m) => obsDetectionBlocks(m, roundupEvidence)),
  };
  if (status) incident.status = status;
  // Internal-only: the alert's last feed sighting, used by consolidateAlertChains
  // to bound how long an unresolved alert can absorb follow-ups. Stripped before
  // the payload is written (see consolidateAlertChains).
  incident._last_seen_ts = alert.last_seen_ts ?? null;
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
const DISRUPTION_WEB_SOURCE = {
  'observed-thin': 'thin-gap',
  observed: 'pulse-cold',
  'observed-held': 'pulse-held',
};

// Rider-facing label for a rail feed direction. MARTA collapses each line to two
// cardinal feed directions (RED/GOLD N/S, BLUE/GREEN E/W); the website renders
// this beside the affected segment ("Oakland City → College Park (northbound)").
// Lowercase to match the documented data shape. Null for anything unexpected.
function railDirectionLabel(direction) {
  switch (direction) {
    case 'N':
      return 'northbound';
    case 'S':
      return 'southbound';
    case 'E':
      return 'eastbound';
    case 'W':
      return 'westbound';
    default:
      return null;
  }
}

function readDisruptions(db) {
  if (!tableExists(db, 'disruption_events')) return [];
  const rows = db
    .prepare(
      `SELECT d.id, d.kind, d.line, d.direction, d.source, d.ts, d.post_uri, d.evidence,
              (SELECT MIN(c.ts) FROM disruption_events c
                 WHERE c.kind = d.kind AND c.source = 'observed-clear'
                   AND c.line = d.line AND c.ts >= d.ts) AS resolved_ts
       FROM disruption_events d
       WHERE d.source IN ('observed-thin', 'observed', 'observed-held')
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

  let description;
  let fromStation = null;
  let toStation = null;
  let stations = [];
  let directionLabel = null;
  let bullets = [];
  let onsetDescription = null;
  let resolvedDescription = null;

  if (row.kind === 'rail') {
    // Mirror CTA's pulse export so the two sites render cold sections
    // identically: pre-render every rider-facing sentence through the shared
    // describe* helpers (keeping the web app a dumb renderer), and expose the
    // cold stretch's endpoints + full station list so the event map highlights
    // the affected segment and the page title reads "from → to (direction)".
    const describeShape = {
      kind: 'train',
      // Canonical lowercase line key the describe helpers resolve to a label
      // (the detector stores it SCREAMING, e.g. "RED").
      line: outRoute,
      detection_source: webSource,
      signals: [webSource],
      evidence,
    };
    description = describeBotObservation(describeShape);
    onsetDescription = describeBotOnset(describeShape);
    resolvedDescription = row.resolved_ts != null ? describeBotResolution(describeShape) : null;
    bullets = describeBotEvidenceBullets(describeShape) ?? [];
    // A synthetic (whole-line) cold has no single stretch to map; only segment
    // pulses carry concrete endpoints. evidence.from/to/coldStationNames are
    // raw rail-stations.json names ("OAKLAND CITY Station"), which the website
    // resolves to /station/:slug — pass them through unchanged.
    if (!evidence?.synthetic) {
      fromStation = evidence?.from ?? null;
      toStation = evidence?.to ?? null;
      stations = Array.isArray(evidence?.coldStationNames) ? evidence.coldStationNames : [];
      directionLabel = railDirectionLabel(row.direction);
    }
  } else {
    description =
      webSource === 'thin-gap'
        ? `Route ${route} thin-service gap`
        : `Route ${route} no buses running`;
  }

  return {
    id: `marta-${webSource}-${row.id}`,
    source: webSource,
    kind: row.kind,
    mode,
    route: outRoute,
    direction: row.direction ?? null,
    direction_label: directionLabel,
    from_station: fromStation,
    to_station: toStation,
    stations,
    ts: row.ts,
    onset_ts: onsetTsForDisruption(webSource, evidence, row.ts),
    resolved_ts: row.resolved_ts ?? null,
    post_url: atUriToUrl(row.post_uri),
    resolved_post_url: null,
    description,
    onset_description: onsetDescription,
    resolved_description: resolvedDescription,
    evidence,
    bullets,
  };
}

function buildIncidentFromDisruption(det) {
  // A single Bluesky rollup post can list several routes (thin-gaps / pulse
  // bundle every silent route into one thread). Each route records its own
  // disruption row pointing at that shared post_uri, so keying the incident id
  // on the post rkey alone collides — co-posted routes would share one event
  // page and all but the first would be unreachable. Suffix the canonical route
  // so each route gets a stable, distinct, shareable id.
  const rkey = postUrlRkey(det.post_url);
  const outRoute = canonicalRoute(det.route);
  return {
    id: rkey ? `${rkey}-${outRoute}` : det.id,
    agency: 'marta',
    mode: det.mode,
    routes: [outRoute],
    sources: ['bot'],
    lifecycle: lifecycleBlock({
      firstSeenTs: det.ts,
      onsetTs: det.onset_ts ?? null,
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
  // Same interval-overlap guard as timeMatches: a detector that cleared before
  // the roundup anchor's tick isn't evidence for it.
  const detEnd = det.resolved_ts ?? det.ts;
  if (detEnd + PAIR_GRACE_MS < roundup.ts) return false;
  return true;
}

function buildIncidentFromRoundup(roundup, matches, status = null) {
  // The roundup anchor owns the incident lifecycle, matching CTA: the anchor's
  // own clear-ticks resolution sweep (bin/marta/incident-roundup.js) decides when
  // service is back to normal. Paired gap/bunch/ghost detectors are evidence only
  // — their individual lifecycles must NOT gate the incident, or a single detector
  // that never reconciles would pin the event active long after the anchor cleared.
  const active = roundup.resolved_ts == null;
  // first_seen tracks post time (matching how bot incidents sort/filter); the
  // back-dated start is carried separately as onset_ts (CTA's bot-only model).
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
      onsetTs: roundup.onset_ts ?? null,
      resolvedTs: resolved || null,
      active,
    }),
    official_alert: null,
    detections: [detectionBlock(roundup), ...matches.map(detectionBlock)],
    ...(status ? { status } : {}),
  };
}

// Merge several incidents' lifecycles into one spanning block: earliest onset,
// latest resolution, active if any member is still active. Mirrors CTA's
// mergeLifecycle (cta-insights/bin/export-web.js).
function mergeLifecycle(lifecycles) {
  const firstSeen = Math.min(...lifecycles.map((l) => l?.first_seen_ts).filter((ts) => ts != null));
  const active = lifecycles.some((l) => l?.active);
  const resolvedValues = lifecycles.map((l) => l?.resolved_ts).filter((ts) => ts != null);
  const resolvedTs = active || resolvedValues.length === 0 ? null : Math.max(...resolvedValues);
  return lifecycleBlock({
    firstSeenTs: Number.isFinite(firstSeen) ? firstSeen : null,
    resolvedTs,
    active,
  });
}

// An incident eligible to chain: it carries an official alert and is not a
// terminal single-departure cancellation (those are point-in-time facts that
// must not swallow a neighbouring delay — same spirit as the planned-Metra
// guard).
function chainableIncident(inc) {
  return !!inc.official_alert && inc.status?.type !== 'cancellation';
}

// The minimal shape alertsChainable() reads, pulled from a built incident.
function chainKey(inc) {
  return {
    mode: inc.official_alert.mode,
    routes: inc.official_alert.routes,
    first_seen_ts: inc.lifecycle.first_seen_ts,
    resolved_ts: inc.lifecycle.resolved_ts ?? null,
    last_seen_ts: inc._last_seen_ts ?? null,
  };
}

// Collapse MARTA's churned official-alert entities into one incident. MARTA's
// OTP backend posts each update as a fresh alert_id ("Streetcar delays" →
// "Update: resumed normal schedule"), so one disruption arrives as several
// alert_posts → several incidents. Group same-mode/overlapping-route official
// incidents whose onsets chain within CHAIN_WINDOW_MS (transitively) into one
// incident with `official_alert` = earliest + `official_alerts` = the chain. The
// frontend already renders official_alerts[] and aliases every member's post
// rkey, so old shared URLs keep resolving. Modeled on CTA's
// consolidateMetraPlannedWorkIncidents.
function consolidateAlertChains(incidents) {
  const candidates = [];
  const passthrough = [];
  for (const inc of incidents) {
    (chainableIncident(inc) ? candidates : passthrough).push(inc);
  }
  // Ascending by onset so a group's last member is always its latest; link each
  // candidate onto the first existing group whose tail it continues.
  candidates.sort((a, b) => (a.lifecycle.first_seen_ts ?? 0) - (b.lifecycle.first_seen_ts ?? 0));
  const groups = [];
  for (const inc of candidates) {
    let placed = false;
    for (const g of groups) {
      if (alertsChainable(chainKey(g[g.length - 1]), chainKey(inc))) {
        g.push(inc);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([inc]);
  }

  const out = [...passthrough];
  for (const group of groups) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const primary = group[0]; // earliest onset
    const officialAlerts = group
      .map((inc) => inc.official_alert)
      .filter(Boolean)
      .sort(
        (a, b) =>
          (a.lifecycle?.first_seen_ts ?? Number.MAX_SAFE_INTEGER) -
            (b.lifecycle?.first_seen_ts ?? Number.MAX_SAFE_INTEGER) ||
          String(a.id).localeCompare(String(b.id)),
      );
    out.push({
      ...primary,
      id: primary.id,
      routes: [...new Set(group.flatMap((inc) => inc.routes || []))],
      sources: [...new Set(group.flatMap((inc) => inc.sources || []))],
      lifecycle: mergeLifecycle(group.map((inc) => inc.lifecycle)),
      official_alert: primary.official_alert,
      official_alerts: officialAlerts,
      detections: group.flatMap((inc) => inc.detections || []),
      // status carried from `...primary` (the earliest "delays" entity), which
      // is the right incident-level classification for the whole chain.
    });
  }
  out.sort(
    (a, b) =>
      (b.lifecycle.first_seen_ts ?? 0) - (a.lifecycle.first_seen_ts ?? 0) ||
      String(a.id).localeCompare(String(b.id)),
  );
  // Drop the internal chaining helper so it never reaches the published payload.
  for (const inc of out) delete inc._last_seen_ts;
  return out;
}

function buildIncidents(alerts, detections, roundups = [], disruptions = [], now = Date.now()) {
  // Raw single detectors (gap/bunch/ghost) are NEVER standalone incidents and
  // NEVER attach directly to an official alert — matching CTA, whose alert
  // pairing pool is roundups + route-silence disruptions only. First fold each
  // raw detector into the roundup it corroborates (interval-guarded). These
  // become the roundup's evidence and ride along wherever that roundup lands
  // (standalone, or merged into an alert).
  const usedDetections = new Set();
  const roundupEvidence = new Map();
  for (const roundup of roundups) {
    const evidence = detections
      .filter((det) => !usedDetections.has(det.id) && detectorMatchesRoundup(roundup, det))
      .sort((a, b) => Math.abs(a.ts - roundup.ts) - Math.abs(b.ts - roundup.ts));
    for (const det of evidence) usedDetections.add(det.id);
    roundupEvidence.set(roundup.id, evidence);
  }

  // The pool an official alert pairs against: roundups + disruptions (NOT raw
  // detectors). A matched observation MERGES into the alert incident; leftovers
  // stand alone below. A lone gap/bunch/ghost with no roundup can no longer
  // attach to an alert — exactly the stale-bunch bug this fixes.
  const observations = [...roundups, ...disruptions];
  const usedObs = new Set();
  const incidents = [];

  for (const alert of alerts) {
    const cancellation = cancellationStatus(alert, now);
    // A single-departure cancellation is a point-in-time fact, not an open
    // disruption — it must NOT absorb same-line bot observations that merely
    // fall in the window (mirrors the CTA export's planned-Metra merge guard).
    // Leave it a marta-only incident.
    const matches =
      cancellation?.type === 'cancellation' ? [] : findMatches(alert, observations, usedObs);
    for (const obs of matches) usedObs.add(obs.id);
    // Cancellation (terminal) wins; then a detour (more specific than delays);
    // otherwise classify a "delays" status from the alert's nature or a paired
    // bot gap.
    const status =
      cancellation ?? detourStatus({ alert }) ?? delayStatus({ alert, records: matches });
    incidents.push(buildIncidentFromAlert(alert, matches, status, roundupEvidence));
  }

  // Roundups not absorbed by an alert stand alone, carrying their evidence.
  for (const roundup of roundups) {
    if (usedObs.has(roundup.id)) continue;
    const evidence = roundupEvidence.get(roundup.id) || [];
    // A roundup is a "delays" incident when its own signals or any evidence
    // detector include a headway gap.
    const status = delayStatus({ records: [roundup, ...evidence] });
    incidents.push(buildIncidentFromRoundup(roundup, evidence, status));
  }
  // Route-silence disruptions not absorbed by an alert stand alone — they have
  // no co-occurring signal to fold into a roundup.
  for (const det of disruptions) {
    if (usedObs.has(det.id)) continue;
    incidents.push(buildIncidentFromDisruption(det));
  }
  incidents.sort(
    (a, b) =>
      (b.lifecycle.first_seen_ts ?? 0) - (a.lifecycle.first_seen_ts ?? 0) ||
      String(a.id).localeCompare(String(b.id)),
  );
  // Collapse MARTA's churned official-alert entities (delay → "Update: cleared"
  // → "all clear", each a fresh alert_id) into ONE incident with official_alerts[].
  return consolidateAlertChains(incidents);
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
  // Wait for a concurrent writer's lock rather than failing the export outright
  // (matches the writer connection in src/marta/storage.js). Without this a
  // heavy export read during a write could throw "database is locked" and leave
  // the site frozen on the last good alerts.json.
  db.pragma('busy_timeout = 15000');
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
  consolidateAlertChains,
  postUrlRkey,
};
