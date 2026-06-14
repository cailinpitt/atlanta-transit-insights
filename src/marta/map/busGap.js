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
  buildStopDot,
  buildDirectionArrow,
  fitTitlePill,
  xmlEscape,
  requireMapboxToken,
  fetchMapboxStatic,
  separateMarkers,
  perpendicularFromBearing,
} = require('./common');

const LAST_SEEN_COLOR = '8884ff';
const NEXT_UP_COLOR = 'ff2a6d';
const BUS_MARKER_RADIUS = 34;
const TERMINAL_MARKER_RADIUS = BUS_MARKER_RADIUS;
const STOP_DOT_RADIUS = 7;
const CONTEXT_PAD_FT = 1800;

function gapVehicles(gap) {
  return [
    { ...gap.trailing, role: 'N', color: NEXT_UP_COLOR },
    { ...gap.leading, role: 'L', color: LAST_SEEN_COLOR },
  ].filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lon));
}

function sliceShapeAroundGap(shape, gap) {
  const cum = cumulativeDistances(shape.points);
  const dists = [gap.trailing?.distFt, gap.leading?.distFt].filter(Number.isFinite);
  if (dists.length === 0) return shape.points;
  const lo = Math.max(0, Math.min(...dists) - CONTEXT_PAD_FT);
  const hi = Math.min(shape.lengthFt || Infinity, Math.max(...dists) + CONTEXT_PAD_FT);
  const slice = shape.points.filter(
    (p, i) => (p.distFt ?? cum[i]) >= lo && (p.distFt ?? cum[i]) <= hi,
  );
  return slice.length >= 2 ? slice : shape.points;
}

function computeGapView(gap, shape, stops = []) {
  const slice = sliceShapeAroundGap(shape, gap);
  const encoded = encodeURIComponent(encode(shape.points.map((p) => [p.lat, p.lon])));
  const overlays = [
    `path-${ROUTE_HALO_STROKE}+${ROUTE_HALO_COLOR}(${encoded})`,
    `path-${ROUTE_CORE_STROKE}+${ROUTE_CORE_COLOR}(${encoded})`,
  ];
  const vehicles = gapVehicles(gap);
  const points = [...slice, ...vehicles, ...stops];
  const allLats = points.map((p) => p.lat);
  const allLons = points.map((p) => p.lon);
  const bbox = {
    minLat: Math.min(...allLats),
    maxLat: Math.max(...allLats),
    minLon: Math.min(...allLons),
    maxLon: Math.max(...allLons),
  };
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const zoom = Math.max(10, Math.min(17, Math.floor(fitZoom(bbox, WIDTH, HEIGHT, 90))));
  const bearingDeg = slice.length >= 2 ? bearing(slice[0], slice[slice.length - 1]) : 0;
  const origin = shape.points[0] ? { lat: shape.points[0].lat, lon: shape.points[0].lon } : null;
  const terminal = shape.points.at(-1)
    ? { lat: shape.points.at(-1).lat, lon: shape.points.at(-1).lon }
    : null;
  return { overlays, centerLat, centerLon, zoom, bearingDeg, origin, terminal };
}

async function fetchGapBaseMap(view) {
  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${view.overlays.join(',')}/${view.centerLon.toFixed(5)},${view.centerLat.toFixed(5)},${view.zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  return fetchMapboxStatic(url, 20000);
}

async function renderGapFrame(view, baseMap, gap, stops = [], opts = {}) {
  const stopElements = [];
  for (const s of stops) {
    const p = project(s.lat, s.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT);
    if (p.x < 0 || p.x > WIDTH || p.y < 0 || p.y > HEIGHT) continue;
    stopElements.push(buildStopDot(p.x, p.y, STOP_DOT_RADIUS));
  }

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

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${stopElements.join('\n')}${terminalElements.join('\n')}${vehicleLayer.join('\n')}${chipLayer.join('\n')}${buildDirectionArrow(WIDTH - 220, 180, view.bearingDeg)}${titleElements.join('\n')}</svg>`;
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
