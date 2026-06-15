// MARTA bus bunching map. Ported from cta-insights src/map/bus/bunching.js,
// simplified for the still-image slice: no traffic-signal layer (CTA-only), no
// fleet/articulated branch, no video framing / gap-dash. The CTA "pattern" is
// the trip's GTFS shape here — `shape.points` are { lat, lon, distFt } ordered
// origin→destination, the same role CTA's seq-ordered pattern points play.
const sharp = require('sharp');
const { encode } = require('../../shared/polyline');
const { bearing, cumulativeDistances, haversineFt } = require('../../shared/geo');
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
  buildStopMarker,
  buildDirectionArrow,
  fitTitlePill,
  xmlEscape,
  requireMapboxToken,
  fetchMapboxStatic,
  separateMarkers,
  perpendicularFromBearing,
  thinPolylinePoints,
} = require('./common');

const BUS_COLOR = 'ff2a6d'; // hot pink/red reads well on dark
const CONTEXT_PAD_FT = 1500; // feet of route context on each side of the bunch
const BUS_MARKER_RADIUS = 34;
const TERMINAL_MARKER_RADIUS = BUS_MARKER_RADIUS;
const STOP_MARKER_SIZE = 32;
// Push stops sideways off the route so the route line stays unbroken. Offset is
// in the right-of-travel direction (perpendicular to view bearing).
const STOP_OFFSET_PX = 22;

// Walk the GTFS shape building a cumulative distance, find each bunched
// vehicle's nearest shape point by straight-line proximity, and return the
// shape stretch within CONTEXT_PAD_FT of that range. We match by geographic
// proximity rather than trusting a vehicle's own distFt so one mis-projected
// outlier can't blow the slice open to the whole route.
function sliceShapeAroundBunch(shape, vehicles) {
  const points = shape.points || [];
  if (points.length < 2 || vehicles.length === 0) return points;
  const cum = cumulativeDistances(points);
  const distAt = (i) => points[i].distFt ?? cum[i];
  const vehicleDists = vehicles.map((v) => {
    let bestIdx = 0;
    let bestDist = haversineFt(v, points[0]);
    for (let i = 1; i < points.length; i++) {
      const d = haversineFt(v, points[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return distAt(bestIdx);
  });
  const lo = Math.min(...vehicleDists) - CONTEXT_PAD_FT;
  const hi = Math.max(...vehicleDists) + CONTEXT_PAD_FT;
  const slice = points.filter((_, i) => distAt(i) >= lo && distAt(i) <= hi);
  return slice.length >= 2 ? slice : points;
}

// Static framing: bbox, center, zoom, route polyline overlay, direction arrow,
// origin/terminal points. The bbox frames tightly around the bunched vehicles
// (±CONTEXT_PAD_FT) — NOT the whole route — so the impact reads clearly at a
// glance; the full route still draws as the overlay and runs off the frame
// edges. Matches cta-insights src/map/bus/bunching.js. Video captures pass
// extraVehicles so the viewport stays stable as buses move across frames.
function computeBunchingView(bunch, shape, extraVehicles = []) {
  const routeShape = shape.points || [];
  const routePoints = thinPolylinePoints(routeShape).map((p) => [p.lat, p.lon]);
  const encoded = encodeURIComponent(encode(routePoints));
  const overlays = [
    `path-${ROUTE_HALO_STROKE}+${ROUTE_HALO_COLOR}(${encoded})`,
    `path-${ROUTE_CORE_STROKE}+${ROUTE_CORE_COLOR}(${encoded})`,
  ];

  // Slice around the bunch itself; expand the bbox to also cover any extra
  // (video) vehicle positions so later frames don't drift off-screen.
  const slice = sliceShapeAroundBunch(shape, bunch.vehicles);
  const framingVehicles = [...bunch.vehicles, ...extraVehicles];
  const allLats = [...slice.map((p) => p.lat), ...framingVehicles.map((v) => v.lat)];
  const allLons = [...slice.map((p) => p.lon), ...framingVehicles.map((v) => v.lon)];
  const bbox = {
    minLat: Math.min(...allLats),
    maxLat: Math.max(...allLats),
    minLon: Math.min(...allLons),
    maxLon: Math.max(...allLons),
  };
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const rawZoom = fitZoom(bbox, WIDTH, HEIGHT, 60);
  const zoom = Math.max(10, Math.min(17, rawZoom));

  // Local direction along the framed slice (GTFS shape runs origin→destination),
  // not the whole route — so the arrow tracks the bunch's stretch.
  const bearingDeg = slice.length >= 2 ? bearing(slice[0], slice[slice.length - 1]) : 0;

  const originPoint = shape.points[0];
  const terminalPoint = shape.points[shape.points.length - 1];
  const origin = originPoint ? { lat: originPoint.lat, lon: originPoint.lon } : null;
  const terminal = terminalPoint ? { lat: terminalPoint.lat, lon: terminalPoint.lon } : null;

  return { overlays, centerLat, centerLon, zoom, bearingDeg, bbox, origin, terminal };
}

async function fetchBunchingBaseMap(view) {
  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${view.overlays.join(',')}/${view.centerLon.toFixed(5)},${view.centerLat.toFixed(5)},${view.zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  return fetchMapboxStatic(url, 20000);
}

// Composite numbered bus markers, stop signs, origin/terminal glyphs, the
// direction arrow, and an optional title pill onto the base map.
async function renderBunchingFrame(view, baseMap, vehicles, stops = [], opts = {}) {
  // Stops render below buses (so a bus sitting at a stop still reads on top),
  // pushed perpendicular to the local segment so the glyph sits beside the route.
  const placedStops = [];
  const minSeparation = STOP_MARKER_SIZE + 6;
  const stopElements = [];
  for (const s of stops) {
    const perp = perpendicularFromBearing(s.bearing ?? view.bearingDeg);
    const p = project(s.lat, s.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT);
    const x = p.x + perp.x * STOP_OFFSET_PX;
    const y = p.y + perp.y * STOP_OFFSET_PX;
    if (x < 0 || x > WIDTH || y < 0 || y > HEIGHT) continue;
    if (placedStops.some((q) => Math.hypot(q.x - x, q.y - y) < minSeparation)) continue;
    placedStops.push({ x, y });
    stopElements.push(buildStopMarker(x, y, STOP_MARKER_SIZE));
  }

  // Nudge markers apart so a tight bunch still shows every vehicle. Push
  // sideways (perpendicular to route bearing) so buses on a straight road don't
  // look further ahead/behind than they are.
  const rawMarkerPixels = vehicles.map((v) =>
    project(v.lat, v.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT),
  );
  const markerPixels = separateMarkers(rawMarkerPixels, BUS_MARKER_RADIUS * 2 + 4, {
    axis: perpendicularFromBearing(view.bearingDeg),
  });
  const labels = opts.labels || null;

  // Paint buses rear-to-front (lead bus, highest distFt, drawn last/on top).
  const vehicleLayer = vehicles
    .map((v, i) => ({ d: Number(v?.distFt) || Number.NEGATIVE_INFINITY, v, i }))
    .sort((a, b) => a.d - b.d)
    .map(({ i }) =>
      buildBusMarker({
        x: markerPixels[i].x,
        y: markerPixels[i].y,
        radius: BUS_MARKER_RADIUS,
        color: BUS_COLOR,
      }),
    );
  // Identity chips in their own layer ABOVE every disc.
  const chipLayer = labels
    ? vehicles.map((v, i) =>
        markerLabelChip(
          markerPixels[i].x,
          markerPixels[i].y,
          BUS_MARKER_RADIUS,
          labels.get(v?.vehicleId) ?? null,
        ),
      )
    : [];

  const arrowElements = [buildDirectionArrow(WIDTH - 220, 180, view.bearingDeg)];

  // Origin (house) + destination (flag), below buses, skipped if off-viewport.
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

  // Optional title pill, top-left — lets the standalone image (web archive)
  // carry its route/direction even without the post text.
  const titleElements = [];
  if (opts.title) {
    const baseFont = 40;
    const { fontSize, pillWidth } = await fitTitlePill(opts.title, baseFont, WIDTH - 80, {
      padding: 44,
    });
    const h = fontSize + 28;
    titleElements.push(
      `<rect x="20" y="20" width="${pillWidth.toFixed(1)}" height="${h}" rx="10" fill="#000" fill-opacity="0.66"/>`,
      `<text x="${(20 + pillWidth / 2).toFixed(1)}" y="${(20 + h / 2 + fontSize * 0.35).toFixed(1)}" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#fff">${xmlEscape(opts.title)}</text>`,
    );
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${stopElements.join('\n')}${terminalElements.join('\n')}${vehicleLayer.join('\n')}${chipLayer.join('\n')}${arrowElements.join('\n')}${titleElements.join('\n')}</svg>`;
  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function renderBunchingMap(bunch, shape, stops = [], opts = {}) {
  const view = computeBunchingView(bunch, shape);
  const baseMap = await fetchBunchingBaseMap(view);
  return renderBunchingFrame(view, baseMap, bunch.vehicles, stops, {
    labels: opts.labels || null,
    title: opts.title || null,
  });
}

module.exports = {
  renderBunchingMap,
  computeBunchingView,
  fetchBunchingBaseMap,
  renderBunchingFrame,
};
