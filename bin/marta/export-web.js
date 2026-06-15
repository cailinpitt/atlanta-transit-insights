#!/usr/bin/env node
// Export MARTA official alerts + bot detections as schema-v2 incidents for the
// public web data payload.

require('../../src/shared/env');

const Fs = require('node:fs');
const Path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH =
  process.env.MARTA_HISTORY_DB_PATH || Path.join(__dirname, '..', '..', 'state', 'marta.sqlite');

const PAIR_BUFFER_MS = 2 * 60 * 60 * 1000;
const PAIR_GRACE_MS = 10 * 60 * 1000;
const DETECTION_ACTIVE_MS = {
  gap: 45 * 60 * 1000,
  bunching: 45 * 60 * 1000,
  ghost: 90 * 60 * 1000,
};

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
  return String(route || '')
    .trim()
    .toUpperCase();
}

function titleCaseRoute(route) {
  const s = String(route || '').trim();
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function modeForKind(kind) {
  return kind === 'rail' ? 'rail' : kind;
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

function officialScope(alert) {
  return {
    routes: alert.routes,
    agency_wide: alert.routes.length === 0,
  };
}

function officialAlertBlock(alert) {
  const block = {
    id: alert.alert_id,
    mode: alert.mode,
    routes: alert.routes,
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
    route: det.route,
    direction: det.direction ?? null,
    near_stop: det.near_stop ?? null,
  };
}

function detectionActiveWindowMs(det) {
  return DETECTION_ACTIVE_MS[det.source] ?? 60 * 60 * 1000;
}

function detectionLifecycle(det, now) {
  const resolvedTs = det.ts + detectionActiveWindowMs(det);
  const active = now < resolvedTs;
  return lifecycleBlock({
    firstSeenTs: det.ts,
    resolvedTs: active ? null : resolvedTs,
    active,
  });
}

function latestResolvedTs(values) {
  const nums = values.filter((v) => v != null && Number.isFinite(v));
  return nums.length > 0 ? Math.max(...nums) : null;
}

function detectionBlock(det, now) {
  return {
    id: det.id,
    source: det.source,
    scope: detectionScope(det),
    lifecycle: detectionLifecycle(det, now),
    post_url: det.post_url,
    description: det.description,
    evidence: {
      details: det.evidence,
      signals: [det.source],
      bullets: det.bullets,
    },
  };
}

function gapDetection(row) {
  const route = String(row.route);
  const gapMin = Math.round(row.gap_min);
  const expectedMin = Math.round(row.expected_min);
  const description =
    row.kind === 'rail'
      ? `${titleCaseRoute(route)} Line ${gapMin} min gap`
      : `Route ${route} ${gapMin} min gap`;
  return {
    id: `marta-gap-${row.id}`,
    source: 'gap',
    kind: row.kind,
    mode: modeForKind(row.kind),
    route,
    direction: row.direction ?? null,
    near_stop: row.near_stop ?? null,
    ts: row.ts,
    post_url: atUriToUrl(row.post_uri),
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
  const spanMi = row.severity_ft / 5280;
  const vehicleWord = row.kind === 'rail' ? 'trains' : 'buses';
  const description =
    row.kind === 'rail'
      ? `${titleCaseRoute(route)} Line ${row.vehicle_count} trains bunched`
      : `Route ${route} ${row.vehicle_count} buses bunched`;
  return {
    id: `marta-bunching-${row.id}`,
    source: 'bunching',
    kind: row.kind,
    mode: modeForKind(row.kind),
    route,
    direction: row.direction ?? null,
    near_stop: row.near_stop ?? null,
    ts: row.ts,
    post_url: atUriToUrl(row.post_uri),
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
  const missingPct =
    row.expected && row.expected > 0
      ? Math.round((Number(row.missing) / Number(row.expected)) * 100)
      : null;
  const description =
    row.kind === 'rail'
      ? `${titleCaseRoute(route)} Line missing trains`
      : `Route ${route} missing buses`;
  const bullets = [`${Number(row.missing).toFixed(0)} missing`];
  if (missingPct != null) bullets.push(`${missingPct}% missing`);
  return {
    id: `marta-ghost-${row.id}`,
    source: 'ghost',
    kind: row.kind,
    mode: modeForKind(row.kind),
    route,
    direction: row.direction ?? null,
    near_stop: null,
    ts: row.ts,
    post_url: atUriToUrl(row.post_uri),
    description,
    evidence: {
      observed: row.observed,
      expected: row.expected,
      missing: row.missing,
    },
    bullets,
  };
}

function routeMatches(alert, det) {
  if (!alert.routes || alert.routes.length === 0) return true;
  const detRoute = normalizeRoute(det.route);
  return alert.routes.some((r) => normalizeRoute(r) === detRoute);
}

function modeMatches(alert, det) {
  if (alert.mode === 'general') return true;
  return alert.mode === det.mode;
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

function buildIncidentFromAlert(alert, matches, now) {
  const detectionLifecycles = matches.map((det) => detectionLifecycle(det, now));
  const active =
    alert.resolved_ts == null || detectionLifecycles.some((lifecycle) => lifecycle.active);
  const routeSet = new Set(alert.routes);
  for (const det of matches) routeSet.add(det.route);
  const routes = [...routeSet];
  const firstSeen = Math.min(
    alert.first_seen_ts,
    ...matches.map((det) => det.ts).filter((ts) => ts != null),
  );
  const primaryPost = alert.post_url || matches[0]?.post_url || null;
  return {
    id: postUrlRkey(primaryPost) ?? alert.alert_id,
    agency: 'marta',
    mode: alert.mode,
    routes,
    sources: matches.length > 0 ? ['marta', 'bot'] : ['marta'],
    lifecycle: lifecycleBlock({
      firstSeenTs: Number.isFinite(firstSeen) ? firstSeen : alert.first_seen_ts,
      resolvedTs: active
        ? null
        : latestResolvedTs([alert.resolved_ts, ...detectionLifecycles.map((l) => l.resolved_ts)]),
      active,
    }),
    official_alert: officialAlertBlock(alert),
    detections: matches.map((det) => detectionBlock(det, now)),
  };
}

function buildIncidentFromDetection(det, now) {
  return {
    id: postUrlRkey(det.post_url) ?? det.id,
    agency: 'marta',
    mode: det.mode,
    routes: [det.route],
    sources: ['bot'],
    lifecycle: detectionLifecycle(det, now),
    official_alert: null,
    detections: [detectionBlock(det, now)],
  };
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

function readAlerts(db) {
  if (!tableExists(db, 'alert_posts')) return [];
  const rows = db
    .prepare(
      `SELECT alert_id, mode, routes, headline, description, cause, effect,
              active_start_ts, active_end_ts, first_seen_ts, last_seen_ts,
              post_uri, resolved_ts, resolved_reply_uri
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
  const gaps = db
    .prepare(
      `SELECT id, ts, kind, route, direction, gap_ft, gap_min, expected_min,
              ratio, near_stop, post_uri
       FROM gap_events
       WHERE posted = 1 AND post_uri IS NOT NULL
       ORDER BY ts DESC, id DESC`,
    )
    .all()
    .map(gapDetection);
  const bunches = db
    .prepare(
      `SELECT id, ts, kind, route, direction, vehicle_count, severity_ft,
              near_stop, post_uri
       FROM bunching_events
       WHERE posted = 1 AND post_uri IS NOT NULL
       ORDER BY ts DESC, id DESC`,
    )
    .all()
    .map(bunchingDetection);
  const ghosts = db
    .prepare(
      `SELECT id, ts, kind, route, direction, observed, expected, missing, post_uri
       FROM ghost_events
       WHERE post_uri IS NOT NULL
       ORDER BY ts DESC, id DESC`,
    )
    .all()
    .map(ghostDetection);
  return [...gaps, ...bunches, ...ghosts].sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id));
}

function dataStart(alerts, detections) {
  const times = [...alerts.map((a) => a.first_seen_ts), ...detections.map((d) => d.ts)].filter(
    (ts) => ts != null,
  );
  return times.length > 0 ? Math.min(...times) : null;
}

function buildIncidents(alerts, detections, now = Date.now()) {
  const usedDetections = new Set();
  const incidents = [];
  for (const alert of alerts) {
    const matches = findMatches(alert, detections, usedDetections);
    for (const det of matches) usedDetections.add(det.id);
    incidents.push(buildIncidentFromAlert(alert, matches, now));
  }
  for (const det of detections) {
    if (!usedDetections.has(det.id)) incidents.push(buildIncidentFromDetection(det, now));
  }
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
  return {
    schema_version: 2,
    generated_at: now,
    data_start_ts: dataStart(alerts, detections),
    incidents: buildIncidents(alerts, detections, now),
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
