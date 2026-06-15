const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');

// Point storage at a throwaway DB BEFORE requiring it (path is read on first
// getDb()), so the round-trip test below doesn't touch the real history DB.
const TMP_DB = Path.join(Os.tmpdir(), `marta-streetcar-test-${process.pid}-${Date.now()}.sqlite`);
process.env.MARTA_HISTORY_DB_PATH = TMP_DB;

const storage = require('../../src/marta/storage');
const {
  parseStreetcarVehicles,
  parseLastUpdate,
  STREETCAR_LINE,
} = require('../../src/marta/streetcar/api');

const data = JSON.parse(
  Fs.readFileSync(Path.join(__dirname, 'fixtures', 'streetcar-otp.json'), 'utf8'),
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

test('parses one record per live streetcar, skipping empty patterns', () => {
  const vehicles = parseStreetcarVehicles(data, 1_781_000_000_000);
  assert.equal(vehicles.length, 2); // the directionId:1:01 pattern has no vehicles

  const byId = new Map(vehicles.map((v) => [v.vehicleId, v]));
  const v1 = byId.get('MARTA:1001');
  assert.ok(v1);
  assert.equal(v1.label, '1001');
  assert.equal(v1.line, STREETCAR_LINE);
  assert.equal(v1.direction, '1');
  assert.equal(v1.tripId, 'MARTA:10811992');
  assert.equal(v1.polledAt, 1_781_000_000_000);
  assert.ok(Number.isFinite(v1.lat) && Number.isFinite(v1.lon));
  // Downtown Atlanta streetcar loop sanity.
  assert.ok(v1.lat > 33.74 && v1.lat < 33.77 && v1.lon > -84.4 && v1.lon < -84.37);
  // OTP doesn't populate speed/heading for the streetcar; carried as null.
  assert.equal(v1.speed, null);
  assert.equal(v1.heading, null);
  // lastUpdate (with offset) resolves to an epoch within the day.
  assert.equal(v1.eventTs, Date.parse('2026-06-15T19:08:53-04:00'));

  assert.equal(byId.get('MARTA:1002').direction, '0');
});

test('parseLastUpdate honors the offset and rejects empties', () => {
  assert.equal(parseLastUpdate('2026-06-15T19:08:53-04:00'), Date.parse('2026-06-15T23:08:53Z'));
  assert.equal(parseLastUpdate(null), null);
  assert.equal(parseLastUpdate(''), null);
});

test('streetcar observations round-trip and roll off', () => {
  const vehicles = parseStreetcarVehicles(data, Date.now());
  const now = Date.now();
  storage.recordStreetcarObservations(vehicles, now);
  const rows = storage.getRecentStreetcarObservations(now - 60_000);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].line, STREETCAR_LINE);
  assert.ok(rows.every((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon)));
  assert.ok(rows.some((r) => r.vehicleId === 'MARTA:1001' && r.label === '1001'));

  // Older than the 7-day window: rolloff drops it.
  const old = now - 30 * 24 * 60 * 60 * 1000;
  storage.recordStreetcarObservations(vehicles, old);
  storage.rolloffOldObservations(now);
  assert.equal(storage.getRecentStreetcarObservations(old - 60_000).length, 2); // only the fresh pair
});
