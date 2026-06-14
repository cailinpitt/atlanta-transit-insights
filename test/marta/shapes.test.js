const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const { loadGtfs } = require('../../src/marta/gtfs');
const {
  loadShapes,
  projectToShape,
  projectObservation,
  MAX_OFFROUTE_FT,
} = require('../../src/marta/bus/shapes');
const { decodeFeed, parseVehiclePosition } = require('../../src/marta/bus/api');

const FIX = Path.join(__dirname, 'fixtures', 'gtfs');
const gtfs = loadGtfs(FIX);
const shapes = loadShapes(FIX);
const vehicles = decodeFeed(
  Fs.readFileSync(Path.join(__dirname, 'fixtures', 'bus-vehiclepositions.pb')),
)
  .entity.map(parseVehiclePosition)
  .filter(Boolean);

test('shapes load with cumulative feet, ascending along each shape', () => {
  assert.ok(shapes.size > 0);
  for (const shape of shapes.values()) {
    assert.ok(shape.points.length >= 2);
    assert.equal(shape.points[0].distFt, 0, 'shapes start at 0 ft');
    for (let i = 1; i < shape.points.length; i++) {
      assert.ok(shape.points[i].distFt >= shape.points[i - 1].distFt, 'distFt non-decreasing');
    }
    assert.ok(shape.lengthFt > 1000, 'a real route is at least a few hundred meters');
  }
});

test('projecting a shape vertex returns ~0 offset and that vertex distance', () => {
  const shape = shapes.values().next().value;
  const mid = shape.points[Math.floor(shape.points.length / 2)];
  const proj = projectToShape(shape, mid.lat, mid.lon);
  assert.ok(proj.offsetFt < 5, 'a point on the line projects with ~0 offset');
  assert.ok(Math.abs(proj.distFt - mid.distFt) < 50, 'distFt matches the vertex');
});

test('a point off the end clamps within [0, lengthFt]', () => {
  const shape = shapes.values().next().value;
  // Far north of Atlanta — should clamp to an endpoint, not exceed the shape.
  const proj = projectToShape(shape, 40, -84.4);
  assert.ok(proj.distFt >= 0 && proj.distFt <= shape.lengthFt);
});

test('real vehicles project onto their trip shape near the route', () => {
  let resolved = 0;
  let onRoute = 0;
  for (const v of vehicles) {
    const trip = gtfs.tripsById.get(v.tripId);
    assert.ok(trip, `trip ${v.tripId} present in fixture GTFS`);
    assert.ok(shapes.has(trip.shape_id), `shape ${trip.shape_id} present`);
    resolved++;
    const proj = projectObservation(v, { gtfs, shapes });
    if (proj) {
      onRoute++;
      assert.ok(proj.offsetFt <= MAX_OFFROUTE_FT);
      assert.ok(proj.distFt >= 0 && proj.distFt <= shapes.get(proj.shapeId).lengthFt);
      assert.equal(proj.shapeId, trip.shape_id);
    }
  }
  assert.equal(resolved, vehicles.length, 'every vehicle resolves trip→shape');
  // Live buses sit on their route; allow a couple off-route GPS outliers.
  assert.ok(
    onRoute >= vehicles.length * 0.7,
    `most vehicles on-route (${onRoute}/${vehicles.length})`,
  );
});

test('projectObservation returns null for an unknown trip or missing position', () => {
  assert.equal(
    projectObservation({ tripId: 'nope', lat: 33.7, lon: -84.4 }, { gtfs, shapes }),
    null,
  );
  const v = vehicles[0];
  assert.equal(
    projectObservation({ tripId: v.tripId, lat: null, lon: null }, { gtfs, shapes }),
    null,
  );
});
