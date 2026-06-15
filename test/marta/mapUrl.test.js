const test = require('node:test');
const assert = require('node:assert/strict');

const { WIDTH, HEIGHT, STYLE } = require('../../src/marta/map/common');
const { computeGapView } = require('../../src/marta/map/busGap');
const { computeBunchingView } = require('../../src/marta/map/busBunching');
const { viewFor, gapViewFor } = require('../../src/marta/map/railIncidents');

function denseShape(pointCount = 1600) {
  const points = [];
  for (let i = 0; i < pointCount; i++) {
    const t = i / (pointCount - 1);
    points.push({
      lat: 33.7 + t * 0.18 + Math.sin(t * Math.PI * 18) * 0.001,
      lon: -84.35 + t * 0.22 + Math.cos(t * Math.PI * 15) * 0.001,
      distFt: t * 95_000,
    });
  }
  return { shapeId: '136213', points, lengthFt: 95_000 };
}

function staticUrlLength(view) {
  const token = 'test-token';
  return `https://api.mapbox.com/styles/v1/${STYLE}/static/${view.overlays.join(',')}/${view.centerLon.toFixed(5)},${view.centerLat.toFixed(5)},${view.zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`
    .length;
}

test('MARTA bus gap map overlays are short enough for dense long routes', () => {
  const shape = denseShape();
  const gap = {
    leading: { lat: shape.points[1420].lat, lon: shape.points[1420].lon, distFt: 84_000 },
    trailing: { lat: shape.points[80].lat, lon: shape.points[80].lon, distFt: 5_000 },
  };

  assert.ok(staticUrlLength(computeGapView(gap, shape)) < 8000);
});

test('MARTA bus gap view exposes the empty stretch as a dashed path', () => {
  const shape = denseShape();
  const gap = {
    leading: { lat: shape.points[920].lat, lon: shape.points[920].lon, distFt: 55_000 },
    trailing: { lat: shape.points[760].lat, lon: shape.points[760].lon, distFt: 45_000 },
  };
  const view = computeGapView(gap, shape);

  assert.ok(view.gapPath.length >= 2);
  assert.ok(view.overlays.length > 0);
  assert.ok(staticUrlLength(view) < 8000);
});

test('MARTA bus bunching map overlays are short enough for dense long routes', () => {
  const shape = denseShape();
  const bunch = {
    vehicles: [
      { lat: shape.points[900].lat, lon: shape.points[900].lon, distFt: 53_000 },
      { lat: shape.points[920].lat, lon: shape.points[920].lon, distFt: 54_000 },
      { lat: shape.points[940].lat, lon: shape.points[940].lon, distFt: 55_000 },
    ],
  };

  assert.ok(staticUrlLength(computeBunchingView(bunch, shape)) < 8000);
});

test('MARTA rail gap map overlays are short enough for dense long lines', () => {
  const line = { line: 'BLUE', ...denseShape() };
  const gap = {
    trailing: { lat: line.points[80].lat, lon: line.points[80].lon, distFt: 5_000 },
    leading: { lat: line.points[1420].lat, lon: line.points[1420].lon, distFt: 84_000 },
  };
  const view = gapViewFor(line, gap);

  assert.ok(view.gapPath.length >= 2);
  assert.ok(staticUrlLength(view) < 8000);
});

test('MARTA rail bunching map overlays are short enough for dense long lines', () => {
  const line = { line: 'BLUE', ...denseShape() };
  const trains = [
    { lat: line.points[900].lat, lon: line.points[900].lon, distFt: 53_000 },
    { lat: line.points[920].lat, lon: line.points[920].lon, distFt: 54_000 },
    { lat: line.points[940].lat, lon: line.points[940].lon, distFt: 55_000 },
  ];
  const view = viewFor(line, trains, {
    loFt: Math.min(...trains.map((t) => t.distFt)) - 3500,
    hiFt: Math.max(...trains.map((t) => t.distFt)) + 3500,
  });

  assert.ok(staticUrlLength(view) < 8000);
});
