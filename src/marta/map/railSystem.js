// System-wide rail map for the timelapse — all four MARTA lines drawn at once
// with every in-service train plotted as a colored dot. The MARTA analog of the
// CTA L "snapshot" map. Framing is fixed across every frame (a moving viewport
// would break the timelapse illusion), and the base map (line geometry + title)
// is fetched once and reused for all frames.
const sharp = require('sharp');
const { encode } = require('../../shared/polyline');
const { fitZoom, project } = require('../../shared/projection');
const {
  STYLE,
  WIDTH,
  HEIGHT,
  requireMapboxToken,
  fetchMapboxStatic,
  thinPolylinePoints,
} = require('./common');
const { lineColor } = require('./railIncidents');

const TRAIN_RADIUS = 10;
const ROUTE_STROKE = 5;

function systemBbox(lineGeom) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const geom of lineGeom.values()) {
    for (const p of geom.points) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
  }
  return { minLat, maxLat, minLon, maxLon };
}

function computeSystemView(lineGeom) {
  const bbox = systemBbox(lineGeom);
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const zoom = Math.max(8, Math.min(13, fitZoom(bbox, WIDTH, HEIGHT, 70)));
  return { centerLat, centerLon, zoom, width: WIDTH, height: HEIGHT };
}

// Base layer: each line as a colored polyline, plus a baked title pill. Fetched
// once; the per-frame train dots composite on top of the returned buffer.
async function fetchSystemBase(view, lineGeom, { title = 'MARTA Rail' } = {}) {
  const overlays = [];
  for (const geom of lineGeom.values()) {
    const pts = thinPolylinePoints(geom.points, 100).map((p) => [p.lat, p.lon]);
    if (pts.length < 2) continue;
    overlays.push(
      `path-${ROUTE_STROKE}+${lineColor(geom.line)}-0.9(${encodeURIComponent(encode(pts))})`,
    );
  }
  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/${view.centerLon.toFixed(5)},${view.centerLat.toFixed(5)},${view.zoom.toFixed(2)}/${view.width}x${view.height}@2x?access_token=${token}`;
  const data = await fetchMapboxStatic(url);

  const titleSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${view.width}" height="${view.height}">
    <rect x="20" y="20" width="260" height="64" rx="10" fill="#000" fill-opacity="0.66"/>
    <text x="44" y="62" font-family="Inter, Helvetica, Arial, sans-serif" font-size="40" font-weight="700" fill="#fff">${title}</text>
  </svg>`;
  return sharp(data)
    .resize(view.width, view.height)
    .composite([{ input: Buffer.from(titleSvg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

function buildTrainDots(view, trains) {
  const dots = [];
  for (const t of trains) {
    const { x, y } = project(
      t.lat,
      t.lon,
      view.centerLat,
      view.centerLon,
      view.zoom,
      WIDTH,
      HEIGHT,
    );
    if (x < -10 || x > WIDTH + 10 || y < -10 || y > HEIGHT + 10) continue;
    const op = (t.opacity ?? 1).toFixed(2);
    const color = lineColor(t.line);
    dots.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${TRAIN_RADIUS}" fill="#${color}" fill-opacity="${op}" stroke="#fff" stroke-width="2.5" stroke-opacity="${op}"/>`,
    );
  }
  return dots.join('');
}

async function renderSystemFrame(view, baseMap, trains) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${buildTrainDots(view, trains)}</svg>`;
  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

module.exports = { computeSystemView, fetchSystemBase, renderSystemFrame };
