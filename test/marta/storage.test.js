const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');

// Point storage at a throwaway DB BEFORE requiring it (the path is read on first
// getDb()). Each run gets a unique file so tests never collide.
const TMP_DB = Path.join(Os.tmpdir(), `marta-storage-test-${process.pid}-${Date.now()}.sqlite`);
process.env.MARTA_HISTORY_DB_PATH = TMP_DB;

const storage = require('../../src/marta/storage');
const busApi = require('../../src/marta/bus/api');
const railApi = require('../../src/marta/rail/api');

const FIX = Path.join(__dirname, 'fixtures');
const vehicles = busApi
  .decodeFeed(Fs.readFileSync(Path.join(FIX, 'bus-vehiclepositions.pb')))
  .entity.map(busApi.parseVehiclePosition)
  .filter(Boolean);
const tripUpdates = busApi
  .decodeFeed(Fs.readFileSync(Path.join(FIX, 'bus-tripupdates.pb')))
  .entity.map(busApi.parseTripUpdate)
  .filter(Boolean);
const railParsed = railApi.parseTrainData(
  JSON.parse(Fs.readFileSync(Path.join(FIX, 'rail-traindata.json'), 'utf8')),
  1_781_000_000_000,
);

test.after(() => {
  storage.closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try {
      Fs.unlinkSync(TMP_DB + ext);
    } catch {
      /* best effort */
    }
  }
});

// Well outside the 7-day retention window so the rolloff test can age it out.
const T0 = Date.now() - 30 * 24 * 60 * 60 * 1000;

test('bus observations round-trip, preserving optional speed', () => {
  storage.recordBusObservations(vehicles, T0);
  const route20 = storage.getRecentBusObservations('20', T0 - 1);
  assert.ok(route20.length > 0, 'route 20 has observations');
  for (const r of route20) {
    assert.equal(r.route, '20');
    assert.ok(Number.isFinite(r.lat) && Number.isFinite(r.lon));
  }
  // Speed is present on some, absent (null) on others — both must survive.
  const all = vehicles.filter((v) => v.realtimeRouteId);
  const stored = [];
  for (const route of new Set(all.map((v) => v.realtimeRouteId))) {
    stored.push(...storage.getRecentBusObservations(route, T0 - 1));
  }
  assert.equal(stored.length, all.length, 'every routed vehicle stored');
  assert.ok(
    stored.some((r) => r.speed != null),
    'some rows kept a speed',
  );
  assert.ok(
    stored.some((r) => r.speed == null),
    'some rows kept null speed',
  );
});

test('bus trip updates flatten to one row per stop', () => {
  storage.recordBusTripUpdates(tripUpdates, T0);
  const expectedRows = tripUpdates.reduce((n, tu) => n + Math.max(1, tu.stopUpdates.length), 0);
  const got = storage
    .getDb()
    .prepare('SELECT COUNT(*) AS n FROM bus_trip_updates WHERE ts = ?')
    .get(T0);
  assert.equal(got.n, expectedRows);
  // scheduleDeviationSec round-trips for stops carrying predicted+scheduled.
  const dev = storage
    .getDb()
    .prepare('SELECT COUNT(*) AS n FROM bus_trip_updates WHERE schedule_deviation_sec IS NOT NULL')
    .get();
  assert.ok(dev.n > 0, 'adherence stored for some stops');
});

test('rail snapshot stores tracked-train positions and all arrivals', () => {
  storage.recordRailSnapshot(railParsed, T0);
  // Tracked-train positions per line.
  let totalObs = 0;
  for (const line of railApi.LINES) {
    const obs = storage.getRecentRailObservations(line, T0 - 1);
    totalObs += obs.length;
    for (const o of obs) {
      assert.equal(o.line, line);
      assert.ok(Number.isFinite(o.lat) && Number.isFinite(o.lon), 'position stored');
    }
  }
  assert.equal(totalObs, railParsed.trains.length, 'one row per tracked train');

  // Arrivals include scheduled (no-train) rows.
  let sched = 0;
  let realtime = 0;
  for (const line of railApi.LINES) {
    for (const a of storage.getRailArrivals(line, T0 - 1)) {
      if (a.isRealtime) realtime++;
      else sched++;
    }
  }
  assert.equal(sched, railParsed.scheduled.length, 'scheduled rows stored');
  assert.ok(realtime > 0, 'realtime arrival rows stored');
});

test('snapshot timestamps and rolloff', () => {
  // A fresh observation now, plus the T0 (well-aged) rows already inserted.
  const now = Date.now();
  storage.recordRailSnapshot(railParsed, now);
  const tsBefore = storage.getSnapshotTimestamps('rail_observations', 0);
  assert.ok(tsBefore.includes(T0) && tsBefore.includes(now), 'both ticks present');

  storage.rolloffOldObservations(now);
  const tsAfter = storage.getSnapshotTimestamps('rail_observations', 0);
  assert.ok(!tsAfter.includes(T0), 'aged-out tick removed');
  assert.ok(tsAfter.includes(now), 'fresh tick retained');
});

test('getSnapshotTimestamps rejects an unknown table', () => {
  assert.throws(() => storage.getSnapshotTimestamps('drop_me; --', 0), /unknown table/);
});
