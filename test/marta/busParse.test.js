const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const { decodeFeed, parseVehiclePosition, parseTripUpdate } = require('../../src/marta/bus/api');

const FIX = Path.join(__dirname, 'fixtures');
const vpFeed = decodeFeed(Fs.readFileSync(Path.join(FIX, 'bus-vehiclepositions.pb')));
const tuFeed = decodeFeed(Fs.readFileSync(Path.join(FIX, 'bus-tripupdates.pb')));
const vehicles = vpFeed.entity.map(parseVehiclePosition).filter(Boolean);
const tripUpdates = tuFeed.entity.map(parseTripUpdate).filter(Boolean);

test('VehiclePositions decode into normalized vehicles', () => {
  assert.ok(vehicles.length > 0, 'fixture has vehicles');
  for (const v of vehicles) {
    assert.equal(typeof v.tripId, 'string');
    assert.equal(typeof v.realtimeRouteId, 'string');
    assert.ok(Number.isFinite(v.lat) && Number.isFinite(v.lon), 'has position');
    assert.ok(Number.isFinite(v.ts), 'has timestamp');
    // speed/bearing are optional — when present they must be numbers, never the
    // protobuf prototype-default leaking through.
    if (v.speed != null) assert.ok(Number.isFinite(v.speed));
    if (v.bearing != null) assert.ok(Number.isFinite(v.bearing));
  }
});

test('speed is reported for some but not all vehicles (m/s)', () => {
  const withSpeed = vehicles.filter((v) => v.speed != null);
  assert.ok(withSpeed.length > 0, 'at least one vehicle reports speed');
  assert.ok(
    withSpeed.length < vehicles.length,
    'speed is not universal — detectors must tolerate null',
  );
  // Plausible bus speeds in m/s (0–30 ≈ 0–67 mph).
  for (const v of withSpeed)
    assert.ok(v.speed >= 0 && v.speed < 40, `speed ${v.speed} m/s plausible`);
});

test('realtime directionId is NOT used (feed value is unreliable)', () => {
  // Guard the contract: parseVehiclePosition must not surface directionId, so
  // nothing downstream is tempted to trust it. Canonical direction comes from
  // trips.txt (see gtfsJoin test).
  assert.ok(!('directionId' in vehicles[0]), 'directionId is intentionally omitted');
});

test('TripUpdates decode with scheduled + predicted stop times', () => {
  assert.ok(tripUpdates.length > 0, 'fixture has trip updates');
  let sawDeviation = false;
  for (const u of tripUpdates) {
    assert.equal(typeof u.tripId, 'string');
    assert.equal(typeof u.realtimeRouteId, 'string');
    assert.ok(Array.isArray(u.stopUpdates) && u.stopUpdates.length > 0);
    for (const s of u.stopUpdates) {
      assert.equal(typeof s.stopId, 'string');
      assert.ok(Number.isInteger(s.stopSequence));
      if (s.arrivalTime != null && s.arrivalScheduledTime != null) {
        assert.equal(s.scheduleDeviationSec, s.arrivalTime - s.arrivalScheduledTime);
        sawDeviation = true;
      }
    }
  }
  assert.ok(sawDeviation, 'at least one stop carries predicted+scheduled (adherence signal)');
});
