// MARTA incident-lifecycle storage (plan Phase 7 / posting layer).
//
// The detector cores under src/marta/{bus,rail}/ are pure; this is where a
// detection becomes a tracked incident — recorded, deduped, cooled down, and
// (eventually) updated/closed. Ported from the bunching/cooldown/callout subset
// of cta-insights `src/shared/history.js`.
//
// It shares the one MARTA SQLite file with the observation tables (via
// storage.getDb()), but owns its own tables and a longer (90-day) rolloff —
// incidents are a historical archive for the public site, observations are a
// 7-day live-detection window. Tables are created lazily on first use so a
// fresh DB (or a test reopen after closeDb()) gets them without a migration
// step.
const storage = require('../storage');

const DAY_MS = 24 * 60 * 60 * 1000;
// Event tables are kept for historical archiving; only cooldowns + meta_signals
// roll off. Mirrors cta-insights, where bunching/gap/etc. rows live forever.
const META_SIGNAL_ROLLOFF_MS = 2 * DAY_MS;

let _initedDb = null;

function hasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

function addColumnIfMissing(db, table, column, definition) {
  if (!hasColumn(db, table, column))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Return the shared MARTA DB handle with the incident tables ensured. The guard
// re-runs CREATE TABLE if the underlying handle changed (tests reopen the DB
// against a temp path via storage.closeDb()).
function getDb() {
  const db = storage.getDb();
  if (_initedDb !== db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bunching_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        route TEXT NOT NULL,
        direction TEXT,
        vehicle_count INTEGER NOT NULL,
        severity_ft INTEGER NOT NULL,
        near_stop TEXT,
        posted INTEGER NOT NULL DEFAULT 0,
        post_uri TEXT,
        last_seen_ts INTEGER,
        resolved_ts INTEGER,
        resolved_post_uri TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_bunching_kind_route_ts
        ON bunching_events(kind, route, ts);

      CREATE TABLE IF NOT EXISTS gap_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        route TEXT NOT NULL,
        direction TEXT,
        gap_ft INTEGER NOT NULL,
        gap_min REAL NOT NULL,
        expected_min REAL NOT NULL,
        ratio REAL NOT NULL,
        near_stop TEXT,
        posted INTEGER NOT NULL DEFAULT 0,
        post_uri TEXT,
        last_seen_ts INTEGER,
        resolved_ts INTEGER,
        resolved_post_uri TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_gap_kind_route_ts
        ON gap_events(kind, route, ts);

      CREATE TABLE IF NOT EXISTS ghost_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        route TEXT NOT NULL,
        direction TEXT,
        observed REAL,
        expected REAL,
        missing REAL,
        post_uri TEXT,
        last_seen_ts INTEGER,
        resolved_ts INTEGER,
        resolved_post_uri TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ghost_events_kind_route_ts
        ON ghost_events(kind, route, ts);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ghost_events_route_post_uri
        ON ghost_events(route, post_uri);

      CREATE TABLE IF NOT EXISTS speedmap_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        route TEXT NOT NULL,
        direction TEXT,
        avg_mph REAL,
        pct_red REAL NOT NULL DEFAULT 0,
        pct_orange REAL NOT NULL DEFAULT 0,
        pct_yellow REAL NOT NULL DEFAULT 0,
        pct_green REAL NOT NULL DEFAULT 0,
        bin_speeds_json TEXT,
        posted INTEGER NOT NULL DEFAULT 0,
        post_uri TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_speedmap_kind_route_ts
        ON speedmap_runs(kind, route, ts);

      CREATE TABLE IF NOT EXISTS cooldowns (
        key TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        expires_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS meta_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        line TEXT NOT NULL,
        direction TEXT,
        source TEXT NOT NULL,
        severity REAL NOT NULL,
        detail TEXT,
        posted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_meta_signals_kind_line_ts
        ON meta_signals(kind, line, ts);
    `);
    for (const table of ['bunching_events', 'gap_events', 'ghost_events']) {
      addColumnIfMissing(db, table, 'last_seen_ts', 'INTEGER');
      addColumnIfMissing(db, table, 'resolved_ts', 'INTEGER');
      addColumnIfMissing(db, table, 'resolved_post_uri', 'TEXT');
    }
    _initedDb = db;
  }
  return db;
}

// Start-of-day in MARTA's timezone (America/New_York), as epoch ms. The daily
// "Nth bunch today" / cap windows anchor here so they roll over at local
// midnight, not UTC.
function startOfDayET(ts) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  const y = get('year');
  const m = get('month');
  const day = get('day');
  const h = get('hour');
  const mi = get('minute');
  const s = get('second');
  const asUtc = Date.UTC(+y, +m - 1, +day, +h, +mi, +s);
  const offsetMs = d.getTime() - asUtc; // negative for ET (UTC-4/5)
  return Date.UTC(+y, +m - 1, +day) + offsetMs;
}

function recordBunching(
  { kind, route, direction, vehicleCount, severityFt, nearStop, posted, postUri },
  now = Date.now(),
) {
  getDb()
    .prepare(`
      INSERT INTO bunching_events
        (ts, kind, route, direction, vehicle_count, severity_ft, near_stop, posted, post_uri, last_seen_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      now,
      kind,
      route,
      direction || null,
      vehicleCount,
      Math.round(severityFt),
      nearStop || null,
      posted ? 1 : 0,
      postUri || null,
      posted ? now : null,
    );
}

// Must be called BEFORE recordBunching writes the current event, otherwise the
// callouts compare the event against itself. Larger vehicle_count wins (tiebreak
// on span) for buses.
function bunchingCallouts({ kind, route, routeLabel, vehicleCount, severityFt }, now = Date.now()) {
  const out = [];
  const startOfDay = startOfDayET(now);
  const todayCount = getDb()
    .prepare(`
      SELECT COUNT(*) AS c FROM bunching_events
      WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ?
    `)
    .get(kind, route, startOfDay).c;
  const nth = todayCount + 1;
  if (nth >= 2) {
    const label = routeLabel ? `${routeLabel} bunch` : 'bunch';
    out.push(`${ordinal(nth)} ${label} reported today`);
  }

  // 3-prior-event minimum keeps cold-start runs from emitting "worst in 0 days."
  const windowDays = 30;
  const windowStart = now - windowDays * DAY_MS;
  if (kind === 'rail') {
    const row = getDb()
      .prepare(`
        SELECT MAX(vehicle_count) AS maxVc, MIN(severity_ft) AS minSpan, COUNT(*) AS c
        FROM bunching_events
        WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ? AND ts < ?
      `)
      .get(kind, route, windowStart, startOfDay);
    if (row.c >= 3) {
      const beatsCount = vehicleCount > row.maxVc;
      const tiesCountBeatsSpan = vehicleCount === row.maxVc && severityFt < row.minSpan;
      if (beatsCount || tiesCountBeatsSpan) {
        out.push(`tightest reported on this line in ${windowDays} days`);
      }
    }
  } else {
    const row = getDb()
      .prepare(`
        SELECT MAX(vehicle_count) AS maxVc, MAX(severity_ft) AS maxSpan, COUNT(*) AS c
        FROM bunching_events
        WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ? AND ts < ?
      `)
      .get(kind, route, windowStart, startOfDay);
    if (row.c >= 3) {
      const beatsCount = vehicleCount > row.maxVc;
      const tiesCountBeatsSpan = vehicleCount === row.maxVc && severityFt > row.maxSpan;
      if (beatsCount || tiesCountBeatsSpan) {
        out.push(`worst reported on this route in ${windowDays} days`);
      }
    }
  }
  return out;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function formatCallouts(callouts) {
  if (!callouts || callouts.length === 0) return '';
  return `📊 ${callouts.join(' · ')}`;
}

function recordGap(
  { kind, route, direction, gapFt, gapMin, expectedMin, ratio, nearStop, posted, postUri },
  now = Date.now(),
) {
  getDb()
    .prepare(`
      INSERT INTO gap_events
        (ts, kind, route, direction, gap_ft, gap_min, expected_min, ratio, near_stop, posted, post_uri, last_seen_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      now,
      kind,
      route,
      direction || null,
      Math.round(gapFt),
      gapMin,
      expectedMin,
      ratio,
      nearStop || null,
      posted ? 1 : 0,
      postUri || null,
      posted ? now : null,
    );
}

function gapCallouts({ kind, route, routeLabel, ratio }, now = Date.now()) {
  const out = [];
  const startOfDay = startOfDayET(now);
  const todayCount = getDb()
    .prepare(`
      SELECT COUNT(*) AS c FROM gap_events
      WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ?
    `)
    .get(kind, route, startOfDay).c;
  const nth = todayCount + 1;
  if (nth >= 2) {
    const label = routeLabel ? `${routeLabel} gap` : 'gap';
    out.push(`${ordinal(nth)} ${label} reported today`);
  }

  const windowDays = 30;
  const windowStart = now - windowDays * DAY_MS;
  const row = getDb()
    .prepare(`
      SELECT MAX(ratio) AS maxRatio, COUNT(*) AS c
      FROM gap_events
      WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ? AND ts < ?
    `)
    .get(kind, route, windowStart, startOfDay);
  if (row.c >= 3 && ratio > row.maxRatio) {
    out.push(`worst reported on this route in ${windowDays} days`);
  }
  return out;
}

function gapCapAllows({ kind, route, candidate, cap }, now = Date.now()) {
  const events = getDb()
    .prepare(`
      SELECT ratio FROM gap_events
      WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ?
    `)
    .all(kind, route, startOfDayET(now));
  if (events.length < cap) return true;
  return events.every((ev) => candidate.ratio > ev.ratio);
}

function gapCooldownAllows(
  { kind, route, candidate, withinMs = 60 * 60 * 1000 },
  now = Date.now(),
) {
  const events = getDb()
    .prepare(`
      SELECT ratio FROM gap_events
      WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ?
    `)
    .all(kind, route, now - withinMs);
  if (events.length === 0) return true;
  return events.every((ev) => candidate.ratio >= ev.ratio * 1.25);
}

function recordGhostEvent({ kind, route, direction, observed, expected, missing, postUri, ts }) {
  const now = ts || Date.now();
  getDb()
    .prepare(`
      INSERT OR IGNORE INTO ghost_events
        (ts, kind, route, direction, observed, expected, missing, post_uri, last_seen_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      now,
      kind,
      String(route),
      direction || null,
      observed ?? null,
      expected ?? null,
      missing ?? null,
      postUri,
      now,
    );
}

function eventKey({ route, direction }) {
  return `${String(route)}\u0000${direction || ''}`;
}

function reconcileDetectorEvents({ table, kind, current, now = Date.now() }) {
  const db = getDb();
  const currentKeys = new Set((current || []).map(eventKey));
  const postedClause = hasColumn(db, table, 'posted') ? 'posted = 1 AND ' : '';
  const tx = db.transaction(() => {
    const markSeen = db.prepare(`
      UPDATE ${table}
      SET last_seen_ts = ?
      WHERE ${postedClause}resolved_ts IS NULL
        AND kind = ?
        AND route = ?
        AND COALESCE(direction, '') = COALESCE(?, '')
    `);
    for (const item of current || []) {
      markSeen.run(now, kind, String(item.route), item.direction || null);
    }

    const openRows = db
      .prepare(`
        SELECT id, route, direction, ts, last_seen_ts
        FROM ${table}
        WHERE ${postedClause}resolved_ts IS NULL AND kind = ?
      `)
      .all(kind);
    const close = db.prepare(`UPDATE ${table} SET resolved_ts = ? WHERE id = ?`);
    const newestOpenByKey = new Map();
    for (const row of openRows) {
      const key = eventKey(row);
      const prev = newestOpenByKey.get(key);
      if (!prev || row.ts > prev.ts) newestOpenByKey.set(key, row);
    }
    const closed = [];
    for (const row of openRows) {
      const key = eventKey(row);
      if (currentKeys.has(key)) {
        const newest = newestOpenByKey.get(key);
        if (newest?.id === row.id) continue;
        const resolvedTs = newest?.ts ?? row.last_seen_ts ?? now;
        close.run(resolvedTs, row.id);
        closed.push({ ...row, resolved_ts: resolvedTs });
        continue;
      }
      const resolvedTs = row.last_seen_ts ?? now;
      close.run(resolvedTs, row.id);
      closed.push({ ...row, resolved_ts: resolvedTs });
    }
    return closed;
  });
  return tx();
}

function reconcileGapEvents({ kind, current, now }) {
  return reconcileDetectorEvents({ table: 'gap_events', kind, current, now });
}

function reconcileBunchingEvents({ kind, current, now }) {
  return reconcileDetectorEvents({ table: 'bunching_events', kind, current, now });
}

function reconcileGhostEvents({ kind, current, now }) {
  return reconcileDetectorEvents({ table: 'ghost_events', kind, current, now });
}

function recordSpeedmap(
  {
    kind,
    route,
    direction,
    avgMph,
    pctRed,
    pctOrange,
    pctYellow,
    pctGreen,
    binSpeeds,
    posted,
    postUri,
  },
  now = Date.now(),
) {
  getDb()
    .prepare(`
      INSERT INTO speedmap_runs
        (ts, kind, route, direction, avg_mph, pct_red, pct_orange, pct_yellow, pct_green, bin_speeds_json, posted, post_uri)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      now,
      kind,
      String(route),
      direction || null,
      avgMph == null ? null : avgMph,
      pctRed || 0,
      pctOrange || 0,
      pctYellow || 0,
      pctGreen || 0,
      JSON.stringify(binSpeeds || []),
      posted ? 1 : 0,
      postUri || null,
    );
}

function speedmapCallouts({ kind, route, avgMph }, now = Date.now()) {
  if (avgMph == null) return [];
  const out = [];
  const windowDays = 14;
  const row = getDb()
    .prepare(`
      SELECT MIN(avg_mph) AS minAvg, MAX(avg_mph) AS maxAvg, COUNT(*) AS c
      FROM speedmap_runs
      WHERE kind = ? AND route = ? AND posted = 1 AND avg_mph IS NOT NULL AND ts >= ?
    `)
    .get(kind, String(route), now - windowDays * DAY_MS);
  if (row.c < 3) return out;
  if (avgMph < row.minAvg) out.push(`slowest reported in ${windowDays} days`);
  else if (avgMph > row.maxAvg) out.push(`fastest reported in ${windowDays} days`);
  return out;
}

function leastRecentlyPostedSpeedmapRoute(kind, candidates) {
  if (!candidates || candidates.length === 0) return null;
  const rows = getDb()
    .prepare(`
      SELECT route, MAX(ts) AS lastTs
      FROM speedmap_runs
      WHERE kind = ? AND posted = 1
      GROUP BY route
    `)
    .all(kind);
  const lastTsByRoute = new Map(rows.map((r) => [String(r.route), r.lastTs]));
  let best = null;
  let bestTs = Infinity;
  for (const route of candidates.map(String)) {
    const ts = lastTsByRoute.has(route) ? lastTsByRoute.get(route) : -Infinity;
    if (ts < bestTs) {
      bestTs = ts;
      best = route;
    }
  }
  return best;
}

// Highest vehicle_count ever posted for `kind` (across all routes). Powers the
// 🥇 medal in the post text. Callers compare BEFORE recording, so the candidate
// isn't yet in the result.
function previousMaxBunchingVehicleCount(kind) {
  const row = getDb()
    .prepare(
      `SELECT MAX(vehicle_count) AS maxVc FROM bunching_events WHERE kind = ? AND posted = 1`,
    )
    .get(kind);
  return row?.maxVc ?? 0;
}

// Soft daily cap: a chronically-bad route gets `cap` posts/day, but a strictly-
// more-severe escalation still breaks through.
function bunchingCapAllows({ kind, route, candidate, cap }, now = Date.now()) {
  const events = getDb()
    .prepare(`
      SELECT vehicle_count AS vc, severity_ft AS sev
      FROM bunching_events
      WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ?
    `)
    .all(kind, route, startOfDayET(now));
  if (events.length < cap) return true;
  return events.every((ev) => {
    if (candidate.vehicleCount > ev.vc) return true;
    if (candidate.vehicleCount === ev.vc) {
      if (kind === 'rail') return candidate.severityFt < ev.sev;
      return candidate.severityFt > ev.sev;
    }
    return false;
  });
}

// Cooldown-bypass: an active cooldown shouldn't suppress a strictly-more-severe
// escalation on the same route. True when the candidate dominates every posted
// bunch on this route within `withinMs` (default 1h to match COOLDOWN_MS).
function bunchingCooldownAllows(
  { kind, route, candidate, withinMs = 60 * 60 * 1000 },
  now = Date.now(),
) {
  const events = getDb()
    .prepare(`
      SELECT vehicle_count AS vc, severity_ft AS sev
      FROM bunching_events
      WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ?
    `)
    .all(kind, route, now - withinMs);
  if (events.length === 0) return true;
  return events.every((ev) => {
    if (candidate.vehicleCount > ev.vc) return true;
    if (candidate.vehicleCount === ev.vc) {
      if (kind === 'rail') return candidate.severityFt < ev.sev;
      return candidate.severityFt > ev.sev;
    }
    return false;
  });
}

// Sub-threshold / suppressed-detection breadcrumbs for later multi-signal
// correlation. Mirrors cta-insights recordMetaSignal.
function recordMetaSignal(
  { kind, line, direction, source, severity, detail, posted },
  now = Date.now(),
) {
  getDb()
    .prepare(`
      INSERT INTO meta_signals (ts, kind, line, direction, source, severity, detail, posted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      now,
      kind,
      line,
      direction || null,
      source,
      severity,
      detail ? JSON.stringify(detail) : null,
      posted ? 1 : 0,
    );
}

// Drop expired cooldowns (+ ancient legacy null-ttl rows) and stale meta_signals.
// Event tables are an archive — kept forever.
function rolloffOld(now = Date.now()) {
  const db = getDb();
  db.prepare(
    'DELETE FROM cooldowns WHERE (expires_at IS NOT NULL AND expires_at < ?) OR (expires_at IS NULL AND ts < ?)',
  ).run(now, now - 90 * DAY_MS);
  db.prepare('DELETE FROM meta_signals WHERE ts < ?').run(now - META_SIGNAL_ROLLOFF_MS);
}

module.exports = {
  getDb,
  startOfDayET,
  recordBunching,
  reconcileBunchingEvents,
  bunchingCallouts,
  formatCallouts,
  recordGap,
  reconcileGapEvents,
  gapCallouts,
  gapCapAllows,
  gapCooldownAllows,
  recordGhostEvent,
  reconcileGhostEvents,
  recordSpeedmap,
  speedmapCallouts,
  leastRecentlyPostedSpeedmapRoute,
  previousMaxBunchingVehicleCount,
  bunchingCapAllows,
  bunchingCooldownAllows,
  recordMetaSignal,
  rolloffOld,
};
