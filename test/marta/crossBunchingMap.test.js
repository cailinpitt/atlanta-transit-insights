const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pointsFromCluster,
  clipPathToView,
  buildRoutePathOverlays,
  PALETTE,
} = require('../../src/marta/map/crossBunching');

// pointsFromCluster is pure (no Mapbox); the render itself hits the network and
// is exercised only via the bin. Lock down the normalization: discs carry the
// right number + color group, and the legend matches the post order.
test('pointsFromCluster normalizes members to discs + legend', () => {
  const items = [
    { id: 'a', line: 'RED', lat: 33.75, lon: -84.39 },
    { id: 'b', line: 'GOLD', lat: 33.751, lon: -84.39 },
    { id: 'c', line: 'GOLD', lat: 33.752, lon: -84.39 },
  ];
  const labels = new Map([
    ['a', 3],
    ['b', 1],
    ['c', 2],
  ]);
  const { points, legend } = pointsFromCluster(items, {
    idOf: (it) => it.id,
    groupKeyOf: (it) => it.line,
    labels,
    groupOrder: ['GOLD', 'RED'], // biggest group first, matching the post text
    legendLabelOf: (l) => l,
  });
  const byId = Object.fromEntries(points.map((p, i) => [items[i].id, p]));
  assert.equal(byId.a.label, '3');
  assert.equal(byId.a.groupIndex, 1); // RED
  assert.equal(byId.b.groupIndex, 0); // GOLD
  assert.deepEqual(legend, [
    { label: 'GOLD', groupIndex: 0 },
    { label: 'RED', groupIndex: 1 },
  ]);
});

// A view tight on Five Points. At z14 the frame spans well under ±0.1°, so
// points within ±0.005° are on-screen and points ±0.2° away are far off-screen.
const VIEW = { centerLat: 33.754, centerLon: -84.392, zoom: 14 };

// clipPathToView trims a full line shape down to the rendered frame, keeping one
// outside point past each boundary crossing so the line runs to (and off) the
// edge instead of stopping short.
test('clipPathToView keeps the on-frame stretch plus boundary continuity', () => {
  const c = VIEW.centerLat;
  const points = [
    { lat: c - 0.5, lon: -84.392 }, // far south, both neighbors outside → dropped
    { lat: c - 0.2, lon: -84.392 }, // outside, but next point is on-screen → kept
    { lat: c - 0.005, lon: -84.392 }, // on-screen → kept
    { lat: c, lon: -84.392 }, // on-screen → kept
    { lat: c + 0.005, lon: -84.392 }, // on-screen → kept
    { lat: c + 0.2, lon: -84.392 }, // outside, but prev point is on-screen → kept
    { lat: c + 0.5, lon: -84.392 }, // far north, both neighbors outside → dropped
  ];
  const kept = clipPathToView(points, VIEW);
  assert.deepEqual(
    kept.map((p) => Number((p.lat - c).toFixed(3))),
    [-0.2, -0.005, 0, 0.005, 0.2],
  );
});

test('clipPathToView returns [] when nothing lands near the frame', () => {
  const points = [
    { lat: 30.0, lon: -80.0 },
    { lat: 30.1, lon: -80.1 },
  ];
  assert.deepEqual(clipPathToView(points, VIEW), []);
});

// buildRoutePathOverlays emits a black halo + line-colored core per path, all
// halos before all cores (so a crossing core never hides under another halo),
// and skips paths that clip away to nothing.
test('buildRoutePathOverlays draws halo-then-core colored by group', () => {
  const routePaths = [
    {
      groupIndex: 0,
      points: [
        { lat: 33.755, lon: -84.392 },
        { lat: 33.753, lon: -84.392 },
      ],
    },
    {
      groupIndex: 1,
      points: [
        { lat: 33.754, lon: -84.393 },
        { lat: 33.754, lon: -84.391 },
      ],
    },
    // Clips to nothing — skipped entirely.
    {
      groupIndex: 2,
      points: [
        { lat: 10.0, lon: 10.0 },
        { lat: 10.1, lon: 10.1 },
      ],
    },
  ];
  const overlays = buildRoutePathOverlays(routePaths, VIEW);
  assert.equal(overlays.length, 4); // 2 halos + 2 cores
  assert.ok(overlays[0].startsWith('path-11+000('));
  assert.ok(overlays[1].startsWith('path-11+000('));
  assert.ok(overlays[2].startsWith(`path-6+${PALETTE[0]}(`));
  assert.ok(overlays[3].startsWith(`path-6+${PALETTE[1]}(`));
});

// Per-group color overrides (official line colors) win over the palette for the
// route-line core.
test('buildRoutePathOverlays uses per-group color overrides', () => {
  const routePaths = [
    {
      groupIndex: 0,
      points: [
        { lat: 33.755, lon: -84.392 },
        { lat: 33.753, lon: -84.392 },
      ],
    },
  ];
  const overlays = buildRoutePathOverlays(routePaths, VIEW, ['CE242B']);
  assert.equal(overlays.length, 2);
  assert.ok(overlays[1].startsWith('path-6+CE242B(')); // official RED, not PALETTE[0]
});

test('buildRoutePathOverlays returns [] with no paths', () => {
  assert.deepEqual(buildRoutePathOverlays([], VIEW), []);
  assert.deepEqual(buildRoutePathOverlays(undefined, VIEW), []);
});
