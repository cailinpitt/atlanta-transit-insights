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
  buildDirectionArrow,
  buildNumberBadge,
  markerLabelChip,
  fitTitlePill,
  xmlEscape,
  requireMapboxToken,
  fetchMapboxStatic,
  separateMarkers,
  perpendicularFromBearing,
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
  const encoded = encodeURIComponent(encode(line.points.map((p) => [p.lat, p.lon])));
  const overlays = [
    `path-${ROUTE_HALO_STROKE}+${ROUTE_HALO_COLOR}(${encoded})`,
    `path-${ROUTE_CORE_STROKE}+${color}(${encoded})`,
  ];
  const pts = [...slice, ...trains];
  const bbox = {
    minLat: Math.min(...pts.map((p) => p.lat)),
    maxLat: Math.max(...pts.map((p) => p.lat)),
    minLon: Math.min(...pts.map((p) => p.lon)),
    maxLon: Math.max(...pts.map((p) => p.lon)),
  };
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const zoom = Math.max(10, Math.min(17, Math.floor(fitZoom(bbox, WIDTH, HEIGHT, 90))));
  const bearingDeg = slice.length >= 2 ? bearing(slice[0], slice[slice.length - 1]) : 0;
  return { overlays, centerLat, centerLon, zoom, bearingDeg, color };
}

async function fetchBaseMap(view) {
  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${view.overlays.join(',')}/${view.centerLon.toFixed(5)},${view.centerLat.toFixed(5)},${view.zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  return fetchMapboxStatic(url, 20000);
}

async function renderRailFrame(view, baseMap, trains, opts = {}) {
  const raw = trains.map((t) =>
    project(t.lat, t.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT),
  );
  const placed = separateMarkers(raw, TRAIN_RADIUS * 2 + 4, {
    axis: perpendicularFromBearing(view.bearingDeg),
  });
  const trainLayer = trains.map((_, i) =>
    [
      `<circle cx="${placed[i].x}" cy="${placed[i].y}" r="${TRAIN_RADIUS}" fill="#${view.color}"/>`,
      `<circle cx="${placed[i].x}" cy="${placed[i].y}" r="${TRAIN_RADIUS}" fill="none" stroke="#fff" stroke-width="4"/>`,
    ].join(''),
  );
  const chipLayer = trains.map((t, i) =>
    opts.labels
      ? markerLabelChip(placed[i].x, placed[i].y, TRAIN_RADIUS, opts.labels.get(t.trainId))
      : buildNumberBadge(
          placed[i].x + TRAIN_RADIUS * 0.66,
          placed[i].y - TRAIN_RADIUS * 0.66,
          TRAIN_RADIUS * 0.5,
          t.role || '',
        ),
  );

  const titleElements = [];
  if (opts.title) {
    const { fontSize, pillWidth } = await fitTitlePill(opts.title, 40, WIDTH - 80, { padding: 44 });
    const h = fontSize + 28;
    titleElements.push(
      `<rect x="20" y="20" width="${pillWidth.toFixed(1)}" height="${h}" rx="10" fill="#000" fill-opacity="0.66"/>`,
      `<text x="${(20 + pillWidth / 2).toFixed(1)}" y="${(20 + h / 2 + fontSize * 0.35).toFixed(1)}" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#fff">${xmlEscape(opts.title)}</text>`,
    );
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${trainLayer.join('\n')}${chipLayer.join('\n')}${buildDirectionArrow(WIDTH - 220, 180, view.bearingDeg)}${titleElements.join('\n')}</svg>`;
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
  const view = viewFor(line, trains, {
    loFt: Math.min(gap.trailing.distFt, gap.leading.distFt) - GAP_CONTEXT_FT,
    hiFt: Math.max(gap.trailing.distFt, gap.leading.distFt) + GAP_CONTEXT_FT,
  });
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

module.exports = { renderRailGapMap, renderRailBunchingMap, lineColor };
