const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const { loadGtfs, parseCsv, routeMode } = require('../../src/marta/gtfs');
const { decodeFeed, parseVehiclePosition, parseTripUpdate } = require('../../src/marta/bus/api');

const FIX = Path.join(__dirname, 'fixtures');
const gtfs = loadGtfs(Path.join(FIX, 'gtfs'));
const vehicles = decodeFeed(Fs.readFileSync(Path.join(FIX, 'bus-vehiclepositions.pb')))
  .entity.map(parseVehiclePosition)
  .filter(Boolean);
const tripUpdates = decodeFeed(Fs.readFileSync(Path.join(FIX, 'bus-tripupdates.pb')))
  .entity.map(parseTripUpdate)
  .filter(Boolean);

test('CSV parser handles the GTFS files', () => {
  const routes = parseCsv(Fs.readFileSync(Path.join(FIX, 'gtfs', 'routes.txt'), 'utf8'));
  assert.ok(routes.length > 50);
  assert.deepEqual(Object.keys(routes[0]).slice(0, 3), [
    'route_id',
    'agency_id',
    'route_short_name',
  ]);
});

test('MARTA modes are classified from route_type', () => {
  const byMode = {};
  for (const r of gtfs.routes) byMode[routeMode(r)] = (byMode[routeMode(r)] || 0) + 1;
  assert.equal(byMode.rail, 4, 'Red/Gold/Blue/Green');
  assert.equal(byMode.streetcar, 1, 'Atlanta Streetcar');
  assert.ok(byMode.bus > 50, 'dozens of bus routes');
});

test('every realtime vehicle resolves to a static route via trip_id', () => {
  for (const v of vehicles) {
    const res = gtfs.resolveRoute({ tripId: v.tripId, realtimeRouteId: v.realtimeRouteId });
    assert.ok(res, `vehicle trip ${v.tripId} resolves`);
    assert.equal(res.via, 'tripId', 'join key is trip_id, not the public route number');
  }
});

test('realtime public route number normalizes to static route_short_name', () => {
  for (const v of vehicles) {
    const res = gtfs.resolveRoute({ tripId: v.tripId, realtimeRouteId: v.realtimeRouteId });
    // The realtime routeId IS the static route_short_name; the internal
    // route_id differs (e.g. "20" ⇄ route_id 26915).
    assert.equal(res.route.route_short_name, v.realtimeRouteId);
    assert.ok(res.shortNameMatches, `route ${v.realtimeRouteId} agrees with static`);
    assert.notEqual(
      res.route.route_id,
      v.realtimeRouteId,
      'internal route_id is not the public number',
    );
  }
});

test('canonical direction_id comes from trips.txt and is binary 0/1', () => {
  // The realtime feed reports junk directionId; the static trip is authoritative.
  let checked = 0;
  for (const v of vehicles) {
    const dir = gtfs.directionIdForTrip(v.tripId);
    if (dir == null) continue;
    assert.ok(dir === '0' || dir === '1', `direction_id ${dir} is binary`);
    checked++;
  }
  assert.ok(checked > 0, 'resolved direction for at least one vehicle');
});

test('trip updates resolve to routes and their stops exist in static GTFS', () => {
  for (const u of tripUpdates) {
    const res = gtfs.resolveRoute({ tripId: u.tripId, realtimeRouteId: u.realtimeRouteId });
    assert.ok(res, `trip update ${u.tripId} resolves to a route`);
    for (const s of u.stopUpdates) {
      assert.ok(gtfs.stopsById.has(s.stopId), `stop ${s.stopId} present in static GTFS`);
    }
  }
});
