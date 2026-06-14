const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const { loadGtfs } = require('../../src/marta/gtfs');
const { loadShapes } = require('../../src/marta/bus/shapes');
const { decodeFeed, parseVehiclePosition } = require('../../src/marta/bus/api');
const {
  buildSpeedSamples,
  binSamples,
  summarize,
  colorForBusSpeed,
  buildRouteSpeedmaps,
  MS_TO_MPH,
} = require('../../src/marta/bus/speedmap');

const FIXG = Path.join(__dirname, 'fixtures', 'gtfs');
const gtfs = loadGtfs(FIXG);
const shapes = loadShapes(FIXG);
const vehicles = decodeFeed(
  Fs.readFileSync(Path.join(__dirname, 'fixtures', 'bus-vehiclepositions.pb')),
)
  .entity.map(parseVehiclePosition)
  .filter(Boolean);

test('samples come only from speed-bearing, on-route vehicles', () => {
  const byShape = buildSpeedSamples(vehicles, { gtfs, shapes });
  const totalSamples = [...byShape.values()].reduce((n, e) => n + e.samples.length, 0);
  const withSpeed = vehicles.filter((v) => v.speed != null).length;
  assert.ok(totalSamples > 0, 'produced samples');
  assert.ok(totalSamples <= withSpeed, 'never more samples than speed-bearing vehicles');
  for (const entry of byShape.values()) {
    assert.ok(entry.route, 'each shape carries its public route number');
    for (const s of entry.samples) {
      assert.ok(Number.isFinite(s.distFt) && s.distFt >= 0);
      assert.ok(s.mph >= 0 && s.mph <= 60);
    }
  }
});

test('binning averages samples and leaves empty bins null', () => {
  const bins = binSamples(
    [
      { distFt: 0, mph: 4 },
      { distFt: 0, mph: 6 },
      { distFt: 900, mph: 20 },
    ],
    1000,
    10,
  );
  assert.equal(bins.length, 10);
  assert.equal(bins[0], 5, 'two samples in bin 0 average to 5');
  assert.equal(bins[9], 20, 'sample near the end lands in the last bin');
  assert.equal(bins[5], null, 'untouched bin stays null');
});

test('summarize buckets by the bus thresholds', () => {
  // 4 → red(<5), 7 → orange(5-10), 12 → yellow(10-15), 20 → green(>=15).
  const s = summarize([4, 7, 12, 20, null]);
  assert.equal(s.red, 1);
  assert.equal(s.orange, 1);
  assert.equal(s.yellow, 1);
  assert.equal(s.green, 1);
  assert.equal(s.covered, 4);
  assert.ok(Math.abs(s.avg - (4 + 7 + 12 + 20) / 4) < 1e-9);
});

test('colors map to the right buckets', () => {
  assert.equal(colorForBusSpeed(null), '444');
  assert.equal(colorForBusSpeed(3), 'ff2a2a');
  assert.equal(colorForBusSpeed(7), 'ff8c1a');
  assert.equal(colorForBusSpeed(12), 'ffd21a');
  assert.equal(colorForBusSpeed(30), '2ad17f');
});

test('end-to-end speedmap over the fixture snapshot', () => {
  const maps = buildRouteSpeedmaps(vehicles, { gtfs, shapes, numBins: 20 });
  assert.ok(maps.size > 0, 'at least one route mapped');
  for (const m of maps.values()) {
    assert.equal(m.bins.length, 20);
    assert.ok(m.lengthFt > 0);
    assert.ok(m.sampleCount > 0);
    if (m.summary.avg != null) assert.ok(m.summary.avg >= 0 && m.summary.avg <= 60);
  }
});

test('MS_TO_MPH converts a known speed', () => {
  // 26.82 m/s (the feed max we observed) ≈ 60 mph.
  assert.ok(Math.abs(26.82 * MS_TO_MPH - 60) < 0.1);
});
