const test = require('node:test');
const assert = require('node:assert');
const { attachTrails } = require('../../src/bus/bunchingVideo');
const { buildVehicleSeries, vehicleStateAt } = require('../../src/shared/videoTracks');

// Interior-gap bridging now lives in the shared dropout kernel (the bus video
// feeds it bus-shaped snapshots: `.vehicles` arrays keyed by `vid`). These cases
// preserve the route 3 #8940 dropout regression — a bus the feed drops mid-clip
// must glide through the gap, not freeze or vanish. Cartesian mode (no polyline)
// keeps the math a straight lat/lon lerp by timestamp fraction.
const BUS = { itemsOf: (s) => s.vehicles, idOf: (v) => v.vid };
const SEC = 1000;

function snap(ts, vehicles) {
  return { ts, vehicles };
}

test('kernel bridges a bus dropped for a single poll mid-clip (not frozen)', () => {
  const series = buildVehicleSeries(
    [
      snap(0, [{ vid: 'A', lat: 0, lon: 0, heading: 90, pdist: 100 }]),
      snap(15 * SEC, []), // A dropped this tick
      snap(30 * SEC, [{ vid: 'A', lat: 0, lon: 2, heading: 90, pdist: 300 }]),
    ],
    BUS,
  ).get('A');
  const mid = vehicleStateAt(series, 15 * SEC);
  assert.ok(mid, 'A is bridged across the gap snapshot, not absent');
  assert.equal(mid.lon, 1, 'lon interpolated to the midpoint by ts fraction');
  assert.equal(mid.heading, 90, 'carries payload across the bridge');
});

test('kernel bridges a multi-poll bus dropout so the bus never vanishes', () => {
  // route 3 #8940: present, gone for several ticks, back.
  const series = buildVehicleSeries(
    [
      snap(0, [{ vid: 'A', lat: 0, lon: 0 }]),
      snap(15 * SEC, []),
      snap(30 * SEC, []),
      snap(45 * SEC, []),
      snap(60 * SEC, [{ vid: 'A', lat: 0, lon: 4 }]),
    ],
    BUS,
  ).get('A');
  // The whole 60 s gap is < 8 min, so every interior frame is bridged.
  for (let i = 1; i <= 3; i++) {
    const v = vehicleStateAt(series, i * 15 * SEC);
    assert.ok(v, `A present mid-gap at ${i * 15}s`);
    assert.ok(Math.abs(v.lon - i) < 1e-9, `lon glides across the gap at ${i * 15}s`);
  }
});

test('kernel does not draw a bus before its first sighting', () => {
  const series = buildVehicleSeries(
    [
      snap(0, []), // A not yet seen
      snap(15 * SEC, [{ vid: 'A', lat: 0, lon: 1 }]),
    ],
    BUS,
  ).get('A');
  assert.equal(vehicleStateAt(series, 0), null, 'leading absence is not backfilled');
});

test('attachTrails: builds oldest->newest trail spanning the window', () => {
  const vehicleFrames = [
    [{ vid: 'A', lat: 0, lon: 0 }],
    [{ vid: 'A', lat: 0, lon: 1 }],
    [{ vid: 'A', lat: 0, lon: 2 }],
    [{ vid: 'A', lat: 0, lon: 3 }],
  ];
  attachTrails(vehicleFrames, 2); // up to 2 prior frames
  const last = vehicleFrames[3][0];
  assert.deepEqual(
    last.trail.map((p) => p.lon),
    [1, 2, 3],
    'trail covers frames [i-2 .. i], head last',
  );
  // First frame has no prior positions -> no trail.
  assert.equal(vehicleFrames[0][0].trail, undefined);
});

test('attachTrails: skips parked turnaround markers', () => {
  const vehicleFrames = [
    [{ vid: 'A', lat: 0, lon: 0 }],
    [{ vid: 'A', lat: 0, lon: 1, turnaround: true }],
  ];
  attachTrails(vehicleFrames, 5);
  assert.equal(vehicleFrames[1][0].trail, undefined, 'parked marker gets no trail');
});
