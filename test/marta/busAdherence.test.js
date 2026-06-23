const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH = Path.join(Os.tmpdir(), `marta-sched-test-${process.pid}-${Date.now()}.sqlite`);
process.env.MARTA_SCHEDULE_DB_PATH = DB_PATH;

const {
  deviationFromStops,
  atlantaSecondsOfDay,
  scheduleDeviationMin,
  busDeviationsByVid,
  _resetSchedDb,
} = require('../../src/marta/bus/adherence');

// A short east-west two-stop trip near downtown Atlanta. Its scheduled time at
// the projected point is what a live bus is measured against.
function seedTrip(tripId, schedSecAtBothStops) {
  const db = new Database(DB_PATH);
  db.exec(
    'CREATE TABLE IF NOT EXISTS sched_stops (trip_id TEXT, seq INTEGER, lat REAL, lon REAL, sched_sec INTEGER)',
  );
  db.prepare('DELETE FROM sched_stops WHERE trip_id = ?').run(tripId);
  const ins = db.prepare(
    'INSERT INTO sched_stops (trip_id, seq, lat, lon, sched_sec) VALUES (?, ?, ?, ?, ?)',
  );
  ins.run(tripId, 1, 33.75, -84.4, schedSecAtBothStops);
  ins.run(tripId, 2, 33.75, -84.39, schedSecAtBothStops);
  db.close();
  _resetSchedDb();
}

test.after(() => {
  _resetSchedDb();
  try {
    Fs.unlinkSync(DB_PATH);
  } catch {
    /* best effort */
  }
});

test('deviationFromStops interpolates the scheduled time and reports off-path distance', () => {
  const stops = [
    { lat: 33.75, lon: -84.4, schedSec: 36000 },
    { lat: 33.75, lon: -84.39, schedSec: 36120 },
  ];
  // A point right on the midpoint of the segment.
  const mid = deviationFromStops(stops, 33.75, -84.395);
  assert.ok(Math.abs(mid.schedSec - 36060) < 2, 'midpoint scheduled time interpolates to ~36060');
  assert.ok(mid.distFt < 50, 'on-path point has tiny off-path distance');
  // Fewer than two stops → null.
  assert.equal(deviationFromStops([{ lat: 1, lon: 1, schedSec: 0 }], 1, 1), null);
});

test('atlantaSecondsOfDay returns a valid seconds-of-day', () => {
  const s = atlantaSecondsOfDay(new Date());
  assert.ok(Number.isInteger(s) && s >= 0 && s < 86400);
});

test('scheduleDeviationMin reads a bus as late/early, and guards off-route + absurd', () => {
  const now = new Date();
  const nowSec = atlantaSecondsOfDay(now);
  // Schedule says the bus should be at this point 5 minutes ago → 5 min late.
  seedTrip('T1', nowSec - 300);
  const late = scheduleDeviationMin({ tripId: 'T1', lat: 33.75, lon: -84.395 }, now);
  assert.ok(Math.abs(late - 5) < 0.2, `~5 min late, got ${late}`);

  // A bus far off the trip's path is omitted (off-route guard).
  assert.equal(scheduleDeviationMin({ tripId: 'T1', lat: 34.2, lon: -84.395 }, now), null);

  // An absurd 50-min deviation (recycled-trip-id style) is capped out → null.
  seedTrip('T2', nowSec - 3000);
  assert.equal(scheduleDeviationMin({ tripId: 'T2', lat: 33.75, lon: -84.395 }, now), null);

  // Unknown trip / missing position → null.
  assert.equal(scheduleDeviationMin({ tripId: 'nope', lat: 33.75, lon: -84.395 }, now), null);
  assert.equal(scheduleDeviationMin({ tripId: 'T1', lat: null, lon: null }, now), null);
});

test('busDeviationsByVid uses each bus latest obs and omits unplaceable ones', () => {
  const now = Date.now();
  const nowSec = atlantaSecondsOfDay(new Date(now));
  seedTrip('T1', nowSec - 120); // 2 min late at the projected point
  const obs = [
    { vehicleId: 'A', tripId: 'T1', lat: 33.75, lon: -84.398, ts: now - 60_000 },
    { vehicleId: 'A', tripId: 'T1', lat: 33.75, lon: -84.395, ts: now }, // newest wins
    { vehicleId: 'B', tripId: 'T1', lat: 34.2, lon: -84.395, ts: now }, // off-route → omitted
  ];
  const devs = busDeviationsByVid(obs, now);
  assert.ok(devs.has('A'));
  assert.ok(Math.abs(devs.get('A') - 2) < 0.3, `A ~2 min late, got ${devs.get('A')}`);
  assert.equal(devs.has('B'), false);
});
