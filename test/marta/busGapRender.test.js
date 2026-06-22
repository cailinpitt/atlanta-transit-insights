const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const { computeGapView, renderGapFrame } = require('../../src/marta/map/busGap');

// A straight north–south shape, 0 → ~10560 ft, with per-vertex distFt so the
// gap view can slice it. Coordinates are arbitrary downtown-Atlanta-ish points.
function syntheticShape() {
  const points = [];
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    points.push({
      lat: 33.74 + i * 0.003,
      lon: -84.39,
      distFt: i * 1056,
    });
  }
  return { points, lengthFt: 10560 };
}

const gap = {
  shapeId: 'S1',
  route: '20',
  gapFt: 7392,
  gapMin: 20,
  expectedMin: 8,
  ratio: 2.5,
  leading: { vehicleId: '1001', distFt: 8448, lat: 33.764, lon: -84.39 },
  trailing: { vehicleId: '1002', distFt: 1056, lat: 33.743, lon: -84.39 },
  flankBefore: { stopName: '10th St', distFt: 528, lat: 33.7415, lon: -84.39 },
  flankAfter: { stopName: '14th St', distFt: 9000, lat: 33.7655, lon: -84.39 },
};

// A 1280x720 blank base map so renderGapFrame composites onto something real
// without hitting Mapbox.
async function blankBase() {
  return sharp({
    create: { width: 1280, height: 720, channels: 3, background: { r: 20, g: 20, b: 20 } },
  })
    .jpeg()
    .toBuffer();
}

const isJpeg = (buf) => Buffer.isBuffer(buf) && buf[0] === 0xff && buf[1] === 0xd8;

test('still gap frame renders flank-stop pins + labels', async () => {
  const view = computeGapView(gap, syntheticShape());
  const base = await blankBase();
  const out = await renderGapFrame(view, base, gap, [], {
    title: 'Route 20 — Doraville',
    stopLabels: [gap.flankBefore, gap.flankAfter],
  });
  assert.ok(isJpeg(out), 'expected a JPEG buffer');
});

test('video gap frame renders midpoint highlight + readout HUD', async () => {
  const view = computeGapView(gap, syntheticShape());
  const base = await blankBase();
  const out = await renderGapFrame(view, base, gap, [], {
    highlightStop: { lat: 33.754, lon: -84.39, name: '12th St' },
    readout: '~20-min gap · next bus ~4 min to 12th St',
    clock: { elapsedSec: 300, totalSec: 600 },
  });
  assert.ok(isJpeg(out), 'expected a JPEG buffer');
});
