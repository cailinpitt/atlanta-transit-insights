const sharp = require('sharp');
const { encode } = require('../../shared/polyline');
const { cumulativeDistances, bearing } = require('../../shared/geo');
const { fitZoom, project } = require('../../shared/projection');
const { projectToShape } = require('../bus/shapes');
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
  buildReadoutPill,
  markerLabelChip,
  fitTitlePill,
  xmlEscape,
  requireMapboxToken,
  fetchMapboxStatic,
  separateMarkers,
  perpendicularFromBearing,
  thinPolylinePoints,
  paddedBbox,
  bboxOf,
  measureTextWidth,
} = require('./common');
const { displayStationName } = require('../rail/stations');

const LINE_COLORS = {
  RED: 'CE242B',
  GOLD: 'D4A723',
  BLUE: '0075B2',
  GREEN: '009D4B',
};
const TRAIN_RADIUS = 32;
const HIGHLIGHT_COLOR = '#ffb020';
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
  // Pull the flanking stations into the bbox so their name labels stay on-frame:
  // a flank sits just outside its train and would otherwise fall to the very edge
  // (its label then forced onto the train disc). Mirrors the bus gap view.
  const flankPts = [gap.flankBefore, gap.flankAfter, gap.midStation].filter(
    (s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lon),
  );
  const trainPts = [...trains, ...flankPts].filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon),
  );
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

  // White station dots + name pills for the stations flanking the gap, so the
  // map names the same "between A and B" stretch the post does. A flank sits
  // right at its flanking train, so — like the bus gap map — push the dot and
  // label PERPENDICULAR off the route, riding the label outward past the L/N
  // disc, rather than centering on the line where the train would bury it.
  const stationLabelElements = [];
  for (const s of opts.stationLabels || []) {
    if (!Number.isFinite(s?.lat) || !Number.isFinite(s?.lon)) continue;
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
    const perp = perpendicularFromBearing(view.bearingDeg);
    const dx = x + perp.x * (TRAIN_RADIUS + 6);
    const dy = y + perp.y * (TRAIN_RADIUS + 6);
    stationLabelElements.push(
      `<circle cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="12" fill="#fff" stroke="#000" stroke-width="4"/>`,
    );
    const name = displayStationName(s.name || '');
    if (!name) continue;
    const fontSize = 18;
    const labelH = 28;
    const tw = await measureTextWidth(name, fontSize, { bold: true });
    const boxW = tw + 16;
    const labelOff = TRAIN_RADIUS + 6 + 12 + labelH / 2;
    const cx = x + perp.x * labelOff;
    const cy = y + perp.y * labelOff;
    const lx = Math.max(4, Math.min(WIDTH - boxW - 4, cx - boxW / 2));
    const ly = Math.max(4, Math.min(HEIGHT - labelH - 4, cy - labelH / 2));
    stationLabelElements.push(
      `<rect x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" width="${boxW.toFixed(1)}" height="${labelH}" fill="#000" fill-opacity="0.82" rx="3"/>`,
      `<text x="${(lx + boxW / 2).toFixed(1)}" y="${(ly + 19).toFixed(1)}" fill="#fff" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="600">${xmlEscape(name)}</text>`,
    );
  }
  const stationLabelEls = stationLabelElements.join('\n');

  // Wait-stop highlight (gap timelapse): amber target ring + amber name label
  // marking the gap midpoint the "Next up" train is closing on. Same language as
  // the bus gap timelapse.
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
      const name = displayStationName(opts.highlightStop.name || '');
      if (name) {
        const fontSize = 18;
        const labelH = 28;
        const tw = await measureTextWidth(name, fontSize, { bold: true });
        const boxW = tw + 16;
        const perp = perpendicularFromBearing(view.bearingDeg);
        const off = TRAIN_RADIUS + labelH / 2 + 10;
        const overlapsTrain = (px, py) =>
          placed.some(
            (m) =>
              Math.abs(m.x - px) < TRAIN_RADIUS + boxW / 2 &&
              Math.abs(m.y - py) < TRAIN_RADIUS + labelH / 2,
          );
        let cx = x + perp.x * off;
        let cy = y + perp.y * off;
        if (overlapsTrain(cx, cy)) {
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

  const titleElements = [];
  if (opts.title) {
    const { fontSize, pillWidth } = await fitTitlePill(opts.title, 40, WIDTH - 80, { padding: 44 });
    const h = fontSize + 28;
    titleElements.push(
      `<rect x="20" y="20" width="${pillWidth.toFixed(1)}" height="${h}" rx="10" fill="#000" fill-opacity="0.66"/>`,
      `<text x="${(20 + pillWidth / 2).toFixed(1)}" y="${(20 + h / 2 + fontSize * 0.35).toFixed(1)}" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#fff">${xmlEscape(opts.title)}</text>`,
    );
  }

  // Live "~N-min gap · next train ~M min to X" HUD pill (gap timelapse), top-left.
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

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${gapDash}${stationLabelEls}${highlightElements.join('\n')}${trainLayer.join('\n')}${chipLayer.join('\n')}${buildDirectionArrow(WIDTH - 220, 180, view.bearingDeg)}${titleElements.join('\n')}${readoutElements.join('\n')}${progress}</svg>`;
  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

// Stations to label on the still gap map: the pair flanking the gap so the map
// names the same "between A and B" stretch as the post. Falls back to the
// midpoint station when a flank is missing (gap reaching a terminal).
function gapStationLabels(gap) {
  const flanks = [gap.flankBefore, gap.flankAfter].filter(
    (s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lon),
  );
  if (flanks.length) return flanks;
  return Number.isFinite(gap.midStation?.lat) ? [gap.midStation] : [];
}

async function renderRailGapMap(gap, line, opts = {}) {
  const trains = [
    { ...gap.trailing, role: 'N' },
    { ...gap.leading, role: 'L' },
  ];
  const view = gapViewFor(line, gap);
  const baseMap = await fetchBaseMap(view);
  return renderRailFrame(view, baseMap, trains, {
    ...opts,
    stationLabels: opts.stationLabels || gapStationLabels(gap),
  });
}

// Dead-segment ("pulse") framing, mirroring cta-insights renderDisruption: the
// line is drawn solid+bright OUTSIDE the suspended stretch and solid but DIMMED
// (same stroke width, 0.4 opacity, drawn on top) between the two endpoint
// stations, so it reads as "the route line, dimmed" rather than a side-trace.
// White circular markers + name-label pills mark the bracketing stations. The
// disruption carries fromLoc/toLoc ({lat, lon, name}); runLoFt/runHiFt frame the
// split. Reuses gapViewFor's machinery only conceptually — the overlay set is
// built here so the dim segment lands exactly between the stations.
const SUSPENDED_OPACITY = 0.4;

async function renderRailDisruptionMap(disruption, line, opts = {}) {
  const color = lineColor(line.line);
  const fromLoc = disruption.fromLoc;
  const toLoc = disruption.toLoc;
  if (!fromLoc || !toLoc) throw new Error('renderRailDisruptionMap needs fromLoc/toLoc');

  const fFt = projectToShape(line, fromLoc.lat, fromLoc.lon)?.distFt;
  const tFt = projectToShape(line, toLoc.lat, toLoc.lon)?.distFt;
  if (!Number.isFinite(fFt) || !Number.isFinite(tFt)) {
    throw new Error('renderRailDisruptionMap could not project endpoint stations');
  }
  const lo = Math.min(fFt, tFt);
  const hi = Math.max(fFt, tFt);
  const loPt = fFt <= tFt ? [fromLoc.lat, fromLoc.lon] : [toLoc.lat, toLoc.lon];
  const hiPt = fFt <= tFt ? [toLoc.lat, toLoc.lon] : [fromLoc.lat, fromLoc.lon];

  const cum = cumulativeDistances(line.points);
  const distAt = (p, i) => p.distFt ?? cum[i];
  const ll = (p) => [p.lat, p.lon];
  const before = line.points.filter((p, i) => distAt(p, i) < lo).map(ll);
  const inner = line.points.filter((p, i) => distAt(p, i) > lo && distAt(p, i) < hi).map(ll);
  const after = line.points.filter((p, i) => distAt(p, i) > hi).map(ll);

  const active = [];
  if (before.length) active.push([...before, loPt]);
  if (after.length) active.push([hiPt, ...after]);
  const suspended = [[loPt, ...inner, hiPt]];

  const enc = (seg) =>
    encodeURIComponent(
      encode(
        thinPolylinePoints(seg.map((p) => ({ lat: p[0], lon: p[1] }))).map((p) => [p.lat, p.lon]),
      ),
    );
  const overlays = [];
  // Active first (bright halo + core), suspended last so the dim sits on top
  // and isn't bridged by the bright line caps at the join.
  for (const seg of active) {
    if (seg.length < 2) continue;
    overlays.push(
      `path-${ROUTE_HALO_STROKE}+${ROUTE_HALO_COLOR}(${enc(seg)})`,
      `path-${ROUTE_CORE_STROKE}+${color}(${enc(seg)})`,
    );
  }
  for (const seg of suspended) {
    if (seg.length < 2) continue;
    overlays.push(`path-${ROUTE_CORE_STROKE}+${color}-${SUSPENDED_OPACITY}(${enc(seg)})`);
  }

  // Frame on the suspended stretch + buffer; whole-line zoom would lose short
  // suspensions.
  const flatSuspended = suspended.flat();
  const bbox = paddedBbox(bboxOf(flatSuspended), 0.5, 0.02);
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const zoom = Math.min(13, fitZoom(bbox, WIDTH, HEIGHT, 120));

  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  const baseMap = await fetchMapboxStatic(url, 20000);

  const titleEls = [];
  if (opts.title) {
    const { fontSize, pillWidth } = await fitTitlePill(opts.title, 40, WIDTH - 80, { padding: 44 });
    const h = fontSize + 28;
    titleEls.push(
      `<rect x="20" y="20" width="${pillWidth.toFixed(1)}" height="${h}" rx="10" fill="#000" fill-opacity="0.66"/>`,
      `<text x="${(20 + pillWidth / 2).toFixed(1)}" y="${(20 + h / 2 + fontSize * 0.35).toFixed(1)}" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#fff">${xmlEscape(opts.title)}</text>`,
    );
  }

  const fromPx = project(fromLoc.lat, fromLoc.lon, centerLat, centerLon, zoom, WIDTH, HEIGHT);
  const toPx = project(toLoc.lat, toLoc.lon, centerLat, centerLon, zoom, WIDTH, HEIGHT);
  const labels = await pairedStationLabels([
    { name: fromLoc.name, px: fromPx },
    { name: toLoc.name, px: toPx },
  ]);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${titleEls.join('\n')}${labels}</svg>`;
  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

// White circular station markers + black name-label pills (above the dot,
// flipped below when they'd hit the title or collide). Port of cta-insights
// src/map/disruption.js pairedStationLabels.
const DISRUPTION_TITLE_KEEPOUT = { x: 0, y: 0, w: 700, h: 110 };

async function pairedStationLabels(stationPts) {
  const layouts = [];
  for (const s of stationPts) {
    if (!s.name || !Number.isFinite(s.px.x) || !Number.isFinite(s.px.y)) continue;
    const text = displayStationName(s.name);
    const fontSize = 28;
    const pad = 12;
    const textW = await measureTextWidth(text, fontSize, { bold: true });
    const pillW = textW + pad * 2;
    const h = fontSize + pad * 1.4;
    const xPill = Math.round(s.px.x - pillW / 2);
    const above = Math.round(s.px.y - h - 26);
    const below = Math.round(s.px.y + 26);
    const wouldHitTitle =
      above < DISRUPTION_TITLE_KEEPOUT.y + DISRUPTION_TITLE_KEEPOUT.h &&
      xPill < DISRUPTION_TITLE_KEEPOUT.x + DISRUPTION_TITLE_KEEPOUT.w &&
      xPill + pillW > DISRUPTION_TITLE_KEEPOUT.x;
    layouts.push({
      px: s.px,
      text,
      fontSize,
      pad,
      pillW,
      h,
      xPill,
      above,
      below,
      forcedBelow: above < 8 || wouldHitTitle,
    });
  }
  const rectsOverlap = (a, b) =>
    !(a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top);
  const pillRect = (l, y) => ({ left: l.xPill, right: l.xPill + l.pillW, top: y, bottom: y + l.h });
  const ys = layouts.map((l) => (l.forcedBelow ? l.below : l.above));
  for (let i = 0; i < layouts.length; i++) {
    for (let j = i + 1; j < layouts.length; j++) {
      if (!rectsOverlap(pillRect(layouts[i], ys[i]), pillRect(layouts[j], ys[j]))) continue;
      if (!layouts[j].forcedBelow && ys[j] !== layouts[j].below) ys[j] = layouts[j].below;
      else if (!layouts[i].forcedBelow && ys[i] !== layouts[i].below) ys[i] = layouts[i].below;
    }
  }
  return layouts
    .map((l, i) => {
      const y = ys[i];
      return [
        `<rect x="${l.xPill}" y="${y}" width="${Math.round(l.pillW)}" height="${Math.round(l.h)}" fill="#000" fill-opacity="0.82" rx="8"/>`,
        `<text x="${Math.round(l.px.x)}" y="${Math.round(y + l.h - l.pad)}" fill="#fff" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${l.fontSize}" font-weight="600">${xmlEscape(l.text)}</text>`,
        `<circle cx="${Math.round(l.px.x)}" cy="${Math.round(l.px.y)}" r="18" fill="#fff" stroke="#000" stroke-width="5"/>`,
      ].join('');
    })
    .join('\n');
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
  renderRailDisruptionMap,
  lineColor,
  viewFor,
  bunchBounds,
  gapViewFor,
  fetchBaseMap,
  renderRailFrame,
};
