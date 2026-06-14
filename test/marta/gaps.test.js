const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectBusGaps,
  STALE_MS,
  RATIO_THRESHOLD,
  ABSOLUTE_MIN_MIN,
  TYPICAL_SPEED_FT_PER_MIN,
} = require('../../src/marta/bus/gaps');

const NOW = 1_781_000_000_000;
const LENGTH = 100_000; // ~19 mi shape, so terminal zones are 10_000 ft
// A vehicle on shape S1 at distFt with a fresh timestamp.
const veh = (distFt, id, over = {}) => ({
  shapeId: 'S1',
  distFt,
  route: '20',
  vehicleId: id,
  tmstmp: NOW,
  lat: 33.7,
  lon: -84.4,
  ...over,
});

const lookups = (headwayMin) => ({
  now: NOW,
  headwayFor: () => headwayMin,
  lengthFor: () => LENGTH,
});

test('a wide spacing past the ratio + absolute floor fires a gap', () => {
  // 10-min scheduled headway; buses 30_000 ft apart ≈ 34 min ≈ 3.4× → gap.
  const gaps = detectBusGaps([veh(20_000, 'a'), veh(50_000, 'b')], lookups(10));
  assert.equal(gaps.length, 1);
  const g = gaps[0];
  assert.equal(g.trailing.vehicleId, 'a', 'trailing is the lower-distFt bus');
  assert.equal(g.leading.vehicleId, 'b');
  assert.equal(g.gapFt, 30_000);
  assert.ok(Math.abs(g.gapMin - 30_000 / TYPICAL_SPEED_FT_PER_MIN) < 1e-9);
  assert.ok(g.ratio >= RATIO_THRESHOLD);
});

test('normal spacing does not fire', () => {
  // 10-min headway, buses 12_000 ft apart ≈ 13.6 min < absolute floor (15).
  assert.deepEqual(detectBusGaps([veh(20_000, 'a'), veh(32_000, 'b')], lookups(10)), []);
});

test('big absolute gap on a frequent route still needs the ratio', () => {
  // 20-min headway; 30_000 ft ≈ 34 min → ratio 1.7 < 2.5, no fire even though
  // it clears the 15-min absolute floor.
  assert.deepEqual(detectBusGaps([veh(20_000, 'a'), veh(50_000, 'b')], lookups(20)), []);
});

test('buses inside the terminal zone are excluded', () => {
  // terminalZoneFt caps at 1500 ft. Trailing bus at 1_000 ft is inside the
  // start zone, so the pair is skipped.
  assert.deepEqual(detectBusGaps([veh(1_000, 'a'), veh(50_000, 'b')], lookups(10)), []);
  // Leading bus within the end terminal zone (length - 1_000 < 1500) excluded.
  assert.deepEqual(detectBusGaps([veh(40_000, 'a'), veh(99_000, 'b')], lookups(10)), []);
});

test('stale vehicles are dropped before detection', () => {
  const stale = veh(50_000, 'b', { tmstmp: NOW - STALE_MS - 1 });
  assert.deepEqual(detectBusGaps([veh(20_000, 'a'), stale], lookups(10)), []);
});

test('a single bus or unknown headway yields no gaps', () => {
  assert.deepEqual(detectBusGaps([veh(20_000, 'a')], lookups(10)), []);
  assert.deepEqual(detectBusGaps([veh(20_000, 'a'), veh(50_000, 'b')], lookups(null)), []);
});

test('flank stops name the empty stretch when stops are provided', () => {
  const stops = [
    { stopName: 'A', distFt: 19_000, lat: 33.7, lon: -84.4 },
    { stopName: 'mid', distFt: 35_000, lat: 33.7, lon: -84.4 },
    { stopName: 'B', distFt: 51_000, lat: 33.7, lon: -84.4 },
  ];
  const [g] = detectBusGaps([veh(20_000, 'a'), veh(50_000, 'b')], {
    ...lookups(10),
    stopsFor: () => stops,
  });
  assert.equal(g.flankBefore.stopName, 'A', 'stop just behind the trailing bus');
  assert.equal(g.flankAfter.stopName, 'B', 'stop just ahead of the leading bus');
});

test('gaps sort by descending ratio', () => {
  // S1: 10-min headway. Two shapes via override.
  const vehicles = [
    veh(20_000, 'a'),
    veh(50_000, 'b'), // 30k ft gap, ratio ~3.4
    { ...veh(20_000, 'c'), shapeId: 'S2' },
    { ...veh(80_000, 'd'), shapeId: 'S2' }, // 60k ft gap, ratio ~6.8
  ];
  const gaps = detectBusGaps(vehicles, {
    now: NOW,
    headwayFor: () => 10,
    lengthFor: () => LENGTH,
  });
  assert.equal(gaps.length, 2);
  assert.ok(gaps[0].ratio > gaps[1].ratio, 'widest gap first');
  assert.equal(gaps[0].shapeId, 'S2');
});

test('ABSOLUTE_MIN_MIN constant is the 15-minute floor', () => {
  assert.equal(ABSOLUTE_MIN_MIN, 15);
});
