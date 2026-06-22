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
  buildStopMarker,
  buildDashedGapSvg,
  buildDirectionArrow,
  buildClipProgress,
  buildReadoutPill,
  fitTitlePill,
  measureTextWidth,
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
const STOP_MARKER_SIZE = 32;
const HIGHLIGHT_COLOR = '#ffb020';
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
  // `framing` is the tight window (bbox/bearing); the drawn route segments run
  // the FULL length outside the gap (start→gap, gap→end) so the route connects
  // to the home/flag terminals and runs off the frame edges instead of being
  // clipped to the window. Matches CTA src/map/bus/gaps.js.
  const framing = shape.points.filter((p, i) => distAt(p, i) >= lo && distAt(p, i) <= hi);
  const before = shape.points.filter((p, i) => distAt(p, i) <= gapLo);
  const inner = shape.points.filter((p, i) => distAt(p, i) >= gapLo && distAt(p, i) <= gapHi);
  const after = shape.points.filter((p, i) => distAt(p, i) >= gapHi);
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

  // Stop signs + name labels for the stops flanking the gap, so the map names
  // the same stretch the post does ("between A and B"). Pushed off the route on
  // the perpendicular, label riding outward past a bus marker so a bus parked at
  // the stop can't bury it. Ported from cta-insights src/map/bus/gaps.js.
  const stopElements = [];
  for (const s of opts.stopLabels || []) {
    if (s?.lat == null || s?.lon == null) continue;
    const { x, y } = project(
      s.lat,
      s.lon,
      view.centerLat,
      view.centerLon,
      view.zoom,
      WIDTH,
      HEIGHT,
    );
    if (x < 0 || x > WIDTH || y < 0 || y > HEIGHT) continue;
    const perp = perpendicularFromBearing(s.bearing ?? view.bearingDeg);
    stopElements.push(buildStopMarker(x + perp.x * 26, y + perp.y * 26, STOP_MARKER_SIZE));
    const rawName = s.stopName || '';
    if (!rawName) continue;
    const fontSize = 16;
    const labelH = 26;
    const textW = await measureTextWidth(rawName, fontSize, { bold: true });
    const boxW = textW + 16;
    const labelOff = BUS_MARKER_RADIUS + labelH / 2 + 12;
    const cx = x + perp.x * labelOff;
    const cy = y + perp.y * labelOff;
    const lx = Math.max(4, Math.min(WIDTH - boxW - 4, cx - boxW / 2));
    const ly = Math.max(4, Math.min(HEIGHT - labelH - 4, cy - labelH / 2));
    stopElements.push(
      `<rect x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" width="${boxW.toFixed(1)}" height="${labelH}" fill="#000" fill-opacity="0.8" rx="3"/>`,
      `<text x="${(lx + boxW / 2).toFixed(1)}" y="${(ly + 18).toFixed(1)}" fill="#fff" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="600">${xmlEscape(rawName)}</text>`,
    );
  }

  // Wait-stop highlight (gap timelapse): an amber target ring + amber name label
  // marking the gap midpoint the "Next up" bus is closing on. Amber ties it to
  // the gap-strip color language and pops against the route + bus markers.
  const highlightElements = [];
  if (opts.highlightStop?.lat != null) {
    const { x, y } = project(
      opts.highlightStop.lat,
      opts.highlightStop.lon,
      view.centerLat,
      view.centerLon,
      view.zoom,
      WIDTH,
      HEIGHT,
    );
    if (x >= 0 && x <= WIDTH && y >= 0 && y <= HEIGHT) {
      highlightElements.push(
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="22" fill="none" stroke="${HIGHLIGHT_COLOR}" stroke-width="3" opacity="0.45"/>`,
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="14" fill="none" stroke="${HIGHLIGHT_COLOR}" stroke-width="4"/>`,
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${HIGHLIGHT_COLOR}"/>`,
      );
      const name = opts.highlightStop.name || '';
      if (name) {
        const fontSize = 18;
        const labelH = 28;
        const tw = await measureTextWidth(name, fontSize, { bold: true });
        const boxW = tw + 16;
        const perp = perpendicularFromBearing(view.bearingDeg);
        const off = BUS_MARKER_RADIUS + labelH / 2 + 10;
        const overlapsVehicle = (px, py) =>
          placed.some(
            (m) =>
              Math.abs(m.x - px) < BUS_MARKER_RADIUS + boxW / 2 &&
              Math.abs(m.y - py) < BUS_MARKER_RADIUS + labelH / 2,
          );
        let cx = x + perp.x * off;
        let cy = y + perp.y * off;
        if (overlapsVehicle(cx, cy)) {
          cx = x - perp.x * off;
          cy = y - perp.y * off;
        }
        const lx = Math.max(4, Math.min(WIDTH - boxW - 4, cx - boxW / 2));
        const ly = Math.max(4, Math.min(HEIGHT - labelH - 4, cy - labelH / 2));
        highlightElements.push(
          `<rect x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" width="${boxW.toFixed(1)}" height="${labelH}" fill="${HIGHLIGHT_COLOR}" rx="3"/>`,
          `<text x="${(lx + boxW / 2).toFixed(1)}" y="${(ly + fontSize + 5).toFixed(1)}" fill="#1c1c1c" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700">${xmlEscape(name)}</text>`,
        );
      }
    }
  }

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

  // Live "~N-min gap · next bus ~M min to X" HUD pill (gap timelapse), top-left.
  // Takes the spot the title pill occupies on the still map — the two never
  // co-occur (video frames carry the clock + readout, not a title).
  const readoutElements = opts.readout
    ? [
        buildReadoutPill(opts.readout, {
          textWidth: await measureTextWidth(opts.readout, 26, { bold: true }),
        }),
      ]
    : [];

  // Clip-progress scrubber along the bottom edge (video frames pass opts.clock).
  const progress = opts.clock
    ? buildClipProgress({ ...opts.clock, width: WIDTH, height: HEIGHT })
    : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${gapDash}${stopElements.join('\n')}${highlightElements.join('\n')}${terminalElements.join('\n')}${vehicleLayer.join('\n')}${chipLayer.join('\n')}${buildDirectionArrow(WIDTH - 220, 180, view.bearingDeg)}${titleElements.join('\n')}${readoutElements.join('\n')}${progress}</svg>`;
  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

// Stops to sign on the still map: the pair flanking the gap so the map names the
// same "between A and B" stretch as the post. Falls back to the single anchor
// stop (opts.nearStop) when a flank is missing — mirrors the post's "near X".
function gapStopLabels(gap, opts) {
  const flanks = [gap.flankBefore, gap.flankAfter].filter((s) => s?.lat != null && s?.lon != null);
  if (flanks.length) return flanks;
  return opts.nearStop?.lat != null ? [opts.nearStop] : [];
}

async function renderGapMap(gap, shape, stops = [], opts = {}) {
  const view = computeGapView(gap, shape, stops);
  const baseMap = await fetchGapBaseMap(view);
  return renderGapFrame(view, baseMap, gap, stops, {
    ...opts,
    stopLabels: opts.stopLabels || gapStopLabels(gap, opts),
  });
}

module.exports = { renderGapMap, computeGapView, fetchGapBaseMap, renderGapFrame };
