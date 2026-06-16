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
  const m = maps.get(`${STREETCAR_LINE}/`);
  assert.ok(m, 'a single merged SC speedmap exists');
  assert.equal(m.sampleCount, 2);
  assert.ok(m.summary.avg > 4 && m.summary.avg < 8, `avg ${m.summary.avg} in orange band`);
});

test('the tighter streetcar cap rejects the once-per-lap loop wraparound', () => {
  // 600 ft/vertex, vertex 0→3 in 30 s ≈ 40.9 mph, just over the streetcar cap.
  const geom = scGeom(600, 12);
  assert.ok(40.9 > STREETCAR_MAX_MPH);
  const maps = buildStreetcarSpeedmaps([scObs(geom, 0, 0), scObs(geom, 30_000, 3)], { geom });
  assert.ok(!maps.has(`${STREETCAR_LINE}/`), 'wraparound-speed pair dropped');
});

test('merges both feed directions onto the one loop so the whole loop is covered', () => {
  // One geometry; two cars the feed labels with different directionIds, each
  // riding only one arc. Split per-direction, each map would cover ~half; merged
  // they fill the whole loop in a single SC map.
  const geom = scGeom(100, 12);
  const obs = [
    // direction "0" car crawls the first half (vertices 0..5)
    scObs(geom, 0, 0, { direction: '0', vehicleId: 'A' }),
    scObs(geom, 30_000, 2, { direction: '0', vehicleId: 'A' }),
    scObs(geom, 60_000, 4, { direction: '0', vehicleId: 'A' }),
    // direction "1" car crawls the second half (vertices 6..11)
    scObs(geom, 0, 6, { direction: '1', vehicleId: 'B' }),
    scObs(geom, 30_000, 8, { direction: '1', vehicleId: 'B' }),
    scObs(geom, 60_000, 10, { direction: '1', vehicleId: 'B' }),
  ];
  const maps = buildStreetcarSpeedmaps(obs, { geom, numBins: 6 });
  assert.equal(maps.size, 1, 'a single merged SC map, not one per direction');
  const m = maps.get(`${STREETCAR_LINE}/`);
  assert.ok(m, 'merged map keyed SC/ with no direction');
  // Both arcs contribute: coverage spans more bins than either direction alone.
  assert.ok(m.summary.covered >= 4, `merged covers ${m.summary.covered}/6 bins`);
});

test('stitches the directional half-shapes into one full SC loop', () => {
  const gtfs = loadGtfs(GTFS_DIR);
  const shapes = loadShapes(GTFS_DIR);
  const geom = buildStreetcarGeometry(gtfs, shapes);
  const sc = geom.get(STREETCAR_LINE);
  assert.ok(sc, 'geometry keyed by the feed line "SC"');
  // Two half-shapes stitched → ~2.7 mi loop, far longer than either half alone
  // (the longest single shape is only ~8600 ft).
  assert.ok(sc.lengthFt > 12000, `stitched loop length ${sc.lengthFt} ft spans the whole route`);
  assert.match(sc.shapeId, /\+/, 'shapeId records both stitched halves');
  // distFt is monotonic across the seam (recomputed, not the per-shape GTFS reset).
  for (let i = 1; i < sc.points.length; i++) {
    assert.ok(sc.points[i].distFt >= sc.points[i - 1].distFt, 'distFt is monotonic');
  }
  // Closes back near the start (the loop's two free ends nearly meet).
  const a = sc.points[0];
  const b = sc.points[sc.points.length - 1];
  const gapFt = Math.hypot((b.lat - a.lat) * 364000, (b.lon - a.lon) * 305000);
  assert.ok(gapFt < 600, `loop closes (ends ${Math.round(gapFt)} ft apart)`);
});
