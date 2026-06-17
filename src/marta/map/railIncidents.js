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
  buildClipProgress,
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
const BUNCH_CONTEXT_FT = 3500; // feet of line context on each side of a bunch

function lineColor(line) {
  return LINE_COLORS[line] || '00d8ff';
}

// Line geometry runs in one fixed order (ascending distFt); a train's
// motionSign says whether it travels with that order (+1) or against it (-1).
// Return the sign the most trains share so the direction arrow can point the
// way the cluster is actually moving, not just along the geometry.
function dominantTravelSign(trains) {
  const counts = new Map();
  for (const t of trains || []) {
    if (t?.motionSign == null) continue;
    counts.set(t.motionSign, (counts.get(t.motionSign) || 0) + 1);
  }
  let best = null;
  let bestCount = -1;
  for (const [sign, n] of counts) {
    if (n > bestCount) {
      bestCount = n;
      best = sign;
    }
  }
  return best;
}

// Bearing along `pts` in travel order: reversed when the trains move against
// the geometry's ascending-distFt order (travelSign === -1).
function travelBearing(pts, travelSign) {
  if (!pts || pts.length < 2) return 0;
  const [a, b] = travelSign === -1 ? [pts[pts.length - 1], pts[0]] : [pts[0], pts[pts.length - 1]];
  return bearing(a, b);
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

function viewFor(line, trains, { loFt = 0, hiFt = line.lengthFt, travelSign } = {}) {
  const slice = loFt === 0 && hiFt === line.lengthFt ? line.points : sliceLine(line, loFt, hiFt);
  const color = lineColor(line.line);
  // Draw the FULL line as the overlay so it runs off the frame edges (bus
  // bunching parity); the bbox/zoom below still frame tightly to the bunch
  // slice. Drawing only the slice left the line ending mid-frame as a clipped
  // stub instead of reading as a continuous line passing through the cluster.
  const encoded = encodeURIComponent(
    encode(thinPolylinePoints(line.points).map((p) => [p.lat, p.lon])),
  );
  const overlays = [
    `path-${ROUTE_HALO_STROKE}+${ROUTE_HALO_COLOR}(${encoded})`,
    `path-${ROUTE_CORE_STROKE}+${color}(${encoded})`,
  ];
  const pts = slice;
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
  const zoom = Math.max(9, Math.min(17, fitZoom(bbox, WIDTH, HEIGHT, 110)));
  const sign = travelSign ?? dominantTravelSign(trains);
  const bearingDeg = travelBearing(slice, sign);
  return { overlays, centerLat, centerLon, zoom, bearingDeg, color };
}

// Gap framing: like viewFor but the route is drawn solid only OUTSIDE the gap,
// and the gap stretch (between the two flanking trains) is handed back as
// `gapPath` so renderRailFrame can dash it in the line color over bare basemap.
// This makes a gap read as a break in service, not just two markers on a line.
function gapViewFor(line, gap, { contextFt = GAP_CONTEXT_FT, travelSign } = {}) {
  const color = lineColor(line.line);
  const cum = cumulativeDistances(line.points);
  const distAt = (p, i) => p.distFt ?? cum[i];
  const lo = Math.min(gap.trailing.distFt, gap.leading.distFt);
  const hi = Math.max(gap.trailing.distFt, gap.leading.distFt);

  const frameLo = lo - contextFt;
  const frameHi = hi + contextFt;
  // Draw the line solid its full length OUTSIDE the gap (start→gap, gap→end) so
  // it runs off the frame edges instead of ending mid-frame; the bbox/zoom below
  // still frame tight to the gap ±context.
  const before = line.points.filter((p, i) => distAt(p, i) <= lo);
  const after = line.points.filter((p, i) => distAt(p, i) >= hi);
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
  const sign = travelSign ?? dominantTravelSign([gap.trailing, gap.leading]);
  const bearingDeg = travelBearing(framePts, sign);
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

  // Clip-progress scrubber along the bottom edge (video frames pass opts.clock).
  const progress = opts.clock
    ? buildClipProgress({ ...opts.clock, width: WIDTH, height: HEIGHT })
    : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${gapDash}${trainLayer.join('\n')}${chipLayer.join('\n')}${buildDirectionArrow(WIDTH - 220, 180, view.bearingDeg)}${titleElements.join('\n')}${progress}</svg>`;
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

// Distance window around a rail bunch (min→max train distFt) with context on
// each side, for framing. Mirrors the gap framing so a bunch zooms to the
// cluster instead of fitting the whole line. Trains carry a projected distFt;
// if none are finite, fall back to the full line.
function bunchBounds(line, trains, contextFt = BUNCH_CONTEXT_FT) {
  const dists = trains.map((t) => t.distFt).filter((d) => Number.isFinite(d));
  if (dists.length === 0) return { loFt: 0, hiFt: line.lengthFt };
  return { loFt: Math.min(...dists) - contextFt, hiFt: Math.max(...dists) + contextFt };
}

async function renderRailBunchingMap(bunch, line, opts = {}) {
  const view = viewFor(line, bunch.trains, bunchBounds(line, bunch.trains));
  const baseMap = await fetchBaseMap(view);
  return renderRailFrame(view, baseMap, bunch.trains, opts);
}

module.exports = {
  renderRailGapMap,
  renderRailBunchingMap,
  lineColor,
  viewFor,
  bunchBounds,
  gapViewFor,
  fetchBaseMap,
  renderRailFrame,
};
