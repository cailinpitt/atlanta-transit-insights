const test = require('node:test');
const assert = require('node:assert/strict');
const { detectRailBunching } = require('../../src/marta/rail/bunching');
const { detectRailGaps } = require('../../src/marta/rail/gaps');
const { railGhostsFromObservations } = require('../../src/marta/rail/ghosts');
const { latestTrainPositions } = require('../../src/marta/rail/trains');

// --- bunching ---
const train = (distFt, id, over = {}) => ({
  line: 'RED',
  direction: 'N',
  trainId: id,
  distFt,
  lat: 33.75,
  lon: -84.39,
  ...over,
});

test('rail bunching clusters trains within the threshold', () => {
  const b = detectRailBunching([train(10_000, 'a'), train(11_500, 'b')]); // 1500 ft < 2640
  assert.equal(b.length, 1);
  assert.equal(b[0].trains.length, 2);
  assert.equal(b[0].line, 'RED');
});

test('rail trains beyond the threshold are not bunched', () => {
  assert.deepEqual(detectRailBunching([train(10_000, 'a'), train(15_000, 'b')]), []);
});

test('rail bunching rejects a geographically impossible cluster', () => {
  const far = train(11_500, 'b', { lat: 33.95 }); // ~14 mi off in geo, close in distFt
  assert.deepEqual(detectRailBunching([train(10_000, 'a'), far]), []);
});

test('rail bunching ranks the bigger cluster first', () => {
  const trains = [
    train(10_000, 'a'),
    train(11_000, 'b'),
    train(12_000, 'c'), // RED/N cluster of 3
    { ...train(20_000, 'd'), direction: 'S' },
    { ...train(21_000, 'e'), direction: 'S' }, // RED/S cluster of 2
  ];
  const b = detectRailBunching(trains);
  assert.equal(b.length, 2);
  assert.equal(b[0].trains.length, 3);
  assert.equal(b[0].direction, 'N');
});

// --- gaps ---
const LEN = 100_000;
const gapLookups = (headwayMin) => ({
  now: Date.now(),
  headwayFor: () => headwayMin,
  lengthFor: () => LEN,
});

test('a wide rail gap past the ratio + floor fires', () => {
  // 5-min headway, 40_000 ft apart ≈ 15.2 min ≈ 3.0× → gap.
  const gaps = detectRailGaps([train(20_000, 'a'), train(60_000, 'b')], gapLookups(5));
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].leading.trainId, 'b');
  assert.ok(gaps[0].ratio >= 2.5);
});

test('normal rail spacing does not fire', () => {
  // 10-min headway, 20_000 ft ≈ 7.6 min < 12-min floor.
  assert.deepEqual(detectRailGaps([train(20_000, 'a'), train(40_000, 'b')], gapLookups(10)), []);
});

test('rail trains in the terminal zone are excluded', () => {
  assert.deepEqual(detectRailGaps([train(500, 'a'), train(60_000, 'b')], gapLookups(5)), []);
});

// --- ghosts ---
const MON_11 = new Date('2026-06-15T15:00:00Z'); // Monday 11:00 ET
const railIndex = {
  routes: {
    RED: {
      0: { headways: { weekday: { 11: 6 } }, activeByHour: { weekday: { 11: 8 } } },
      1: { headways: { weekday: { 11: 6 } }, activeByHour: { weekday: { 11: 8 } } },
    },
  },
};
function railObs(counts, { line = 'RED', startTs = MON_11.getTime() } = {}) {
  const rows = [];
  counts.forEach((c, i) => {
    const ts = startTs + i * 10 * 60_000;
    for (let k = 0; k < c; k++) rows.push({ ts, train_id: `t${k}`, line });
  });
  return rows;
}

test('rail ghost fires when observed trains fall below the line schedule', () => {
  // Line scheduled active = 8+8 = 16; observed 4 across 6 snapshots → missing 12.
  const events = railGhostsFromObservations(railObs([4, 4, 4, 4, 4, 4]), {
    index: railIndex,
    now: MON_11.getTime(),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].route, 'RED');
  assert.equal(events[0].expectedActive, 16);
  assert.equal(events[0].observedActive, 4);
});

test('full rail service does not ghost', () => {
  const events = railGhostsFromObservations(railObs([15, 15, 15, 15, 15, 15]), {
    index: railIndex,
    now: MON_11.getTime(),
  });
  assert.equal(events.length, 0);
});

// --- latestTrainPositions ---
function straightShape(distPerVertex, n) {
  const points = [];
  for (let i = 0; i < n; i++)
    points.push({ lat: 33.75, lon: -84.4 + i * 0.01, distFt: i * distPerVertex });
  return { line: 'RED', points, lengthFt: (n - 1) * distPerVertex };
}
const lineGeom = new Map([['RED', straightShape(600, 30)]]);
const V = lineGeom.get('RED').points;

test('latestTrainPositions keeps the freshest fix per train and drops stale ones', () => {
  const now = 1_781_000_000_000;
  const rows = [
    { ts: now - 60_000, train_id: 'a', line: 'RED', direction: 'N', lat: V[3].lat, lon: V[3].lon },
    { ts: now - 1_000, train_id: 'a', line: 'RED', direction: 'N', lat: V[5].lat, lon: V[5].lon },
    {
      ts: now - 10 * 60_000,
      train_id: 'b',
      line: 'RED',
      direction: 'N',
      lat: V[8].lat,
      lon: V[8].lon,
    },
  ];
  const out = latestTrainPositions(rows, lineGeom, { now });
  assert.equal(out.length, 1, 'b is stale (>3 min), a deduped to its latest');
  assert.equal(out[0].trainId, 'a');
  assert.ok(Math.abs(out[0].distFt - 3000) < 50, 'used the fresher vertex-5 fix');
});
