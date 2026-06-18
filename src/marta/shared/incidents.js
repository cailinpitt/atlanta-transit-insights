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
const { markWebPushPending } = require('../../shared/webPushTrigger');

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
  if (hasColumn(db, table, column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (e) {
    // Multiple short-lived cron processes can race through this lazy migration
    // on first deploy. If another process added the column after our PRAGMA
    // check, the desired schema is already present.
    if (!/duplicate column name/i.test(e.message || '') || !hasColumn(db, table, column)) {
      throw e;
    }
  }
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
        canceled_trips INTEGER,
        unexplained_missing REAL,
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

      CREATE TABLE IF NOT EXISTS roundup_anchors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        line TEXT NOT NULL,
        post_uri TEXT NOT NULL UNIQUE,
        post_cid TEXT,
        ts INTEGER NOT NULL,
        expires_ts INTEGER NOT NULL,
        clear_ticks INTEGER NOT NULL DEFAULT 0,
        resolved_ts INTEGER,
        resolution_post_uri TEXT,
        signals TEXT,
        pending_resolved_ts INTEGER,
        bullets TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_roundup_anchors_kind_expires
        ON roundup_anchors(kind, expires_ts);

      CREATE TABLE IF NOT EXISTS disruption_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        line TEXT NOT NULL,
        direction TEXT,
        source TEXT NOT NULL,
        posted INTEGER NOT NULL DEFAULT 0,
        post_uri TEXT,
        evidence TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_disruption_events_kind_line_ts
        ON disruption_events(kind, line, ts);
    `);
    for (const table of ['bunching_events', 'gap_events', 'ghost_events']) {
      addColumnIfMissing(db, table, 'last_seen_ts', 'INTEGER');
      addColumnIfMissing(db, table, 'resolved_ts', 'INTEGER');
      addColumnIfMissing(db, table, 'resolved_post_uri', 'TEXT');
    }
    // member_ids = JSON array of the vehicle/train ids in a cross-route bunch,
    // used to suppress the per-route post for the same pileup (see crossBunching).
    addColumnIfMissing(db, 'bunching_events', 'member_ids', 'TEXT');
    addColumnIfMissing(db, 'ghost_events', 'canceled_trips', 'INTEGER');
    addColumnIfMissing(db, 'ghost_events', 'unexplained_missing', 'REAL');
    for (const [name, type] of [
      ['clear_ticks', 'INTEGER NOT NULL DEFAULT 0'],
      ['resolved_ts', 'INTEGER'],
      ['resolution_post_uri', 'TEXT'],
      ['signals', 'TEXT'],
      ['pending_resolved_ts', 'INTEGER'],
      ['bullets', 'TEXT'],
    ]) {
      addColumnIfMissing(db, 'roundup_anchors', name, type);
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
  { kind, route, direction, vehicleCount, severityFt, nearStop, posted, postUri, memberIds },
  now = Date.now(),
) {
  getDb()
    .prepare(`
      INSERT INTO bunching_events
        (ts, kind, route, direction, vehicle_count, severity_ft, near_stop, posted, post_uri, last_seen_ts, member_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      memberIds && memberIds.length ? JSON.stringify(memberIds.map(String)) : null,
    );
  // A posted detection is the only kind the web export reads; it may fold into
  // an active alert/roundup incident, so refresh the published data.
  if (posted && postUri) markWebPushPending();
}

// The vehicle/train ids in cross-route bunches (`kind` ending in `-multi`)
// posted within `withinMs`. The per-route bunching bins consult this to
// suppress the per-route post for a pileup the cross-route bin already covered.
function recentCrossBunchMemberIds({ withinMs = 10 * 60 * 1000 } = {}, now = Date.now()) {
  const rows = getDb()
    .prepare(`
      SELECT member_ids FROM bunching_events
      WHERE kind LIKE '%-multi' AND posted = 1 AND member_ids IS NOT NULL AND ts >= ?
    `)
    .all(now - withinMs);
  const ids = new Set();
  for (const row of rows) {
    try {
      for (const id of JSON.parse(row.member_ids)) ids.add(String(id));
    } catch {
      // tolerate a malformed row rather than crash the bin
    }
  }
  return ids;
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
  if (posted && postUri) markWebPushPending();
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

// Cooldown-override gate for gaps, ported from cta-insights src/shared/history.js
// so MARTA matches CTA. A within-cooldown gap re-posts only if it dominates
// every prior posted gap on the route by a margin that DECAYS over the cooldown
// window (1.25× when the prior post is fresh → 1.1× as it ages), OR if it's a
// sustained severe gap (≥20 min after the prior post AND still ≥3.0× headway).
// The flat 1.25× version this replaced suppressed sustained/aged escalations
// that CTA re-posts.
const GAP_COOLDOWN_OVERRIDE_MARGIN_FRESH = 1.25;
const GAP_COOLDOWN_OVERRIDE_MARGIN_FLOOR = 1.1;
const GAP_COOLDOWN_OVERRIDE_SUSTAINED_MIN_ELAPSED_MS = 20 * 60 * 1000;
const GAP_COOLDOWN_OVERRIDE_SUSTAINED_RATIO = 3.0;

function gapCooldownAllows(
  { kind, route, candidate, withinMs = 60 * 60 * 1000 },
  now = Date.now(),
) {
  const events = getDb()
    .prepare(`
      SELECT ratio, ts FROM gap_events
      WHERE kind = ? AND route = ? AND posted = 1 AND ts >= ?
    `)
    .all(kind, route, now - withinMs);
  if (events.length === 0) return true;
  return events.every((ev) => {
    const elapsed = Math.max(0, now - ev.ts);
    const t = Math.min(1, elapsed / withinMs);
    const margin =
      GAP_COOLDOWN_OVERRIDE_MARGIN_FRESH -
      (GAP_COOLDOWN_OVERRIDE_MARGIN_FRESH - GAP_COOLDOWN_OVERRIDE_MARGIN_FLOOR) * t;
    if (candidate.ratio > ev.ratio * margin) return true;
    if (
      elapsed >= GAP_COOLDOWN_OVERRIDE_SUSTAINED_MIN_ELAPSED_MS &&
      candidate.ratio >= GAP_COOLDOWN_OVERRIDE_SUSTAINED_RATIO
    ) {
      return true;
    }
    return false;
  });
}

function recordGhostEvent({
  kind,
  route,
  direction,
  observed,
  expected,
  missing,
  canceledTrips,
  unexplainedMissing,
  postUri,
  ts,
}) {
  const now = ts || Date.now();
  getDb()
    .prepare(`
      INSERT OR IGNORE INTO ghost_events
        (ts, kind, route, direction, observed, expected, missing, canceled_trips, unexplained_missing,
         post_uri, last_seen_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      now,
      kind,
      String(route),
      direction || null,
      observed ?? null,
      expected ?? null,
      missing ?? null,
      canceledTrips ?? null,
      unexplainedMissing ?? null,
      postUri,
      now,
    );
  if (postUri) markWebPushPending();
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
  const closed = tx();
  // Resolving a detection flips its lifecycle in any incident it's part of.
  if (closed.length > 0) markWebPushPending();
  return closed;
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

function getRecentMetaSignals({ kind, line, withinMs }, now = Date.now()) {
  const sinceTs = now - withinMs;
  const params = [kind, sinceTs];
  let sql = 'SELECT * FROM meta_signals WHERE kind = ? AND ts >= ?';
  if (line) {
    sql += ' AND line = ?';
    params.push(line);
  }
  sql += ' ORDER BY ts DESC';
  return getDb()
    .prepare(sql)
    .all(...params);
}

function recordRoundupAnchor({
  kind,
  line,
  postUri,
  postCid,
  ts,
  signals,
  bullets,
  ttlMs = 2 * 60 * 60 * 1000,
}) {
  const signalsStr = signals && signals.length > 0 ? [...new Set(signals)].join(',') : null;
  const bulletsStr = bullets && bullets.length > 0 ? JSON.stringify(bullets) : null;
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO roundup_anchors
        (kind, line, post_uri, post_cid, ts, expires_ts, signals, bullets)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(kind, String(line), postUri, postCid || null, ts, ts + ttlMs, signalsStr, bulletsStr);
  // A roundup anchor is a website incident; publish it.
  if (postUri) markWebPushPending();
}

function listUnresolvedRoundupAnchors(kind) {
  return getDb()
    .prepare(`
      SELECT id, line, post_uri, post_cid, ts, clear_ticks
      FROM roundup_anchors
      WHERE kind = ? AND resolved_ts IS NULL
    `)
    .all(kind);
}

function updateRoundupClearTicks(id, clearTicks, _now = Date.now(), pendingClearTs = Date.now()) {
  if (clearTicks === 0) {
    getDb()
      .prepare(
        'UPDATE roundup_anchors SET clear_ticks = 0, pending_resolved_ts = NULL WHERE id = ?',
      )
      .run(id);
    return;
  }
  getDb()
    .prepare(`
      UPDATE roundup_anchors
      SET clear_ticks = ?,
          pending_resolved_ts = COALESCE(pending_resolved_ts, ?)
      WHERE id = ?
    `)
    .run(clearTicks, pendingClearTs, id);
}

function markRoundupResolved(id, resolutionPostUri, ts = Date.now()) {
  getDb()
    .prepare(`
      UPDATE roundup_anchors
      SET resolved_ts = COALESCE(pending_resolved_ts, ?),
          resolution_post_uri = ?,
          pending_resolved_ts = NULL
      WHERE id = ?
    `)
    .run(ts, resolutionPostUri, id);
  markWebPushPending();
}

// Route-silence disruptions (thin-gap firings + pulse blackouts and their
// `observed-clear` resolutions). Ported from cta-insights recordDisruption so
// the MARTA web export can surface these standalone, the way CTA's dashboard
// does — they can't reliably reach the roundup, since a fully-silent route has
// no co-occurring gap/bunch signal to correlate with.
function recordDisruption(
  { kind, line, direction, source, posted, postUri, evidence = null },
  now = Date.now(),
) {
  let evidenceJson = null;
  if (evidence && typeof evidence === 'object' && Object.keys(evidence).length > 0) {
    try {
      evidenceJson = JSON.stringify(evidence);
    } catch (_e) {
      evidenceJson = null;
    }
  }
  getDb()
    .prepare(`
      INSERT INTO disruption_events
        (ts, kind, line, direction, source, posted, post_uri, evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      now,
      kind,
      String(line),
      direction || null,
      source,
      posted ? 1 : 0,
      postUri || null,
      evidenceJson,
    );
  // A posted disruption (or its clear) is a standalone website incident.
  if (postUri || source === 'observed-clear') markWebPushPending();
}

// Posted disruptions of `source` (e.g. 'observed-thin', 'observed') with no
// 'observed-clear' on the same line at/after them — i.e. still-open firings.
// Window is [now - sinceMs, now - untilMs).
function findUnresolvedDisruptions({ kind, source, sinceMs, untilMs = 0 }, now = Date.now()) {
  return getDb()
    .prepare(`
      SELECT d.id, d.ts, d.line, d.post_uri AS postUri
      FROM disruption_events d
      WHERE d.kind = ? AND d.source = ?
        AND d.posted = 1 AND d.post_uri IS NOT NULL
        AND d.ts >= ? AND d.ts < ?
        AND NOT EXISTS (
          SELECT 1 FROM disruption_events c
          WHERE c.kind = d.kind AND c.source = 'observed-clear'
            AND c.line = d.line AND c.ts >= d.ts
        )
      ORDER BY d.ts ASC
    `)
    .all(kind, source, now - sinceMs, now - untilMs);
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
  recentCrossBunchMemberIds,
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
  getRecentMetaSignals,
  recordDisruption,
  findUnresolvedDisruptions,
  recordRoundupAnchor,
  listUnresolvedRoundupAnchors,
  updateRoundupClearTicks,
  markRoundupResolved,
  rolloffOld,
};
