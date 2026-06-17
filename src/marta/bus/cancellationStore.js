// Dedup ledger for the MARTA bus-cancellation rollup (bin/marta/bus/cancellations.js).
//
// The hourly rollup must post each canceled trip exactly once even though the
// trip appears in many snapshots and the read window overlaps between runs. This
// ledger records every distinct (trip_id, service_date) we've seen as CANCELED
// and stamps when it was reported, so a run posts only the not-yet-reported set.
//
// Owns its own table on the shared MARTA SQLite file (storage.getDb()), the same
// pattern as src/marta/alert/store.js. Keyed on (trip_id, service_date): the same
// trip_id recurs on later service days, so the date is part of the identity.
const storage = require('../storage');

// Ledger rows older than this are pruned each run — the rollup only ever looks a
// little over an hour back, so a few days of history is plenty for dedup.
const PRUNE_MS = 5 * 24 * 60 * 60 * 1000;

let _initedDb = null;

function getDb() {
  const db = storage.getDb();
  if (_initedDb !== db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS bus_cancellations (
        trip_id TEXT NOT NULL,
        service_date TEXT NOT NULL,
        route TEXT,
        first_seen_ts INTEGER NOT NULL,
        reported_ts INTEGER,
        PRIMARY KEY (trip_id, service_date)
      );
      CREATE INDEX IF NOT EXISTS idx_bus_cancellations_reported
        ON bus_cancellations(reported_ts);
    `);
    _initedDb = db;
  }
  return db;
}

// Insert any not-yet-seen canceled trips (reported_ts left NULL). Existing rows
// are untouched, so first_seen_ts and any reported_ts are preserved.
function recordCanceledTrips(trips, now = Date.now()) {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO bus_cancellations
      (trip_id, service_date, route, first_seen_ts, reported_ts)
    VALUES (?, ?, ?, ?, NULL)
  `);
  const insertMany = getDb().transaction((rows) => {
    for (const t of rows) stmt.run(t.tripId, t.serviceDate, t.route ?? null, now);
  });
  insertMany(trips);
}

// Canceled trips recorded but not yet included in a posted digest.
function getUnreportedCanceledTrips() {
  return getDb()
    .prepare(`
      SELECT trip_id AS tripId, service_date AS serviceDate, route, first_seen_ts AS firstSeenTs
      FROM bus_cancellations
      WHERE reported_ts IS NULL
      ORDER BY first_seen_ts
    `)
    .all();
}

// Stamp the given (trip_id, service_date) pairs as reported.
function markCanceledReported(trips, now = Date.now()) {
  const stmt = getDb().prepare(`
    UPDATE bus_cancellations SET reported_ts = ?
    WHERE trip_id = ? AND service_date = ?
  `);
  const updateMany = getDb().transaction((rows) => {
    for (const t of rows) stmt.run(now, t.tripId, t.serviceDate);
  });
  updateMany(trips);
}

function pruneOldCancellations(now = Date.now()) {
  getDb()
    .prepare('DELETE FROM bus_cancellations WHERE first_seen_ts < ?')
    .run(now - PRUNE_MS);
}

module.exports = {
  recordCanceledTrips,
  getUnreportedCanceledTrips,
  markCanceledReported,
  pruneOldCancellations,
  PRUNE_MS,
};
