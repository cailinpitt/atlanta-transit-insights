// MARTA observation storage (plan Phase 3).
//
// A self-contained SQLite history for the normalized feed observations the
// detectors read. It mirrors the cta-insights conventions (better-sqlite3, WAL,
// lazy singleton, write-in-a-transaction, swallow errors on ingest so a logger
// hiccup never breaks a fetch) but uses MARTA-shaped tables rather than the
// CTA `observations` table — MARTA bus is GTFS-rt (trip_id + speed, no
// pdist/pid) and MARTA rail carries BOTH true train positions AND per-station
// arrival predictions, neither of which fits the CTA schema.
//
// Tables:
//   bus_observations  one row / vehicle / snapshot  (VehiclePositions)
//   bus_trip_status   one row / (snapshot, trip)     (TripUpdates summary)
//   bus_trip_updates  one row / (snapshot, trip, stop)  (TripUpdates)
//   rail_observations one row / tracked train / snapshot  (Path A positions)
//   rail_arrivals     one row / (snapshot, train→station) incl. scheduled rows
//
// Record functions take the exact shapes the src/marta adapters emit.
const Path = require('node:path');
const Fs = require('fs-extra');
const Database = require('better-sqlite3');

// Detection looks back ~1h; 7-day retention matches cta-insights and covers
// low-frequency overnight/weekend route variants without special-casing.
const ROLLOFF_MS = 7 * 24 * 60 * 60 * 1000;
const ACCESSIBILITY_ROLLOFF_MS = 180 * 24 * 60 * 60 * 1000;
const ACCESSIBILITY_CLEAR_TICKS = 3;

let _db = null;

function dbPath() {
  return (
    process.env.MARTA_HISTORY_DB_PATH || Path.join(__dirname, '..', '..', 'state', 'marta.sqlite')
  );
}

function getDb() {
  if (_db) return _db;
  const p = dbPath();
  Fs.ensureDirSync(Path.dirname(p));
  _db = new Database(p);
  _db.pragma('journal_mode = WAL');
  // Many crons (observe-rail/-buses every minute, the pulse + bunching/gap/ghost
  // detectors) hammer this one file concurrently. WAL lets readers run during a
  // write, but only one writer at a time — so a write can still hit SQLITE_BUSY
  // ("database is locked") when another process holds the write lock. Wait up to
  // 15s for it instead of failing the tick outright (default is 5s).
  _db.pragma('busy_timeout = 15000');
  _db.exec(`
    -- Bus VehiclePositions: one row per vehicle per poll. route is the PUBLIC
    -- number from the realtime feed; resolve to a canonical GTFS route via
    -- src/marta/gtfs.js at detection time (join key is trip_id).
    CREATE TABLE IF NOT EXISTS bus_observations (
      ts INTEGER NOT NULL,
      route TEXT NOT NULL,
      trip_id TEXT,
      vehicle_id TEXT,
      label TEXT,
      lat REAL,
      lon REAL,
      bearing INTEGER,
      speed REAL,                 -- m/s, null when the feed omits it (~43%)
      occupancy TEXT,
      vehicle_ts INTEGER,         -- the feed's per-vehicle timestamp (epoch s)
      start_date TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bus_obs_route_ts ON bus_observations(route, ts);
    CREATE INDEX IF NOT EXISTS idx_bus_obs_trip_ts ON bus_observations(trip_id, ts);

    -- Bus TripUpdates flattened to one row per (poll, trip, stop). MARTA omits
    -- GTFS-rt delay, so adherence = predicted arrival − scheduled (stored as
    -- schedule_deviation_sec). This table is optional because it is large; the
    -- compact bus_trip_status table is always written.
    CREATE TABLE IF NOT EXISTS bus_trip_status (
      ts INTEGER NOT NULL,
      trip_id TEXT NOT NULL,
      route TEXT,
      vehicle_id TEXT,
      label TEXT,
      trip_relationship TEXT,
      start_date TEXT,
      start_time TEXT,
      stop_count INTEGER NOT NULL DEFAULT 0,
      first_stop_sequence INTEGER,
      first_stop_id TEXT,
      first_arrival_time INTEGER,
      first_arrival_sched INTEGER,
      last_stop_sequence INTEGER,
      last_stop_id TEXT,
      last_arrival_time INTEGER,
      last_arrival_sched INTEGER,
      feed_ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_bus_trip_status_trip_ts
      ON bus_trip_status(trip_id, ts);
    CREATE INDEX IF NOT EXISTS idx_bus_trip_status_route_ts
      ON bus_trip_status(route, ts);
    CREATE INDEX IF NOT EXISTS idx_bus_trip_status_rel_ts
      ON bus_trip_status(trip_relationship, ts);

    CREATE TABLE IF NOT EXISTS bus_trip_updates (
      ts INTEGER NOT NULL,
      trip_id TEXT NOT NULL,
      route TEXT,
      vehicle_id TEXT,
      stop_sequence INTEGER,
      stop_id TEXT,
      schedule_relationship TEXT,
      arrival_time INTEGER,
      arrival_sched INTEGER,
      departure_time INTEGER,
      departure_sched INTEGER,
      schedule_deviation_sec INTEGER,
      feed_ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_bus_tu_trip_ts ON bus_trip_updates(trip_id, ts);
    CREATE INDEX IF NOT EXISTS idx_bus_tu_route_ts ON bus_trip_updates(route, ts);

    -- Rail tracked trains (IS_REALTIME=true): one row per train per poll with
    -- its true position. Position deltas between polls give speed (Path A).
    CREATE TABLE IF NOT EXISTS rail_observations (
      ts INTEGER NOT NULL,
      train_id TEXT NOT NULL,
      line TEXT NOT NULL,
      direction TEXT,
      destination TEXT,
      lat REAL,
      lon REAL,
      delay_sec INTEGER,
      event_ts INTEGER            -- feed's per-train EVENT_TIME (epoch ms)
    );
    CREATE INDEX IF NOT EXISTS idx_rail_obs_line_ts ON rail_observations(line, ts);
    CREATE INDEX IF NOT EXISTS idx_rail_obs_train_ts ON rail_observations(train_id, ts);

    -- Rail station arrivals: one row per (poll, train→station) prediction,
    -- INCLUDING scheduled rows (is_realtime=0, no train_id/position). Scheduled
    -- rows with no materializing train are the rail-ghost substrate; realtime
    -- rows give per-station headways.
    CREATE TABLE IF NOT EXISTS rail_arrivals (
      ts INTEGER NOT NULL,
      is_realtime INTEGER NOT NULL,
      train_id TEXT,
      line TEXT,
      direction TEXT,
      destination TEXT,
      station TEXT,
      waiting_seconds INTEGER,
      next_arrival_clock TEXT,
      event_ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_rail_arr_line_station_ts
      ON rail_arrivals(line, station, ts);

    -- Atlanta Streetcar vehicle positions (OTP feed): one row per streetcar per
    -- poll with its true position. Stored separately from heavy rail so the four
    -- rail lines stay pure, but the same Path-A shape (position deltas between
    -- polls give speed). vehicle_id is the OTP id ("MARTA:1001"); label is the
    -- fleet number ("1001").
    CREATE TABLE IF NOT EXISTS streetcar_observations (
      ts INTEGER NOT NULL,
      vehicle_id TEXT NOT NULL,
      label TEXT,
      line TEXT NOT NULL,
      direction TEXT,
      trip_id TEXT,
      lat REAL,
      lon REAL,
      event_ts INTEGER            -- feed's per-vehicle lastUpdate (epoch ms)
    );
    CREATE INDEX IF NOT EXISTS idx_streetcar_obs_veh_ts
      ON streetcar_observations(vehicle_id, ts);

    -- Rail dead-segment ("pulse") debounce state: one row per (line, direction)
    -- tracking a cold run across cron ticks so a flicker doesn't post and the
    -- eventual ✅ clear targets the canonical post. Ported from cta-insights
    -- pulse_state. active_post_uri pins the post for the live outage.
    CREATE TABLE IF NOT EXISTS pulse_state (
      line TEXT NOT NULL,
      direction TEXT NOT NULL,
      run_lo_ft INTEGER,
      run_hi_ft INTEGER,
      from_station TEXT,
      to_station TEXT,
      started_ts INTEGER,
      last_seen_ts INTEGER,
      consecutive_ticks INTEGER NOT NULL DEFAULT 0,
      clear_ticks INTEGER NOT NULL DEFAULT 0,
      clear_started_ts INTEGER,
      posted_cooldown_key TEXT,
      active_post_uri TEXT,
      active_post_ts INTEGER,
      PRIMARY KEY (line, direction)
    );

    -- Bare ts indexes for the 7-day rolloff. rolloffOldObservations runs every
    -- observe tick and does DELETE ... WHERE ts < cutoff on each snapshot table.
    -- The composite (route|line|..., ts) indexes above can't serve a bare ts
    -- predicate (ts isn't the leftmost column), so without these the DELETE
    -- full-scans the whole table — on rail_arrivals that's millions of rows
    -- every minute, holding the write lock long enough to push concurrent
    -- writers past busy_timeout ("database is locked"). With a ts index the
    -- DELETE is a range scan over just the newly-expired rows.
    CREATE INDEX IF NOT EXISTS idx_bus_obs_ts ON bus_observations(ts);
    CREATE INDEX IF NOT EXISTS idx_bus_trip_status_ts ON bus_trip_status(ts);
    CREATE INDEX IF NOT EXISTS idx_bus_tu_ts ON bus_trip_updates(ts);
    CREATE INDEX IF NOT EXISTS idx_rail_obs_ts ON rail_observations(ts);
    CREATE INDEX IF NOT EXISTS idx_rail_arr_ts ON rail_arrivals(ts);
    CREATE INDEX IF NOT EXISTS idx_streetcar_obs_ts ON streetcar_observations(ts);

    -- Elevator/escalator/entrance outage archive. This is capture/export only:
    -- no Bluesky post URI columns because accessibility alerts are intentionally
    -- suppressed from the rider notification timeline.
    CREATE TABLE IF NOT EXISTS accessibility_outages (
      source_id TEXT PRIMARY KEY,
      agency TEXT NOT NULL,
      station_name TEXT,
      station_slug TEXT,
      lines TEXT,
      unit_type TEXT NOT NULL,
      unit_label TEXT,
      headline TEXT,
      description TEXT,
      source_url TEXT,
      first_seen_ts INTEGER NOT NULL,
      last_seen_ts INTEGER NOT NULL,
      restored_ts INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      clear_ticks INTEGER NOT NULL DEFAULT 0,
      clear_started_ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_accessibility_active ON accessibility_outages(active);
    CREATE INDEX IF NOT EXISTS idx_accessibility_station ON accessibility_outages(station_slug);
    CREATE INDEX IF NOT EXISTS idx_accessibility_last_seen ON accessibility_outages(last_seen_ts);
  `);
  return _db;
}

const fin = (v) => (Number.isFinite(v) ? v : null);
const str = (v) => (v != null ? String(v) : null);

// --- Writers (each swallows errors; ingest must never throw into a fetch) ---

function recordBusObservations(vehicles, now = Date.now()) {
  if (!vehicles || vehicles.length === 0) return;
  try {
    const stmt = getDb().prepare(`
      INSERT INTO bus_observations
        (ts, route, trip_id, vehicle_id, label, lat, lon, bearing, speed, occupancy, vehicle_ts, start_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = getDb().transaction((items) => {
      for (const v of items) {
        if (!v.realtimeRouteId) continue; // unusable without a route
        stmt.run(
          now,
          String(v.realtimeRouteId),
          str(v.tripId),
          str(v.vehicleId),
          str(v.label),
          fin(v.lat),
          fin(v.lon),
          Number.isFinite(v.bearing) ? Math.round(v.bearing) : null,
          fin(v.speed),
          str(v.occupancy),
          fin(v.ts),
          str(v.startDate),
        );
      }
    });
    tx(vehicles);
  } catch (e) {
    console.warn(`recordBusObservations failed: ${e.message}`);
  }
}

function recordBusTripUpdates(tripUpdates, now = Date.now()) {
  if (!tripUpdates || tripUpdates.length === 0) return;
  try {
    const statusStmt = getDb().prepare(`
      INSERT INTO bus_trip_status
        (ts, trip_id, route, vehicle_id, label, trip_relationship, start_date, start_time,
         stop_count, first_stop_sequence, first_stop_id, first_arrival_time, first_arrival_sched,
         last_stop_sequence, last_stop_id, last_arrival_time, last_arrival_sched, feed_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const stopStmt = getDb().prepare(`
      INSERT INTO bus_trip_updates
        (ts, trip_id, route, vehicle_id, stop_sequence, stop_id, schedule_relationship,
         arrival_time, arrival_sched, departure_time, departure_sched, schedule_deviation_sec, feed_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const storeStops = process.env.MARTA_STORE_TRIP_UPDATE_STOPS === '1';
    const tx = getDb().transaction((items) => {
      for (const tu of items) {
        if (!tu.tripId) continue;
        const stops = tu.stopUpdates || [];
        const first = stops[0] || null;
        const last = stops[stops.length - 1] || null;
        statusStmt.run(
          now,
          String(tu.tripId),
          str(tu.realtimeRouteId),
          str(tu.vehicleId),
          str(tu.label),
          str(tu.scheduleRelationship),
          str(tu.startDate),
          str(tu.startTime),
          stops.length,
          Number.isFinite(first?.stopSequence) ? first.stopSequence : null,
          str(first?.stopId),
          fin(first?.arrivalTime),
          fin(first?.arrivalScheduledTime),
          Number.isFinite(last?.stopSequence) ? last.stopSequence : null,
          str(last?.stopId),
          fin(last?.arrivalTime),
          fin(last?.arrivalScheduledTime),
          fin(tu.timestamp),
        );
        if (!storeStops) continue;
        // A trip with no stop updates still gets one summary row so a canceled
        // trip with an empty stop list is recorded.
        const stopRows = stops.length > 0 ? stops : [null];
        for (const s of stopRows) {
          stopStmt.run(
            now,
            String(tu.tripId),
            str(tu.realtimeRouteId),
            str(tu.vehicleId),
            Number.isFinite(s?.stopSequence) ? s.stopSequence : null,
            str(s?.stopId),
            str(s?.scheduleRelationship),
            fin(s?.arrivalTime),
            fin(s?.arrivalScheduledTime),
            fin(s?.departureTime),
            fin(s?.departureScheduledTime),
            fin(s?.scheduleDeviationSec),
            fin(tu.timestamp),
          );
        }
      }
    });
    tx(tripUpdates);
  } catch (e) {
    console.warn(`recordBusTripUpdates failed: ${e.message}`);
  }
}

function recordRailObservations(trains, now = Date.now()) {
  if (!trains || trains.length === 0) return;
  try {
    const stmt = getDb().prepare(`
      INSERT INTO rail_observations
        (ts, train_id, line, direction, destination, lat, lon, delay_sec, event_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = getDb().transaction((items) => {
      for (const t of items) {
        if (t.trainId == null || !t.line) continue;
        stmt.run(
          now,
          String(t.trainId),
          String(t.line),
          str(t.direction),
          str(t.destination),
          fin(t.lat),
          fin(t.lon),
          fin(t.delaySeconds),
          fin(t.eventTs),
        );
      }
    });
    tx(trains);
  } catch (e) {
    console.warn(`recordRailObservations failed: ${e.message}`);
  }
}

function recordRailArrivals(arrivals, now = Date.now()) {
  if (!arrivals || arrivals.length === 0) return;
  try {
    const stmt = getDb().prepare(`
      INSERT INTO rail_arrivals
        (ts, is_realtime, train_id, line, direction, destination, station, waiting_seconds, next_arrival_clock, event_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = getDb().transaction((items) => {
      for (const a of items) {
        if (!a.line || !a.station) continue;
        stmt.run(
          now,
          a.isRealtime ? 1 : 0,
          str(a.trainId),
          String(a.line),
          str(a.direction),
          str(a.destination),
          String(a.station),
          fin(a.waitingSeconds),
          str(a.nextArrivalClock),
          fin(a.eventTs),
        );
      }
    });
    tx(arrivals);
  } catch (e) {
    console.warn(`recordRailArrivals failed: ${e.message}`);
  }
}

// Convenience: record a full parseTrainData() result — both the tracked-train
// positions and every arrival row in one call.
function recordRailSnapshot(parsed, now = Date.now()) {
  if (!parsed) return;
  recordRailObservations(parsed.trains, now);
  recordRailArrivals(parsed.arrivals, now);
}

// Atlanta Streetcar vehicle positions from the OTP feed (src/marta/streetcar).
function recordStreetcarObservations(vehicles, now = Date.now()) {
  if (!vehicles || vehicles.length === 0) return;
  try {
    const stmt = getDb().prepare(`
      INSERT INTO streetcar_observations
        (ts, vehicle_id, label, line, direction, trip_id, lat, lon, event_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = getDb().transaction((items) => {
      for (const v of items) {
        if (v.vehicleId == null || !v.line) continue;
        stmt.run(
          now,
          String(v.vehicleId),
          str(v.label),
          String(v.line),
          str(v.direction),
          str(v.tripId),
          fin(v.lat),
          fin(v.lon),
          fin(v.eventTs),
        );
      }
    });
    tx(vehicles);
  } catch (e) {
    console.warn(`recordStreetcarObservations failed: ${e.message}`);
  }
}

function upsertAccessibilityOutages(rows, now = Date.now()) {
  if (!rows || rows.length === 0) return;
  const stmt = getDb().prepare(`
    INSERT INTO accessibility_outages
      (source_id, agency, station_name, station_slug, lines, unit_type, unit_label,
       headline, description, source_url, first_seen_ts, last_seen_ts, restored_ts,
       active, clear_ticks, clear_started_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, 0, NULL)
    ON CONFLICT(source_id) DO UPDATE SET
      agency = excluded.agency,
      station_name = excluded.station_name,
      station_slug = excluded.station_slug,
      lines = excluded.lines,
      unit_type = excluded.unit_type,
      unit_label = excluded.unit_label,
      headline = excluded.headline,
      description = excluded.description,
      source_url = excluded.source_url,
      last_seen_ts = excluded.last_seen_ts,
      restored_ts = NULL,
      active = 1,
      clear_ticks = 0,
      clear_started_ts = NULL
  `);
  const tx = getDb().transaction((items) => {
    for (const row of items) {
      if (!row?.sourceId) continue;
      stmt.run(
        String(row.sourceId),
        String(row.agency || 'marta'),
        str(row.stationName),
        str(row.stationSlug),
        Array.isArray(row.lines) ? row.lines.join(',') : str(row.lines),
        String(row.unitType || 'other'),
        str(row.unitLabel),
        str(row.headline),
        str(row.description),
        str(row.sourceUrl),
        fin(row.firstSeenTs) ?? now,
        now,
      );
    }
  });
  tx(rows);
}

// Re-derive an already-stored outage's station fields. Used to backfill rows
// that were ingested before a station-matching fix and never re-upserted (a
// restored alert drops out of the feed, so the upsert path can't reach it).
function updateAccessibilityStation(sourceId, { stationName, stationSlug, lines }) {
  getDb()
    .prepare(`
      UPDATE accessibility_outages
      SET station_name = ?, station_slug = ?, lines = ?
      WHERE source_id = ?
    `)
    .run(
      str(stationName),
      str(stationSlug),
      Array.isArray(lines) ? lines.join(',') : str(lines),
      String(sourceId),
    );
}

function reconcileAccessibilityOutages(seenIds, now = Date.now()) {
  const seen = new Set([...seenIds].map(String));
  const rows = getDb()
    .prepare(
      'SELECT source_id AS sourceId, clear_ticks AS clearTicks FROM accessibility_outages WHERE active = 1',
    )
    .all();
  const bump = getDb().prepare(`
    UPDATE accessibility_outages
    SET clear_ticks = clear_ticks + 1,
        clear_started_ts = COALESCE(clear_started_ts, ?)
    WHERE source_id = ?
  `);
  const restore = getDb().prepare(`
    UPDATE accessibility_outages
    SET active = 0,
        restored_ts = COALESCE(clear_started_ts, ?),
        clear_ticks = 0
    WHERE source_id = ?
  `);
  const reset = getDb().prepare(`
    UPDATE accessibility_outages
    SET clear_ticks = 0,
        clear_started_ts = NULL
    WHERE source_id = ?
  `);
  const tx = getDb().transaction(() => {
    for (const row of rows) {
      if (seen.has(String(row.sourceId))) {
        if (row.clearTicks > 0) reset.run(row.sourceId);
        continue;
      }
      const next = (row.clearTicks || 0) + 1;
      bump.run(now, row.sourceId);
      if (next >= ACCESSIBILITY_CLEAR_TICKS) restore.run(now, row.sourceId);
    }
  });
  tx();
}

function getAccessibilityOutages(sinceTs) {
  return getDb()
    .prepare(`
      SELECT source_id AS sourceId, agency, station_name AS stationName,
             station_slug AS stationSlug, lines, unit_type AS unitType,
             unit_label AS unitLabel, headline, description, source_url AS sourceUrl,
             first_seen_ts AS firstSeenTs, last_seen_ts AS lastSeenTs,
             restored_ts AS restoredTs, active
      FROM accessibility_outages
      WHERE first_seen_ts >= ? OR restored_ts IS NULL OR restored_ts >= ?
      ORDER BY first_seen_ts DESC
    `)
    .all(sinceTs, sinceTs)
    .map((row) => ({
      ...row,
      lines: row.lines
        ? String(row.lines)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      active: row.active === 1,
    }));
}

// --- Reads (the substrate the detectors will build on) ---

function getRecentBusObservations(route, sinceTs) {
  return getDb()
    .prepare(`
      SELECT ts, route, trip_id AS tripId, vehicle_id AS vehicleId, lat, lon, bearing, speed, vehicle_ts AS vehicleTs
      FROM bus_observations
      WHERE route = ? AND ts >= ?
      ORDER BY ts
    `)
    .all(String(route), sinceTs);
}

// Most recent observation ts for a route (epoch ms), or null if never seen.
// Thin-gap firings backdate their disruption ts to the last moment a bus was
// actually observed, not the cron tick that noticed.
function getLastBusObservationTs(route) {
  const row = getDb()
    .prepare('SELECT MAX(ts) AS ts FROM bus_observations WHERE route = ?')
    .get(String(route));
  return row?.ts ?? null;
}

// Distinct bus routes with at least one observation since `sinceTs`. Powers
// pulse's cold-start grace: a route with zero observations across the whole
// grace window is service-not-yet-started, not a blackout.
function getDistinctBusRoutesSince(sinceTs) {
  return new Set(
    getDb()
      .prepare('SELECT DISTINCT route FROM bus_observations WHERE ts >= ?')
      .all(sinceTs)
      .map((r) => String(r.route)),
  );
}

// Count of distinct observation snapshots (distinct ts) across all routes since
// `sinceTs`. A near-zero count means the observe loop has stalled — the thin-gap
// / pulse health gate bails out rather than fanning one upstream outage into a
// flood of false-positive per-route posts.
function countDistinctBusObservationTs(sinceTs) {
  const row = getDb()
    .prepare('SELECT COUNT(DISTINCT ts) AS n FROM bus_observations WHERE ts >= ?')
    .get(sinceTs);
  return row?.n ?? 0;
}

// All routes, newest-window-first by ts. Feeds the detect→post bins, which
// reduce to the latest fix per vehicle for detection and keep the full window
// for parked-bus detection — no extra feed fetch (the observe loop keeps this
// fresh within 30s).
function getRecentBusObservationsAll(sinceTs) {
  return getDb()
    .prepare(`
      SELECT ts, route, trip_id AS tripId, vehicle_id AS vehicleId, label, lat, lon, bearing, speed, occupancy, vehicle_ts AS vehicleTs
      FROM bus_observations
      WHERE ts >= ?
      ORDER BY ts
    `)
    .all(sinceTs);
}

function getRecentBusTripStatuses(sinceTs) {
  return getDb()
    .prepare(`
      SELECT ts, trip_id AS tripId, route, vehicle_id AS vehicleId, label,
             trip_relationship AS tripRelationship, start_date AS startDate,
             start_time AS startTime, stop_count AS stopCount,
             first_stop_sequence AS firstStopSequence, first_stop_id AS firstStopId,
             first_arrival_time AS firstArrivalTime, first_arrival_sched AS firstArrivalScheduledTime,
             last_stop_sequence AS lastStopSequence, last_stop_id AS lastStopId,
             last_arrival_time AS lastArrivalTime, last_arrival_sched AS lastArrivalScheduledTime,
             feed_ts AS feedTs
      FROM bus_trip_status
      WHERE ts >= ?
      ORDER BY ts
    `)
    .all(sinceTs);
}

function getRecentRailObservations(line, sinceTs) {
  return getDb()
    .prepare(`
      SELECT ts, train_id AS trainId, line, direction, destination, lat, lon, delay_sec AS delaySec, event_ts AS eventTs
      FROM rail_observations
      WHERE line = ? AND ts >= ? AND lat IS NOT NULL AND lon IS NOT NULL
      ORDER BY ts
    `)
    .all(String(line), sinceTs);
}

function getRecentRailObservationsAll(sinceTs) {
  return getDb()
    .prepare(`
      SELECT ts, train_id AS trainId, line, direction, destination, lat, lon, delay_sec AS delaySec, event_ts AS eventTs
      FROM rail_observations
      WHERE ts >= ? AND lat IS NOT NULL AND lon IS NOT NULL
      ORDER BY ts
    `)
    .all(sinceTs);
}

// --- Rail pulse debounce state (port of cta-insights pulse_state) ---

function getPulseState(line, direction) {
  return (
    getDb()
      .prepare('SELECT * FROM pulse_state WHERE line = ? AND direction = ?')
      .get(line, direction) || null
  );
}

function listPulseStateForLine(line) {
  return getDb().prepare('SELECT * FROM pulse_state WHERE line = ?').all(line);
}

function upsertPulseState({
  line,
  direction,
  runLoFt,
  runHiFt,
  fromStation,
  toStation,
  startedTs,
  lastSeenTs,
  consecutiveTicks,
  clearTicks,
  postedCooldownKey,
  activePostUri = null,
  activePostTs = null,
  clearStartedTs = null,
}) {
  getDb()
    .prepare(`
      INSERT INTO pulse_state
        (line, direction, run_lo_ft, run_hi_ft, from_station, to_station,
         started_ts, last_seen_ts, consecutive_ticks, clear_ticks, clear_started_ts,
         posted_cooldown_key, active_post_uri, active_post_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(line, direction) DO UPDATE SET
        run_lo_ft = excluded.run_lo_ft,
        run_hi_ft = excluded.run_hi_ft,
        from_station = excluded.from_station,
        to_station = excluded.to_station,
        started_ts = excluded.started_ts,
        last_seen_ts = excluded.last_seen_ts,
        consecutive_ticks = excluded.consecutive_ticks,
        clear_ticks = excluded.clear_ticks,
        clear_started_ts = excluded.clear_started_ts,
        posted_cooldown_key = excluded.posted_cooldown_key,
        active_post_uri = excluded.active_post_uri,
        active_post_ts = excluded.active_post_ts
    `)
    .run(
      String(line),
      String(direction),
      runLoFt == null ? null : Math.round(runLoFt),
      runHiFt == null ? null : Math.round(runHiFt),
      fromStation || null,
      toStation || null,
      startedTs || null,
      lastSeenTs || null,
      consecutiveTicks || 0,
      clearTicks || 0,
      clearStartedTs || null,
      postedCooldownKey || null,
      activePostUri || null,
      activePostTs || null,
    );
}

function clearPulseState(line, direction) {
  getDb().prepare('DELETE FROM pulse_state WHERE line = ? AND direction = ?').run(line, direction);
}

function getRecentStreetcarObservations(sinceTs) {
  return getDb()
    .prepare(`
      SELECT ts, vehicle_id AS vehicleId, label, line, direction, trip_id AS tripId,
             lat, lon, event_ts AS eventTs
      FROM streetcar_observations
      WHERE ts >= ? AND lat IS NOT NULL AND lon IS NOT NULL
      ORDER BY ts
    `)
    .all(sinceTs);
}

function getRailArrivals(line, sinceTs, { realtimeOnly = false } = {}) {
  return getDb()
    .prepare(`
      SELECT ts, is_realtime AS isRealtime, train_id AS trainId, line, direction, destination,
             station, waiting_seconds AS waitingSeconds, next_arrival_clock AS nextArrivalClock, event_ts AS eventTs
      FROM rail_arrivals
      WHERE line = ? AND ts >= ? ${realtimeOnly ? 'AND is_realtime = 1' : ''}
      ORDER BY ts
    `)
    .all(String(line), sinceTs);
}

// Distinct poll timestamps across a table since `sinceTs` — the feed-health
// substrate (gaps here mean ingestion stalled). `table` is validated against an
// allowlist so it can't be injected.
const SNAPSHOT_TABLES = new Set([
  'bus_observations',
  'bus_trip_status',
  'bus_trip_updates',
  'rail_observations',
  'rail_arrivals',
  'streetcar_observations',
]);
function getSnapshotTimestamps(table, sinceTs) {
  if (!SNAPSHOT_TABLES.has(table)) throw new Error(`unknown table ${table}`);
  return getDb()
    .prepare(`SELECT DISTINCT ts FROM ${table} WHERE ts >= ? ORDER BY ts`)
    .all(sinceTs)
    .map((r) => r.ts);
}

function rolloffOldObservations(now = Date.now()) {
  const cutoff = now - ROLLOFF_MS;
  const d = getDb();
  for (const t of SNAPSHOT_TABLES) {
    d.prepare(`DELETE FROM ${t} WHERE ts < ?`).run(cutoff);
  }
  d.prepare('DELETE FROM accessibility_outages WHERE active = 0 AND restored_ts < ?').run(
    now - ACCESSIBILITY_ROLLOFF_MS,
  );
}

// Close + reset the singleton (tests point MARTA_HISTORY_DB_PATH at a temp file
// then call this to release the handle).
function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = {
  getDb,
  ROLLOFF_MS,
  ACCESSIBILITY_ROLLOFF_MS,
  ACCESSIBILITY_CLEAR_TICKS,
  recordBusObservations,
  recordBusTripUpdates,
  recordRailObservations,
  recordRailArrivals,
  recordRailSnapshot,
  recordStreetcarObservations,
  upsertAccessibilityOutages,
  updateAccessibilityStation,
  reconcileAccessibilityOutages,
  getAccessibilityOutages,
  getRecentBusObservations,
  getRecentBusObservationsAll,
  getLastBusObservationTs,
  countDistinctBusObservationTs,
  getDistinctBusRoutesSince,
  getRecentBusTripStatuses,
  getRecentRailObservations,
  getRecentRailObservationsAll,
  getPulseState,
  listPulseStateForLine,
  upsertPulseState,
  clearPulseState,
  getRecentStreetcarObservations,
  getRailArrivals,
  getSnapshotTimestamps,
  rolloffOldObservations,
  closeDb,
};
