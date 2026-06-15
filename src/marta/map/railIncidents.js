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
  ROUTE_CORE_STROKE,
  buildTrainMarker,
  buildDashedGapSvg,
  buildDirectionArrow,
  markerLabelChip,
  fitTitlePill,
  xmlEscape,
  requireMapboxToken,
  fetchMapboxStatic,
  separateMarkers,
  perpendicularFromBearing,
  thinPolylinePoints,
} = require('./common');

const LINE_COLORS = {
  RED: 'CE242B',
  GOLD: 'D4A723',
  BLUE: '0075B2',
  GREEN: '009D4B',
};
const TRAIN_RADIUS = 32;
const GAP_CONTEXT_FT = 3500;

function lineColor(line) {
  return LINE_COLORS[line] || '00d8ff';
}

function sliceLine(line, loFt, hiFt) {
  const cum = cumulativeDistances(line.points);
  const lo = Math.max(0, loFt);
  const hi = Math.min(line.lengthFt || Infinity, hiFt);
  const slice = line.points.filter(
    (p, i) => (p.distFt ?? cum[i]) >= lo && (p.distFt ?? cum[i]) <= hi,
  );
  return slice.length >= 2 ? slice : line.points;
}

function viewFor(line, trains, { loFt = 0, hiFt = line.lengthFt } = {}) {
  const slice = sliceLine(line, loFt, hiFt);
  const color = lineColor(line.line);
  const encoded = encodeURIComponent(encode(thinPolylinePoints(slice).map((p) => [p.lat, p.lon])));
  const overlays = [
    `path-${ROUTE_HALO_STROKE}+${ROUTE_HALO_COLOR}(${encoded})`,
    `path-${ROUTE_CORE_STROKE}+${color}(${encoded})`,
  ];
  const framePts = trains.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const pts = framePts.length > 0 ? framePts : slice;
  const bbox = {
    minLat: Math.min(...pts.map((p) => p.lat)),
    maxLat: Math.max(...pts.map((p) => p.lat)),
    minLon: Math.min(...pts.map((p) => p.lon)),
    maxLon: Math.max(...pts.map((p) => p.lon)),
  };
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  // Fractional zoom — Mapbox Static accepts it and project() honors it. Flooring
  // here threw away up to a full zoom level (a 2x scale loss), which on a near-
  // straight rail line shrank the route to a small band in the middle of the frame.
  const zoom = Math.max(10, Math.min(17, fitZoom(bbox, WIDTH, HEIGHT, 90)));
  const bearingDeg = slice.length >= 2 ? bearing(slice[0], slice[slice.length - 1]) : 0;
  return { overlays, centerLat, centerLon, zoom, bearingDeg, color };
}

// Gap framing: like viewFor but the route is drawn solid only OUTSIDE the gap,
// and the gap stretch (between the two flanking trains) is handed back as
// `gapPath` so renderRailFrame can dash it in the line color over bare basemap.
// This makes a gap read as a break in service, not just two markers on a line.
function gapViewFor(line, gap, { contextFt = GAP_CONTEXT_FT } = {}) {
  const color = lineColor(line.line);
  const cum = cumulativeDistances(line.points);
  const distAt = (p, i) => p.distFt ?? cum[i];
  const lo = Math.min(gap.trailing.distFt, gap.leading.distFt);
  const hi = Math.max(gap.trailing.distFt, gap.leading.distFt);

  const frameLo = lo - contextFt;
  const frameHi = hi + contextFt;
  const before = line.points.filter((p, i) => distAt(p, i) >= frameLo && distAt(p, i) <= lo);
  const after = line.points.filter((p, i) => distAt(p, i) >= hi && distAt(p, i) <= frameHi);
  const inner = line.points.filter((p, i) => distAt(p, i) >= lo && distAt(p, i) <= hi);
  const framing = line.points.filter((p, i) => distAt(p, i) >= frameLo && distAt(p, i) <= frameHi);

  const overlays = [];
  for (const slice of [before, after]) {
    if (slice.length < 2) continue;
    const encoded = encodeURIComponent(
      encode(thinPolylinePoints(slice).map((p) => [p.lat, p.lon])),
    );
    overlays.push(
      `path-${ROUTE_HALO_STROKE}+${ROUTE_HALO_COLOR}(${encoded})`,
      `path-${ROUTE_CORE_STROKE}+${color}(${encoded})`,
    );
  }

  const trains = [gap.trailing, gap.leading];
  const framePts = framing.length >= 2 ? framing : line.points;
  const trainPts = trains.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const pts = trainPts.length > 0 ? trainPts : framePts;
  const bbox = {
    minLat: Math.min(...pts.map((p) => p.lat)),
    maxLat: Math.max(...pts.map((p) => p.lat)),
    minLon: Math.min(...pts.map((p) => p.lon)),
    maxLon: Math.max(...pts.map((p) => p.lon)),
  };
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const zoom = Math.max(10, Math.min(17, fitZoom(bbox, WIDTH, HEIGHT, 90)));
  const bearingDeg = framePts.length >= 2 ? bearing(framePts[0], framePts[framePts.length - 1]) : 0;
  const gapPath = inner.map((p) => ({ lat: p.lat, lon: p.lon }));
  return { overlays, centerLat, centerLon, zoom, bearingDeg, color, gapPath };
}

async function fetchBaseMap(view) {
  const token = requireMapboxToken();
  const overlayPath = view.overlays.length > 0 ? `${view.overlays.join(',')}/` : '';
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlayPath}${view.centerLon.toFixed(5)},${view.centerLat.toFixed(5)},${view.zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  return fetchMapboxStatic(url, 20000);
}

async function renderRailFrame(view, baseMap, trains, opts = {}) {
  const raw = trains.map((t) =>
    project(t.lat, t.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT),
  );
  const placed = separateMarkers(raw, TRAIN_RADIUS * 2 + 4, {
    axis: perpendicularFromBearing(view.bearingDeg),
  });
  // Colored disc + train glyph + white ring, matching the bus markers. Paint
  // rear-to-front (lead train, highest distFt, drawn last/on top).
  const trainLayer = trains
    .map((t, i) => ({ d: Number(t?.distFt) || Number.NEGATIVE_INFINITY, i }))
    .sort((a, b) => a.d - b.d)
    .map(({ i }) =>
      buildTrainMarker({ x: placed[i].x, y: placed[i].y, radius: TRAIN_RADIUS, color: view.color }),
    );
  // Identity chips in a layer above every disc. Label comes from opts.labels
  // (bunching: position number) or the train's role (gap: N/L); markerLabelChip
  // returns '' for a missing label, so no empty badge is ever drawn.
  const chipLayer = trains.map((t, i) => {
    const label = opts.labels ? opts.labels.get(t.trainId) : (t.role ?? null);
    return markerLabelChip(placed[i].x, placed[i].y, TRAIN_RADIUS, label ?? null);
  });

  // Dashed gap stretch (line color) under the markers, when the view defines one.
  let gapDash = '';
  if (view.gapPath && view.gapPath.length >= 2) {
    const gapPixels = view.gapPath.map((p) =>
      project(p.lat, p.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT),
    );
    gapDash = buildDashedGapSvg(gapPixels, view.color, { coreStroke: ROUTE_CORE_STROKE });
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

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${gapDash}${trainLayer.join('\n')}${chipLayer.join('\n')}${buildDirectionArrow(WIDTH - 220, 180, view.bearingDeg)}${titleElements.join('\n')}</svg>`;
  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function renderRailGapMap(gap, line, opts = {}) {
  const trains = [
    { ...gap.trailing, role: 'N' },
    { ...gap.leading, role: 'L' },
  ];
  const view = gapViewFor(line, gap);
  const baseMap = await fetchBaseMap(view);
  return renderRailFrame(view, baseMap, trains, opts);
}

async function renderRailBunchingMap(bunch, line, opts = {}) {
  const lo = Math.min(...bunch.trains.map((t) => t.distFt)) - GAP_CONTEXT_FT;
  const hi = Math.max(...bunch.trains.map((t) => t.distFt)) + GAP_CONTEXT_FT;
  const view = viewFor(line, bunch.trains, { loFt: lo, hiFt: hi });
  const baseMap = await fetchBaseMap(view);
  return renderRailFrame(view, baseMap, bunch.trains, opts);
}

module.exports = {
  renderRailGapMap,
  renderRailBunchingMap,
  lineColor,
  viewFor,
  gapViewFor,
  fetchBaseMap,
  renderRailFrame,
};
