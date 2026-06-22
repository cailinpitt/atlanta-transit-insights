const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const { gapViewFor, renderRailFrame } = require('../../src/marta/map/railIncidents');

// A straight south→north RED line, 0 → 40000 ft, distFt per vertex.
function syntheticLine() {
  const points = [];
  for (let i = 0; i <= 40; i++) {
    points.push({ lat: 33.75 + i * 0.0009, lon: -84.39, distFt: i * 1000 });
  }
  return { line: 'RED', points, lengthFt: 40000 };
}

const gap = {
  line: 'RED',
  direction: 'N',
  gapFt: 16000,
  gapMin: 18,
  expectedMin: 5,
  ratio: 3.6,
  trailing: { trainId: '408', distFt: 8000, lat: 33.7572, lon: -84.39 },
  leading: { trainId: '303', distFt: 24000, lat: 33.7716, lon: -84.39 },
  flankBefore: { name: 'LINDBERGH CENTER Station', distFt: 7000, lat: 33.7563, lon: -84.39 },
  flankAfter: { name: 'MEDICAL CENTER Station', distFt: 25000, lat: 33.7725, lon: -84.39 },
  midStation: { name: 'BUCKHEAD Station', distFt: 16000, lat: 33.7644, lon: -84.39 },
};

async function blankBase() {
  return sharp({
    create: { width: 1280, height: 720, channels: 3, background: { r: 20, g: 20, b: 20 } },
  })
    .jpeg()
    .toBuffer();
}

const isJpeg = (buf) => Buffer.isBuffer(buf) && buf[0] === 0xff && buf[1] === 0xd8;

test('still rail gap frame renders flanking-station dots + labels', async () => {
  const view = gapViewFor(syntheticLine(), gap);
  const base = await blankBase();
  const trains = [
    { ...gap.trailing, role: 'N' },
    { ...gap.leading, role: 'L' },
  ];
  const out = await renderRailFrame(view, base, trains, {
    title: 'Red Line — Northbound',
    stationLabels: [gap.flankBefore, gap.flankAfter],
  });
  assert.ok(isJpeg(out), 'expected a JPEG buffer');
});

test('video rail gap frame renders midpoint highlight + readout HUD', async () => {
  const view = gapViewFor(syntheticLine(), gap);
  const base = await blankBase();
  const trains = [
    { ...gap.trailing, role: 'N', track: 8000 },
    { ...gap.leading, role: 'L', track: 24000 },
  ];
  const out = await renderRailFrame(view, base, trains, {
    highlightStop: { lat: 33.7644, lon: -84.39, name: 'BUCKHEAD Station' },
    readout: '~18-min gap · next train ~3 min to Buckhead',
    clock: { elapsedSec: 360, totalSec: 600 },
  });
  assert.ok(isJpeg(out), 'expected a JPEG buffer');
});
