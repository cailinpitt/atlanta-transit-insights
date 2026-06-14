const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLineGeometry, projectTrain } = require('../../src/marta/rail/lines');

// A straight east-west polyline at fixed latitude with explicit cumulative
// distFt (projection interpolates the STORED distFt, so geometry need not match).
function straightShape(distPerVertex, n, { lat = 33.75, lon0 = -84.4, dlon = 0.01 } = {}) {
  const points = [];
  for (let i = 0; i < n; i++) points.push({ lat, lon: lon0 + i * dlon, distFt: i * distPerVertex });
  return { points, lengthFt: (n - 1) * distPerVertex };
}

const shapes = new Map([
  ['redShort', straightShape(500, 6)], // length 2500
  ['redLong', straightShape(600, 20)], // length 11400 (longest for RED)
  ['blue', straightShape(700, 10)], // length 6300
  ['bus', straightShape(100, 5)],
]);
const gtfs = {
  routes: [
    { route_id: 'rRED', route_short_name: 'RED', route_type: '1' },
    { route_id: 'rBLUE', route_short_name: 'BLUE', route_type: '1' },
    { route_id: 'rBUS', route_short_name: '20', route_type: '3' },
  ],
  trips: [
    { route_id: 'rRED', shape_id: 'redShort' },
    { route_id: 'rRED', shape_id: 'redLong' },
    { route_id: 'rBLUE', shape_id: 'blue' },
    { route_id: 'rBUS', shape_id: 'bus' },
  ],
};

const geom = buildLineGeometry(gtfs, shapes);

test('buildLineGeometry picks the longest shape per rail line, skips non-rail', () => {
  assert.equal(geom.get('RED').shapeId, 'redLong', 'longest RED shape wins');
  assert.equal(geom.get('RED').lengthFt, 11400);
  assert.equal(geom.get('BLUE').shapeId, 'blue');
  assert.ok(!geom.has('20'), 'bus route (route_type 3) excluded');
});

test('projectTrain maps a position to along-line distFt', () => {
  // A train exactly at vertex 5 of redLong → distFt 3000, ~0 offset.
  const v5 = geom.get('RED').points[5];
  const p = projectTrain(geom, { line: 'RED', lat: v5.lat, lon: v5.lon });
  assert.ok(p);
  assert.ok(Math.abs(p.distFt - 3000) < 50);
  assert.ok(p.offsetFt < 5);
  assert.equal(p.lengthFt, 11400);
});

test('projectTrain rejects unknown line, off-route, and missing position', () => {
  const v5 = geom.get('RED').points[5];
  assert.equal(projectTrain(geom, { line: 'PURPLE', lat: v5.lat, lon: v5.lon }), null);
  assert.equal(projectTrain(geom, { line: 'RED', lat: 34.5, lon: v5.lon }), null, 'far off-route');
  assert.equal(projectTrain(geom, { line: 'RED', lat: null, lon: null }), null);
});
