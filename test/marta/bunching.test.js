const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectAllBunching,
  detectBunching,
  assignBusNumbers,
  findParkedBusVids,
  STALE_MS,
} = require('../../src/marta/bus/bunching');

const NOW = 1_781_000_000_000;
// Default coords are co-located so the geo-consistency check passes; override
// `lat`/`lon` to exercise the projection-sanity rejection.
const veh = (distFt, id, over = {}) => ({
  shapeId: 'S1',
  distFt,
  route: '20',
  vehicleId: id,
  tmstmp: NOW,
  lat: 33.75,
  lon: -84.39,
  ...over,
});

test('two buses within the threshold form a bunch', () => {
  const bunches = detectAllBunching([veh(2000, 'a'), veh(2300, 'b')], NOW);
  assert.equal(bunches.length, 1);
  assert.equal(bunches[0].vehicles.length, 2);
  assert.equal(bunches[0].route, '20');
  assert.equal(bunches[0].maxGapFt, 300);
});

test('opposite-moving buses passing each other are not a bunch', () => {
  const bunches = detectAllBunching(
    [veh(2000, 'a', { motionSign: 1 }), veh(2300, 'b', { motionSign: -1 })],
    NOW,
  );
  assert.equal(bunches.length, 0);
});

test('buses beyond the threshold are not a bunch', () => {
  assert.deepEqual(detectAllBunching([veh(2000, 'a'), veh(3200, 'b')], NOW), []);
});

test('a cluster sitting in the start terminal is excluded', () => {
  // First member at 200 ft (< TERMINAL_DIST_FT 500).
  assert.deepEqual(detectAllBunching([veh(200, 'a'), veh(450, 'b')], NOW), []);
});

test('geographically impossible cluster is rejected (stale projection)', () => {
  // Close in distFt but ~7 mi apart on the ground → geoSpan ≫ distSpan + slack.
  const far = veh(2300, 'b', { lat: 33.85, lon: -84.39 });
  assert.deepEqual(detectAllBunching([veh(2000, 'a'), far], NOW), []);
});

test('stale vehicles are dropped', () => {
  const stale = veh(2300, 'b', { tmstmp: NOW - STALE_MS - 1 });
  assert.deepEqual(detectAllBunching([veh(2000, 'a'), stale], NOW), []);
});

test('three tight buses make one cluster, ranked above a pair', () => {
  const vehicles = [
    veh(2000, 'a'),
    veh(2300, 'b'),
    veh(2600, 'c'), // S1 cluster of 3
    { ...veh(5000, 'd'), shapeId: 'S2' },
    { ...veh(5300, 'e'), shapeId: 'S2' }, // S2 cluster of 2
  ];
  const bunches = detectAllBunching(vehicles, NOW);
  assert.equal(bunches.length, 2);
  assert.equal(bunches[0].vehicles.length, 3, 'bigger cluster ranked first');
  assert.equal(bunches[0].shapeId, 'S1');
  assert.equal(detectBunching(vehicles, NOW).vehicles.length, 3);
});

test('assignBusNumbers labels the lead bus (furthest along) as 1', () => {
  const labels = assignBusNumbers([veh(2000, 'a'), veh(2600, 'c'), veh(2300, 'b')]);
  assert.equal(labels.get('c'), 1, 'highest distFt is lead');
  assert.equal(labels.get('b'), 2);
  assert.equal(labels.get('a'), 3);
});

test('findParkedBusVids flags only barely-moving buses with enough history', () => {
  const rows = [
    // 'p' parked: 4 snapshots, drift 100 ft (< 250).
    { vehicleId: 'p', distFt: 1000 },
    { vehicleId: 'p', distFt: 1050 },
    { vehicleId: 'p', distFt: 1100 },
    { vehicleId: 'p', distFt: 1100 },
    // 'm' moving: 4 snapshots, drift 4000 ft.
    { vehicleId: 'm', distFt: 1000 },
    { vehicleId: 'm', distFt: 2000 },
    { vehicleId: 'm', distFt: 4000 },
    { vehicleId: 'm', distFt: 5000 },
    // 'n' too little history: 2 snapshots.
    { vehicleId: 'n', distFt: 1000 },
    { vehicleId: 'n', distFt: 1000 },
  ];
  const parked = findParkedBusVids(rows);
  assert.ok(parked.has('p'));
  assert.ok(!parked.has('m'));
  assert.ok(!parked.has('n'), 'too few snapshots → not parked');
});
