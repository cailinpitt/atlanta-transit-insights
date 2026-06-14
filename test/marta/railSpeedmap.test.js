const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSpeedSamples,
  buildLineSpeedmaps,
  summarize,
  colorForRailSpeed,
  MAX_DT_MS,
} = require('../../src/marta/rail/speedmap');

function straightShape(distPerVertex, n, { lat = 33.75, lon0 = -84.4, dlon = 0.01 } = {}) {
  const points = [];
  for (let i = 0; i < n; i++) points.push({ lat, lon: lon0 + i * dlon, distFt: i * distPerVertex });
  return { points, lengthFt: (n - 1) * distPerVertex };
}
// RED line: 600 ft between vertices.
const lineGeom = new Map([['RED', { line: 'RED', ...straightShape(600, 30) }]]);
const V = lineGeom.get('RED').points;

// An observation of a train sitting at vertex `vi`.
const obs = (ts, vi, { line = 'RED', direction = 'N', train_id = '101' } = {}) => ({
  ts,
  train_id,
  line,
  direction,
  lat: V[vi].lat,
  lon: V[vi].lon,
});

test('speed is reconstructed from position deltas (~41 mph)', () => {
  // vertex 2 → 5 → 8, each 3 vertices (1800 ft) in 30 s ⇒ 1800ft/30s ≈ 40.9 mph.
  const samples = buildSpeedSamples([obs(0, 2), obs(30_000, 5), obs(60_000, 8)], { lineGeom });
  const redN = samples.get('RED/N');
  assert.equal(redN.length, 2, 'two consecutive pairs');
  for (const s of redN) assert.ok(Math.abs(s.mph - 40.9) < 0.5, `mph ${s.mph}`);
});

test('a train running toward decreasing distFt still reads positive speed', () => {
  const samples = buildSpeedSamples([obs(0, 8), obs(30_000, 5)], { lineGeom });
  assert.ok(samples.get('RED/N')[0].mph > 0);
});

test('pairs spanning too large a gap are dropped', () => {
  const samples = buildSpeedSamples([obs(0, 2), obs(MAX_DT_MS + 1000, 5)], { lineGeom });
  assert.ok(!samples.has('RED/N'), 'no sample across an oversized gap');
});

test('implausible jumps (GPS / Five Points wrap) are rejected', () => {
  // vertex 0 → 29 (17400 ft) in 30 s ≈ 395 mph ⇒ over MAX_MPH.
  const samples = buildSpeedSamples([obs(0, 0), obs(30_000, 29)], { lineGeom });
  assert.ok(!samples.has('RED/N'));
});

test('separate trains and directions do not cross-sample', () => {
  const rows = [
    obs(0, 2, { train_id: 'A' }),
    obs(30_000, 5, { train_id: 'A' }),
    obs(0, 10, { train_id: 'B', direction: 'S' }),
    obs(30_000, 7, { train_id: 'B', direction: 'S' }),
  ];
  const samples = buildSpeedSamples(rows, { lineGeom });
  assert.equal(samples.get('RED/N').length, 1);
  assert.equal(samples.get('RED/S').length, 1);
});

test('summarize buckets by the rail thresholds', () => {
  const s = summarize([10, 20, 30, 40, 50, null]);
  assert.deepEqual(
    [s.red, s.orange, s.yellow, s.purple, s.green],
    [1, 1, 1, 1, 1],
    'red/orange/yellow/purple/green',
  );
  assert.equal(s.covered, 5);
  assert.equal(s.avg, 30);
});

test('colors map to the rail bands', () => {
  assert.equal(colorForRailSpeed(null), '444');
  assert.equal(colorForRailSpeed(10), 'ff2a2a');
  assert.equal(colorForRailSpeed(20), 'ff8c1a');
  assert.equal(colorForRailSpeed(30), 'ffd21a');
  assert.equal(colorForRailSpeed(40), 'a855f7');
  assert.equal(colorForRailSpeed(50), '2ad17f');
});

test('end-to-end line speedmap', () => {
  const rows = [];
  for (let v = 2; v <= 26; v += 3) rows.push(obs(v * 10_000, v)); // a train progressing
  const maps = buildLineSpeedmaps(rows, { lineGeom, numBins: 10 });
  const m = maps.get('RED/N');
  assert.ok(m.sampleCount > 0);
  assert.equal(m.bins.length, 10);
  assert.equal(m.line, 'RED');
  if (m.summary.avg != null) assert.ok(m.summary.avg > 0 && m.summary.avg < 75);
});
