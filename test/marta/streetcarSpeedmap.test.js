const test = require('node:test');
const assert = require('node:assert/strict');
const Path = require('node:path');
const { loadGtfs } = require('../../src/marta/gtfs');
const { loadShapes } = require('../../src/marta/bus/shapes');
const {
  buildStreetcarGeometry,
  buildStreetcarSpeedmaps,
  colorForStreetcarSpeed,
  STREETCAR_MAX_MPH,
  STREETCAR_THRESHOLDS,
} = require('../../src/marta/streetcar/speedmap');
const { STREETCAR_LINE } = require('../../src/marta/streetcar/api');

const GTFS_DIR = Path.join(__dirname, '..', '..', 'data', 'marta', 'gtfs');

// A straight synthetic "SC" loop with `dft` feet between vertices.
function scGeom(dft, n) {
  const points = [];
  for (let i = 0; i < n; i++)
    points.push({ lat: 33.755, lon: -84.39 + i * 0.001, distFt: i * dft });
  return new Map([[STREETCAR_LINE, { line: STREETCAR_LINE, points, lengthFt: (n - 1) * dft }]]);
}

// A streetcar observation at vertex `vi` — note it carries vehicleId, not train_id.
const scObs = (geom, ts, vi, { direction = '0', vehicleId = 'MARTA:1001' } = {}) => {
  const p = geom.get(STREETCAR_LINE).points[vi];
  return { ts, vehicleId, line: STREETCAR_LINE, direction, lat: p.lat, lon: p.lon };
};

test('colors map to the slower streetcar bands', () => {
  assert.equal(colorForStreetcarSpeed(null), '444');
  assert.equal(colorForStreetcarSpeed(STREETCAR_THRESHOLDS.orange - 1), 'ff2a2a'); // red
  assert.equal(colorForStreetcarSpeed(STREETCAR_THRESHOLDS.orange), 'ff8c1a'); // orange
  assert.equal(colorForStreetcarSpeed(STREETCAR_THRESHOLDS.yellow), 'ffd21a'); // yellow
  assert.equal(colorForStreetcarSpeed(STREETCAR_THRESHOLDS.purple), 'a855f7'); // purple
  assert.equal(colorForStreetcarSpeed(STREETCAR_THRESHOLDS.green), '2ad17f'); // green
});

test('derives streetcar speed from position deltas keyed on vehicleId', () => {
  // 100 ft between vertices: vertex 0→3→6 is 300 ft per 30 s ≈ 6.8 mph (orange).
  const geom = scGeom(100, 12);
  const maps = buildStreetcarSpeedmaps(
    [scObs(geom, 0, 0), scObs(geom, 30_000, 3), scObs(geom, 60_000, 6)],
    { geom, numBins: 6 },
  );
  const m = maps.get(`${STREETCAR_LINE}/0`);
  assert.ok(m, 'a SC/0 speedmap exists');
  assert.equal(m.sampleCount, 2);
  assert.ok(m.summary.avg > 4 && m.summary.avg < 8, `avg ${m.summary.avg} in orange band`);
});

test('the tighter streetcar cap rejects the once-per-lap loop wraparound', () => {
  // 600 ft/vertex, vertex 0→3 in 30 s ≈ 40.9 mph, just over the streetcar cap.
  const geom = scGeom(600, 12);
  assert.ok(40.9 > STREETCAR_MAX_MPH);
  const maps = buildStreetcarSpeedmaps([scObs(geom, 0, 0), scObs(geom, 30_000, 3)], { geom });
  assert.ok(!maps.has(`${STREETCAR_LINE}/0`), 'wraparound-speed pair dropped');
});

test('builds a single SC geometry from the real streetcar GTFS shape', () => {
  const gtfs = loadGtfs(GTFS_DIR);
  const shapes = loadShapes(GTFS_DIR);
  const geom = buildStreetcarGeometry(gtfs, shapes);
  const sc = geom.get(STREETCAR_LINE);
  assert.ok(sc, 'geometry keyed by the feed line "SC"');
  assert.ok(sc.lengthFt > 5000, `loop length ${sc.lengthFt} ft is plausible`);
  assert.ok(sc.points.length > 2);
});
