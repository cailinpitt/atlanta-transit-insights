const test = require('node:test');
const assert = require('node:assert/strict');

const { pointAlongShape } = require('../../src/marta/bus/shapes');
const { buildSmoothFrames, snapshotsByTimestamp } = require('../../src/marta/shared/smoothFrames');
const { buildTimelapsePostText, buildTimelapseAltText } = require('../../src/marta/rail/post');

// A straight north-bound shape, 0..10000 ft along increasing latitude.
function straightShape() {
  const points = [];
  for (let i = 0; i <= 100; i++) points.push({ lat: 33 + 0.001 * i, lon: -84, distFt: i * 100 });
  return { points, lengthFt: 10000 };
}

test('pointAlongShape interpolates and clamps at both ends', () => {
  const shape = straightShape();
  assert.deepEqual(pointAlongShape(shape, -500), { lat: 33, lon: -84 });
  assert.deepEqual(pointAlongShape(shape, 99999), { lat: 33.1, lon: -84 });
  const mid = pointAlongShape(shape, 5050);
  assert.ok(Math.abs(mid.lat - 33.0505) < 1e-6);
});

test('buildSmoothFrames adds interpolated in-between frames gliding along the route', () => {
  const shape = straightShape();
  const rows = [
    { ts: 1000, id: 'A', distFt: 1000 },
    { ts: 31000, id: 'A', distFt: 3000 },
  ];
  const snapshots = snapshotsByTimestamp(rows);
  const frames = buildSmoothFrames(snapshots, {
    idOf: (t) => t.id,
    trackOf: (t) => t.distFt,
    pointAlong: (track) => pointAlongShape(shape, track),
    interpolate: 4,
  });
  // 4 interpolation steps across the single gap + the final frame.
  assert.equal(frames.length, 5);
  const lats = frames.map((f) => f[0].lat);
  // Strictly increasing → smooth forward motion, no jump-and-hold.
  for (let i = 1; i < lats.length; i++) assert.ok(lats[i] > lats[i - 1]);
  assert.ok(Math.abs(lats[0] - 33.01) < 1e-6);
  assert.ok(Math.abs(lats.at(-1) - 33.03) < 1e-6);
});

test('timelapse post + alt text summarize the system by line', () => {
  const meta = {
    elapsedSec: 900,
    startTs: Date.parse('2026-06-14T18:00:00Z'),
    endTs: Date.parse('2026-06-14T18:15:00Z'),
    allTrains: [
      { line: 'RED' },
      { line: 'RED' },
      { line: 'GOLD' },
      { line: 'BLUE' },
      { line: 'GREEN' },
    ],
  };
  const text = buildTimelapsePostText(meta);
  assert.match(text, /^🚆 MARTA Rail · 15-min timelapse/);
  assert.match(text, /5 trains/);
  assert.match(text, /Red 2 · Gold 1 · Blue 1 · Green 1/);
  assert.match(buildTimelapseAltText(meta), /5 trains appeared during the window/);
});
