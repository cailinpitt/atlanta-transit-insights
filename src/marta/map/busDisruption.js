const sharp = require('sharp');
const { encode } = require('../../shared/polyline');
const { fitZoom, project } = require('../../shared/projection');
const {
  STYLE,
  WIDTH,
  HEIGHT,
  ROUTE_HALO_COLOR,
  ROUTE_HALO_STROKE,
  ROUTE_CORE_COLOR,
  ROUTE_CORE_STROKE,
  fitTitlePill,
  xmlEscape,
  requireMapboxToken,
  fetchMapboxStatic,
  measureTextWidth,
  thinPolylinePoints,
  paddedBbox,
  bboxOf,
} = require('./common');

// Blackout ("pulse") map: the whole route drawn solid but DIMMED end-to-end to
// read as "no buses running", with a title pill and both terminals labeled.
// Port of cta-insights src/map/bus/disruption.js#renderBusDisruptionRich
// (blackout mode only — MARTA defers the held-cluster focus-zone variant).
const DIM_OPACITY = 0.4;
const TITLE_KEEPOUT = { w: 700, h: 110 };

// White circular endpoint markers + black name pills for the two terminals.
// Pill sits above the dot, flipping below when it would run off the top edge or
// collide with the title pill.
async function terminalLabels(pts, centerLat, centerLon, zoom) {
  const out = [];
  for (const s of pts) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const { x, y } = project(s.lat, s.lon, centerLat, centerLon, zoom, WIDTH, HEIGHT);
    if (x < 0 || x > WIDTH || y < 0 || y > HEIGHT) continue;
    out.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="16" fill="#fff" stroke="#000" stroke-width="5"/>`,
    );
    if (!s.name) continue;
    const fontSize = 28;
    const pad = 12;
    const tw = await measureTextWidth(s.name, fontSize, { bold: true });
    const pillW = tw + pad * 2;
    const h = fontSize + pad * 1.4;
    const xPill = Math.max(4, Math.min(WIDTH - pillW - 4, x - pillW / 2));
    let yPill = y - h - 26;
    const hitsTitle = yPill < TITLE_KEEPOUT.h && xPill < TITLE_KEEPOUT.w;
    if (yPill < 8 || hitsTitle) yPill = y + 26;
    yPill = Math.max(4, Math.min(HEIGHT - h - 4, yPill));
    out.push(
      `<rect x="${xPill.toFixed(1)}" y="${yPill.toFixed(1)}" width="${pillW.toFixed(1)}" height="${h.toFixed(1)}" fill="#000" fill-opacity="0.82" rx="8"/>`,
      `<text x="${(xPill + pillW / 2).toFixed(1)}" y="${(yPill + h - pad).toFixed(1)}" fill="#fff" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="600">${xmlEscape(s.name)}</text>`,
    );
  }
  return out.join('\n');
}

// shape: { points: [{lat, lon, distFt}], lengthFt } (bus shapes from loadShapes).
// fromName/toName label the shape's first/last point (the two terminals).
async function renderBusDisruptionMap(shape, { title, fromName, toName } = {}) {
  const points = (shape?.points || []).filter(
    (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon),
  );
  if (points.length < 2) return null;

  const enc = encodeURIComponent(encode(thinPolylinePoints(points).map((p) => [p.lat, p.lon])));
  // Halo + dimmed core, no bright stretch: the whole route is "off the air".
  const overlays = [
    `path-${ROUTE_HALO_STROKE}+${ROUTE_HALO_COLOR}(${enc})`,
    `path-${ROUTE_CORE_STROKE}+${ROUTE_CORE_COLOR}-${DIM_OPACITY}(${enc})`,
  ];

  const bbox = paddedBbox(bboxOf(points), 0.1, 0.01);
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const zoom = Math.max(8, Math.min(15, fitZoom(bbox, WIDTH, HEIGHT, 80)));

  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  if (url.length > 8000) return null;
  const baseMap = await fetchMapboxStatic(url, 20000);

  const titleEls = [];
  if (title) {
    const { fontSize, pillWidth } = await fitTitlePill(title, 40, WIDTH - 80, { padding: 44 });
    const h = fontSize + 28;
    titleEls.push(
      `<rect x="20" y="20" width="${pillWidth.toFixed(1)}" height="${h}" rx="10" fill="#000" fill-opacity="0.66"/>`,
      `<text x="${(20 + pillWidth / 2).toFixed(1)}" y="${(20 + h / 2 + fontSize * 0.35).toFixed(1)}" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#fff">${xmlEscape(title)}</text>`,
    );
  }

  const labels = await terminalLabels(
    [
      { name: fromName, lat: points[0].lat, lon: points[0].lon },
      { name: toName, lat: points[points.length - 1].lat, lon: points[points.length - 1].lon },
    ],
    centerLat,
    centerLon,
    zoom,
  );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${titleEls.join('\n')}${labels}</svg>`;
  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

module.exports = { renderBusDisruptionMap };
