const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const { loadGtfs } = require('../../src/marta/gtfs');
const { loadShapes } = require('../../src/marta/bus/shapes');
const { decodeFeed, parseVehiclePosition } = require('../../src/marta/bus/api');
const {
  scoreForObservation,
  colorForCrowding,
  crowdingLabel,
  binSamples,
  summarize,
  crowdedBinFraction,
  buildCrowdingSamples,
  buildRouteCrowdingMaps,
  summarizeRouteCrowding,
} = require('../../src/marta/bus/crowding');

const FIXG = Path.join(__dirname, 'fixtures', 'gtfs');
const gtfs = loadGtfs(FIXG);
const shapes = loadShapes(FIXG);
const baseVehicles = decodeFeed(
  Fs.readFileSync(Path.join(__dirname, 'fixtures', 'bus-vehiclepositions.pb')),
)
  .entity.map(parseVehiclePosition)
  .filter(Boolean);

// The fixture feed carries no real occupancy (absent decodes to EMPTY), so paint
// a spread of occupancy values across the on-route vehicles to exercise the
// crowded path. Cycle empty→full so every route sees a mix.
const OCC_CYCLE = [
  'EMPTY',
  'MANY_SEATS_AVAILABLE',
  'FEW_SEATS_AVAILABLE',
  'STANDING_ROOM_ONLY',
  'CRUSHED_STANDING_ROOM_ONLY',
  'FULL',
];
const vehicles = baseVehicles.map((v, i) => ({ ...v, occupancy: OCC_CYCLE[i % OCC_CYCLE.length] }));

test('scoreForObservation maps the enum and rejects no-signal statuses', () => {
  assert.equal(scoreForObservation({ occupancy: 'EMPTY' }), 0);
  assert.equal(scoreForObservation({ occupancy: 'STANDING_ROOM_ONLY' }), 3);
  assert.equal(scoreForObservation({ occupancy: 'FULL' }), 5);
  assert.equal(scoreForObservation({ occupancy: 'NO_DATA_AVAILABLE' }), null);
  assert.equal(scoreForObservation({ occupancy: 'NOT_ACCEPTING_PASSENGERS' }), null);
  assert.equal(scoreForObservation({ occupancy: null }), null);
  assert.equal(scoreForObservation({}), null);
});

test('colors map to the right crowding buckets', () => {
  assert.equal(colorForCrowding(null), '444');
  assert.equal(colorForCrowding(0), '2ad17f'); // empty → green
  assert.equal(colorForCrowding(1.5), '2ad17f'); // many seats → green
  assert.equal(colorForCrowding(2), 'ffd21a'); // few seats → yellow
  assert.equal(colorForCrowding(3), 'ff8c1a'); // standing → orange
  assert.equal(colorForCrowding(4.5), 'ff2a2a'); // crushed/full → red
});

test('crowdingLabel reads each level', () => {
  assert.equal(crowdingLabel(null), 'no data');
  assert.equal(crowdingLabel(0), 'empty');
  assert.equal(crowdingLabel(1), 'many seats');
  assert.equal(crowdingLabel(3), 'standing room only');
  assert.equal(crowdingLabel(5), 'full');
});

test('binning averages scores and leaves empty bins null', () => {
  const bins = binSamples(
    [
      { distFt: 0, score: 2 },
      { distFt: 0, score: 4 },
      { distFt: 900, score: 5 },
    ],
    1000,
    10,
  );
  assert.equal(bins.length, 10);
  assert.equal(bins[0], 3, 'two samples in bin 0 average to 3');
  assert.equal(bins[9], 5, 'sample near the end lands in the last bin');
  assert.equal(bins[5], null, 'untouched bin stays null');
});

test('summarize buckets by the crowding thresholds and reports coverage', () => {
  // 1 → green(<2), 2 → yellow(<3), 3 → orange(<4), 4.5 → red(>=4).
  const s = summarize([1, 2, 3, 4.5, null]);
  assert.equal(s.green, 1);
  assert.equal(s.yellow, 1);
  assert.equal(s.orange, 1);
  assert.equal(s.red, 1);
  assert.equal(s.covered, 4);
  assert.equal(s.bins, 5);
});

test('crowdedBinFraction is the standing-or-fuller share of covered bins', () => {
  const s = summarize([1, 2, 3, 4.5, null]); // 2 of 4 covered are orange+red
  assert.equal(crowdedBinFraction(s), 0.5);
  assert.equal(crowdedBinFraction(summarize([null, null])), 0, 'no coverage → 0');
});

test('buildCrowdingSamples skips no-occupancy rows and projects the rest', () => {
  const withSome = [...vehicles.slice(0, 5), { ...vehicles[0], occupancy: 'NO_DATA_AVAILABLE' }];
  const byShape = buildCrowdingSamples(withSome, { gtfs, shapes });
  const total = [...byShape.values()].reduce((n, e) => n + e.samples.length, 0);
  assert.ok(total > 0, 'produced samples');
  for (const entry of byShape.values()) {
    assert.ok(entry.route, 'each shape carries its public route number');
    for (const s of entry.samples) {
      assert.ok(Number.isFinite(s.distFt) && s.distFt >= 0);
      assert.ok(s.score >= 0 && s.score <= 5);
    }
  }
});

test('end-to-end crowding maps over the fixture snapshot', () => {
  const maps = buildRouteCrowdingMaps(vehicles, { gtfs, shapes, numBins: 20 });
  assert.ok(maps.size > 0, 'at least one route mapped');
  for (const m of maps.values()) {
    assert.equal(m.bins.length, 20);
    assert.ok(m.lengthFt > 0);
    assert.ok(m.sampleCount > 0);
    if (m.summary.avg != null) assert.ok(m.summary.avg >= 0 && m.summary.avg <= 5);
  }
});

test('summarizeRouteCrowding ranks most-crowded first and ignores no-occupancy rows', () => {
  const ranked = summarizeRouteCrowding(vehicles, { gtfs });
  assert.ok(ranked.length > 0);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].pctCrowded >= ranked[i].pctCrowded, 'sorted by crowded share desc');
  }
  for (const r of ranked) {
    assert.ok(r.total > 0);
    assert.ok(r.crowded <= r.total);
    assert.ok(r.pctCrowded >= 0 && r.pctCrowded <= 1);
    assert.ok(r.peakScore >= 0 && r.peakScore <= 5);
  }
  // A feed with no usable occupancy yields nothing.
  const none = summarizeRouteCrowding(
    baseVehicles.map((v) => ({ ...v, occupancy: 'NO_DATA_AVAILABLE' })),
    { gtfs },
  );
  assert.equal(none.length, 0);
});

test('crowdedVehicles counts only distinct vehicles that were crowded', () => {
  // One vehicle reporting FULL many times is a single stuck sensor, not a
  // crowded route — the bins gate on crowdedVehicles to reject exactly that.
  const v = baseVehicles.find((x) => x.tripId && x.vehicleId);
  const stuck = Array.from({ length: 30 }, () => ({ ...v, occupancy: 'FULL' }));
  const [rec] = summarizeRouteCrowding(stuck, { gtfs });
  assert.ok(rec, 'route summarized');
  assert.equal(rec.crowded, 30, 'every sighting counted as crowded');
  assert.equal(rec.crowdedVehicles, 1, 'but all from one vehicle');

  // Two distinct crowded vehicles on the same trip → crowdedVehicles === 2.
  const two = [
    ...Array.from({ length: 15 }, () => ({ ...v, vehicleId: 'A', occupancy: 'FULL' })),
    ...Array.from({ length: 15 }, () => ({
      ...v,
      vehicleId: 'B',
      occupancy: 'STANDING_ROOM_ONLY',
    })),
  ];
  const [rec2] = summarizeRouteCrowding(two, { gtfs });
  assert.equal(rec2.crowdedVehicles, 2, 'two distinct crowded vehicles');
});

test('buildRouteCrowdingMaps reports distinct crowded vehicles per shape', () => {
  const maps = buildRouteCrowdingMaps(vehicles, { gtfs, shapes, numBins: 20 });
  for (const m of maps.values()) {
    assert.ok(Number.isInteger(m.crowdedVehicleCount) && m.crowdedVehicleCount >= 0);
  }
});
