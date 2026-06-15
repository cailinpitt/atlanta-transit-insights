const sharp = require('sharp');
const { encode } = require('../../shared/polyline');
const { cumulativeDistances, bearing } = require('../../shared/geo');
const { fitZoom, project } = require('../../shared/projection');
const {
  STYLE,
  WIDTH,
  HEIGHT,
  ROUTE_HALO_COLOR,
  ROUTE_HALO_STROKE,
  ROUTE_CORE_COLOR,
  ROUTE_CORE_STROKE,
  TWEMOJI_HOUSE_INNER,
  TWEMOJI_FLAG_INNER,
  buildBusMarker,
  markerLabelChip,
  buildTerminalMarker,
  buildDashedGapSvg,
  buildDirectionArrow,
  fitTitlePill,
  xmlEscape,
  requireMapboxToken,
  fetchMapboxStatic,
  separateMarkers,
  perpendicularFromBearing,
  thinPolylinePoints,
} = require('./common');

const LAST_SEEN_COLOR = '8884ff';
const NEXT_UP_COLOR = 'ff2a6d';
const BUS_MARKER_RADIUS = 34;
const TERMINAL_MARKER_RADIUS = BUS_MARKER_RADIUS;
const CONTEXT_PAD_FT = 1800;

function gapVehicles(gap) {
  return [
    { ...gap.trailing, role: 'N', color: NEXT_UP_COLOR },
    { ...gap.leading, role: 'L', color: LAST_SEEN_COLOR },
  ].filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lon));
}

function gapDistanceWindow(shape, gap, contextFt = CONTEXT_PAD_FT) {
  const dists = [gap.trailing?.distFt, gap.leading?.distFt].filter(Number.isFinite);
  if (dists.length === 0) {
    return { lo: 0, hi: shape.lengthFt || Infinity, gapLo: 0, gapHi: shape.lengthFt || Infinity };
  }
  const gapLo = Math.max(0, Math.min(...dists));
  const gapHi = Math.min(shape.lengthFt || Infinity, Math.max(...dists));
  return {
    lo: Math.max(0, gapLo - contextFt),
    hi: Math.min(shape.lengthFt || Infinity, gapHi + contextFt),
    gapLo,
    gapHi,
  };
}

function splitShapeForGap(shape, gap) {
  const cum = cumulativeDistances(shape.points);
  const { lo, hi, gapLo, gapHi } = gapDistanceWindow(shape, gap);
  const distAt = (p, i) => p.distFt ?? cum[i];
  const framing = shape.points.filter((p, i) => distAt(p, i) >= lo && distAt(p, i) <= hi);
  const before = shape.points.filter((p, i) => distAt(p, i) >= lo && distAt(p, i) <= gapLo);
  const inner = shape.points.filter((p, i) => distAt(p, i) >= gapLo && distAt(p, i) <= gapHi);
  const after = shape.points.filter((p, i) => distAt(p, i) >= gapHi && distAt(p, i) <= hi);
  return {
    framing: framing.length >= 2 ? framing : shape.points,
    before,
    inner,
    after,
  };
}

function computeGapView(gap, shape, extraPoints = []) {
  const { framing, before, inner, after } = splitShapeForGap(shape, gap);
  const overlays = [];
  for (const routeSlice of [before, after]) {
    if (routeSlice.length < 2) continue;
    const routePoints = thinPolylinePoints(routeSlice).map((p) => [p.lat, p.lon]);
    const encoded = encodeURIComponent(encode(routePoints));
    overlays.push(
      `path-${ROUTE_HALO_STROKE}+${ROUTE_HALO_COLOR}(${encoded})`,
      `path-${ROUTE_CORE_STROKE}+${ROUTE_CORE_COLOR}(${encoded})`,
    );
  }
  const gapPath = inner.map((p) => ({ lat: p.lat, lon: p.lon }));
  const vehicles = gapVehicles(gap);
  const flankStops = [gap.flankBefore, gap.flankAfter].filter(
    (s) => s?.lat != null && s?.lon != null,
  );
  const points = [...vehicles, ...flankStops, ...extraPoints].filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon),
  );
  const bboxPoints = points.length > 0 ? points : framing;
  const bbox = {
    minLat: Math.min(...bboxPoints.map((p) => p.lat)),
    maxLat: Math.max(...bboxPoints.map((p) => p.lat)),
    minLon: Math.min(...bboxPoints.map((p) => p.lon)),
    maxLon: Math.max(...bboxPoints.map((p) => p.lon)),
  };
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const zoom = Math.max(10, Math.min(17, fitZoom(bbox, WIDTH, HEIGHT, 90)));
  const bearingDeg = framing.length >= 2 ? bearing(framing[0], framing[framing.length - 1]) : 0;
  const origin = shape.points[0] ? { lat: shape.points[0].lat, lon: shape.points[0].lon } : null;
  const terminal = shape.points.at(-1)
    ? { lat: shape.points.at(-1).lat, lon: shape.points.at(-1).lon }
    : null;
  return { overlays, gapPath, centerLat, centerLon, zoom, bearingDeg, origin, terminal };
}

async function fetchGapBaseMap(view) {
  const token = requireMapboxToken();
  const overlayPath = view.overlays.length > 0 ? `${view.overlays.join(',')}/` : '';
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlayPath}${view.centerLon.toFixed(5)},${view.centerLat.toFixed(5)},${view.zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  return fetchMapboxStatic(url, 20000);
}

async function renderGapFrame(view, baseMap, gap, _stops = [], opts = {}) {
  const gapPixels = (view.gapPath || []).map((p) =>
    project(p.lat, p.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT),
  );
  const gapDash = buildDashedGapSvg(gapPixels, ROUTE_CORE_COLOR, {
    coreStroke: ROUTE_CORE_STROKE,
  });

  const vehicles = gapVehicles(gap);
  const raw = vehicles.map((v) =>
    project(v.lat, v.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT),
  );
  const placed = separateMarkers(raw, BUS_MARKER_RADIUS * 2 + 4, {
    axis: perpendicularFromBearing(view.bearingDeg),
  });
  const vehicleLayer = vehicles.map((v, i) =>
    buildBusMarker({ x: placed[i].x, y: placed[i].y, radius: BUS_MARKER_RADIUS, color: v.color }),
  );
  const chipLayer = vehicles.map((v, i) =>
    markerLabelChip(placed[i].x, placed[i].y, BUS_MARKER_RADIUS, v.role),
  );

  const terminalElements = [];
  for (const [point, glyph] of [
    [view.origin, TWEMOJI_HOUSE_INNER],
    [view.terminal, TWEMOJI_FLAG_INNER],
  ]) {
    if (!point) continue;
    const { x, y } = project(
      point.lat,
      point.lon,
      view.centerLat,
      view.centerLon,
      view.zoom,
      WIDTH,
      HEIGHT,
    );
    if (x < 0 || x > WIDTH || y < 0 || y > HEIGHT) continue;
    terminalElements.push(...buildTerminalMarker(x, y, TERMINAL_MARKER_RADIUS, glyph));
  }

  const titleElements = [];
  if (opts.title) {
    const { fontSize, pillWidth } = await fitTitlePill(opts.title, 40, WIDTH - 80, { padding: 44 });
    const h = fontSize + 28;
    titleElements.push(
      `<rect x="20" y="20" width="${pillWidth.toFixed(1)}" height="${h}" rx="10" fill="#000" fill-opacity="0.66"/>`,
      `<text x="${(20 + pillWidth / 2).toFixed(1)}" y="${(20 + h / 2 + fontSize * 0.35).toFixed(1)}" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#fff">${xmlEscape(opts.title)}</text>`,
    );
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${gapDash}${terminalElements.join('\n')}${vehicleLayer.join('\n')}${chipLayer.join('\n')}${buildDirectionArrow(WIDTH - 220, 180, view.bearingDeg)}${titleElements.join('\n')}</svg>`;
  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function renderGapMap(gap, shape, stops = [], opts = {}) {
  const view = computeGapView(gap, shape, stops);
  const baseMap = await fetchGapBaseMap(view);
  return renderGapFrame(view, baseMap, gap, stops, opts);
}

module.exports = { renderGapMap, computeGapView, fetchGapBaseMap, renderGapFrame };
