const test = require('node:test');
const assert = require('node:assert/strict');
const { titleCaseStopName, stopsNearShape } = require('../../src/marta/bus/stops');

test('MARTA uppercase stop names are normalized for posts', () => {
  assert.equal(titleCaseStopName('CLIFTON RD NE @ CANDLER RD'), 'Clifton Rd NE @ Candler Rd');
  assert.equal(titleCaseStopName('MARTA ARTS CENTER STATION'), 'MARTA Arts Center Station');
});

test('stopsNearShape attaches a local bearing that tracks the route heading', () => {
  // An L-shaped shape: due north for the first leg, then due east. The
  // FT_PER_DEG scaling makes 0.001° steps land on a regular along-route grid.
  const points = [];
  for (let i = 0; i <= 10; i++) points.push({ lat: 33 + 0.001 * i, lon: -84, distFt: i * 365 });
  const lastN = points.at(-1);
  for (let i = 1; i <= 10; i++)
    points.push({ lat: lastN.lat, lon: -84 + 0.001 * i, distFt: lastN.distFt + i * 306 });
  const shape = { points, lengthFt: points.at(-1).distFt };

  const gtfs = {
    stops: [
      { stop_id: 'n', stop_name: 'NORTH LEG', stop_lat: 33.005, stop_lon: -84 }, // on the N leg
      { stop_id: 'e', stop_name: 'EAST LEG', stop_lat: lastN.lat, stop_lon: -83.995 }, // on the E leg
    ],
  };
  const stops = stopsNearShape(gtfs, shape, 0, shape.lengthFt);
  const north = stops.find((s) => s.stopName === 'North Leg');
  const east = stops.find((s) => s.stopName === 'East Leg');
  assert.ok(north && east);
  // Each stop's bearing follows its own leg, not one global heading: ~0° (north)
  // vs ~90° (east).
  assert.ok(Math.abs(north.bearing - 0) < 15 || Math.abs(north.bearing - 360) < 15);
  assert.ok(Math.abs(east.bearing - 90) < 15);
});
