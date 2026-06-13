const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_BRIDGE_MS,
  buildVehicleSeries,
  vehicleStateAt,
} = require('../../src/shared/videoTracks');

const T0 = 1_700_000_000_000;
const SEC = 1000;

// Helper: a series element at offset `secs` with a position.
function snap(ts, trains) {
  return { ts, trains };
}

test('buildVehicleSeries groups by id, sorts by ts, and computes forward speed', () => {
  const snaps = [
    snap(T0, [{ rn: 'A', lat: 41.8, lon: -87.6 }]),
    snap(T0 + 30 * SEC, [{ rn: 'A', lat: 41.81, lon: -87.6 }]),
  ];
  // track distance grows 0 → 1500 ft over 30 s → 50 ft/s.
  const series = buildVehicleSeries(snaps, { trackOf: (_t, si) => si * 1500 });
  const a = series.get('A');
  assert.equal(a.length, 2);
  assert.equal(a[0].speed, 0); // no prior sample
  assert.equal(a[1].speed, 50);
});

test('buildVehicleSeries honors custom itemsOf/idOf (bus-shaped snapshots)', () => {
  const snaps = [
    { ts: T0, vehicles: [{ vid: '8940', lat: 41.8, lon: -87.6 }] },
    { ts: T0 + 30 * SEC, vehicles: [{ vid: '8940', lat: 41.81, lon: -87.6 }] },
  ];
  const series = buildVehicleSeries(snaps, {
    itemsOf: (s) => s.vehicles,
    idOf: (v) => v.vid,
  });
  assert.equal(series.get('8940').length, 2);
});

test('vehicleStateAt is null before first and bridges a short gap dimmed', () => {
  const series = [
    { t: T0, lat: 41.8, lon: -87.6, track: null, speed: 0, payload: { rn: 'A', heading: 90 } },
    { t: T0 + 120 * SEC, lat: 41.82, lon: -87.6, track: null, speed: 0, payload: { rn: 'A' } },
  ];
  assert.equal(vehicleStateAt(series, T0 - SEC), null, 'not yet appeared');
  // Midpoint of a 2-min gap (< 8 min): bridged, position halfway, dimmed < 1.
  const mid = vehicleStateAt(series, T0 + 60 * SEC);
  assert.ok(mid);
  assert.ok(Math.abs(mid.lat - 41.81) < 1e-6, 'interpolated halfway');
  assert.ok(mid.opacity < 1 && mid.opacity >= 0.5, `dimmed but visible, got ${mid.opacity}`);
  assert.equal(mid.heading, 90, 'carries payload from the earlier sample');
});

test('vehicleStateAt ghosts out and back across an un-bridgeable gap', () => {
  const gap = MAX_BRIDGE_MS + 4 * 60 * SEC; // ~12 min, well past the bridge cap
  const series = [
    { t: T0, lat: 41.8, lon: -87.6, track: null, speed: 0, payload: { rn: 'A' } },
    { t: T0 + gap, lat: 41.9, lon: -87.6, track: null, speed: 0, payload: { rn: 'A' } },
  ];
  // Just after the near endpoint → faint ghost.
  const nearGhost = vehicleStateAt(series, T0 + 5 * SEC);
  assert.ok(nearGhost?.ghost, 'ghost near the last-known point');
  assert.ok(nearGhost.opacity > 0 && nearGhost.opacity < 0.5);
  // Deep in the middle → nothing drawn.
  assert.equal(vehicleStateAt(series, T0 + gap / 2), null, 'unknown middle draws nothing');
  // Just before the far endpoint → faint ghost again.
  const farGhost = vehicleStateAt(series, T0 + gap - 5 * SEC);
  assert.ok(farGhost?.ghost, 'ghost re-fades in approaching reappearance');
});

test('vehicleStateAt tail-drops into a dead-reckoned fading ghost along the polyline', () => {
  const series = [
    { t: T0, lat: 41.8, lon: -87.6, track: 0, speed: 50, payload: { rn: 'A' } },
    { t: T0 + 30 * SEC, lat: 41.81, lon: -87.6, track: 1500, speed: 50, payload: { rn: 'A' } },
  ];
  const last = series[1];
  // pointAlong: pretend the line runs due north, 1 ft ≈ tiny lat increment.
  const pointAlong = (trackFt) => ({ lat: 41.8 + trackFt / 364000, lon: -87.6 });
  const videoEndTs = T0 + 90 * SEC;
  const ghost = vehicleStateAt(series, T0 + 60 * SEC, { pointAlong, videoEndTs });
  assert.ok(ghost?.ghost, 'tail drop renders a ghost');
  // Dead-reckoned forward from last.track (1500) at 50 ft/s for 30 s → track 3000.
  assert.ok(ghost.lat > pointAlong(last.track).lat, 'ghost advances past the last-known position');
  assert.ok(ghost.opacity < 1 && ghost.opacity >= 0.15);
});

test('vehicleStateAt plays a turnaround glyph when the tail drop is at a real terminal', () => {
  const terminal = { lat: 41.9679, lon: -87.7134 }; // ~Kimball
  const series = [
    { t: T0, lat: 41.967, lon: -87.713, track: 1000, speed: 10, payload: { rn: 'A' } },
  ];
  const out = vehicleStateAt(series, T0 + TimeAfterGlide(), {
    realTerminalEnds: [terminal],
    videoEndTs: T0 + 60 * SEC,
  });
  assert.ok(out?.turnaround, 'within turnaround radius → turnaround glyph');
});

function TimeAfterGlide() {
  // 3 s in → past the 2.5 s glide, into the hold phase (full-opacity glyph).
  return 3000;
}

test('explicit turnaroundEnd forces a turnaround even when not near a terminus', () => {
  // Bus that reappeared on a different pid (proven turnaround) but stopped
  // reporting mid-route — no realTerminalEnds proximity, but the caller passes
  // the terminus explicitly.
  const series = [{ t: T0, lat: 41.85, lon: -87.65, track: 5000, speed: 5, payload: { vid: 'X' } }];
  const end = { lat: 41.9, lon: -87.7 };
  const parked = vehicleStateAt(series, T0 + 30 * SEC, {
    turnaroundEnd: end,
    turnaroundPark: true,
    turnaroundGlideMs: 2000,
    videoEndTs: T0 + 120 * SEC,
  });
  assert.ok(parked?.turnaround, 'explicit turnaroundEnd → turnaround glyph');
  assert.equal(parked.opacity, 1, 'turnaroundPark holds full opacity (no fade)');
  assert.equal(parked.lat, end.lat);
});
