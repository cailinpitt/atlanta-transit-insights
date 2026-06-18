// Cross-route bunching map — a pileup involving multiple routes/lines at one
// spot. Port of cta-insights src/map/crossBunching.js. An intersection view
// centered on the cluster centroid: each vehicle is a bus/train marker colored
// by its route, with a white number chip and a legend mapping color → route.
// Generic over bus and rail; the caller passes already-normalized points +
// legend + markerKind.
//
// Split into view / base-map / frame so the cross-route timelapse video
// (src/marta/map/crossBunchingVideo.js) can render many frames against one
// fetched base map — the still map is just a one-frame render.
const sharp = require('sharp');
const { fitZoom, project } = require('../../shared/projection');
const {
  STYLE,
  WIDTH,
  HEIGHT,
  TWEMOJI_BUS_INNER,
  TWEMOJI_TRAIN_INNER,
  requireMapboxToken,
  fetchMapboxStatic,
  separateMarkers,
  markerLabelChip,
  measureTextWidth,
  buildClipProgress,
  xmlEscape,
} = require('./common');

const PALETTE = ['ff2a6d', '27c4f5', 'a162e8', 'ffd166', '06d6a0', 'f78c6b', 'ff8c42', 'c0c0c0'];
const MARKER_RADIUS = 32;
const LEGEND_FONT = 26;

function colorForIndex(i) {
  return PALETTE[i % PALETTE.length];
}

// Measured text widths are stable per (label, size) and the legend text repeats
// across every video frame, so cache them per-process.
const _textWidthCache = new Map();
async function measureCached(label, fontSize) {
  const key = `${fontSize}:${label}`;
  if (!_textWidthCache.has(key)) {
    _textWidthCache.set(key, await measureTextWidth(label, fontSize, { bold: false }));
  }
  return _textWidthCache.get(key);
}

// A vehicle marker: route-colored fill circle + bus/train glyph + white ring,
// generic over the glyph so one renderer serves both modes. Number chip is
// drawn separately, above all markers, so an overlap can't bury a chip.
function buildCrossMarker({ x, y, radius, color, inner, opacity = 1 }) {
  const size = radius * 1.6;
  const body = [
    `<circle cx="${x}" cy="${y}" r="${radius}" fill="#${color}"/>`,
    `<svg x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" viewBox="0 0 36 36">${inner}</svg>`,
    `<circle cx="${x}" cy="${y}" r="${radius}" fill="none" stroke="#fff" stroke-width="4"/>`,
  ].join('');
  return opacity < 1 ? `<g opacity="${opacity}">${body}</g>` : body;
}

// Framing (center + zoom) covering all `points` ({ lat, lon }). For a video,
// pass every position across the whole window so the viewport stays stable.
function computeCrossView(points) {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const bbox = {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLon: Math.min(...lons),
    maxLon: Math.max(...lons),
  };
  const padLat = Math.max((bbox.maxLat - bbox.minLat) * 0.6, 0.0025);
  const padLon = Math.max((bbox.maxLon - bbox.minLon) * 0.6, 0.0025);
  const padded = {
    minLat: bbox.minLat - padLat,
    maxLat: bbox.maxLat + padLat,
    minLon: bbox.minLon - padLon,
    maxLon: bbox.maxLon + padLon,
  };
  const centerLat = (padded.minLat + padded.maxLat) / 2;
  const centerLon = (padded.minLon + padded.maxLon) / 2;
  const zoom = Math.max(12, Math.min(17, Math.floor(fitZoom(padded, WIDTH, HEIGHT, 90))));
  return { centerLat, centerLon, zoom };
}

async function fetchCrossBaseMap(view) {
  const token = requireMapboxToken();
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${view.centerLon.toFixed(5)},${view.centerLat.toFixed(5)},${view.zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  return fetchMapboxStatic(url, 20000);
}

// Legend bottom-left: a color swatch + route label per group, in a box sized to
// the widest label (measured) so long names don't spill past the background.
async function buildLegend(legend) {
  if (!legend.length) return '';
  const padX = 16;
  const r = 14;
  const gap = 12;
  const rowH = 40;
  const textX = padX + 2 * r + gap;
  const widths = await Promise.all(legend.map((g) => measureCached(g.label, LEGEND_FONT)));
  const maxLabelW = Math.max(0, ...widths);
  const boxW = Math.ceil(textX + maxLabelW + padX);
  const boxH = legend.length * rowH + 16;
  const x0 = 24;
  const y0 = HEIGHT - boxH - 24;
  const els = [
    `<rect x="${x0}" y="${y0}" width="${boxW}" height="${boxH}" rx="8" fill="#000" fill-opacity="0.7"/>`,
  ];
  legend.forEach((g, i) => {
    const cy = y0 + 16 + i * rowH + rowH / 2 - 8;
    const color = `#${colorForIndex(g.groupIndex)}`;
    els.push(
      `<circle cx="${x0 + padX + r}" cy="${cy}" r="${r}" fill="${color}" stroke="#fff" stroke-width="2"/>`,
      `<text x="${x0 + textX}" y="${cy + 9}" fill="#fff" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${LEGEND_FONT}" font-weight="600">${xmlEscape(g.label)}</text>`,
    );
  });
  return els.join('');
}

// Composite one frame: bus/train markers colored per route group + white number
// chips (honoring per-vehicle `opacity` so dropped vehicles fade), legend,
// title, and an optional clip progress bar (video). `vehicles` =
// [{ lat, lon, label, groupIndex, opacity? }].
async function renderCrossFrame(
  view,
  baseMap,
  vehicles,
  { legend = [], title = '', clock = null, markerKind = 'bus' } = {},
) {
  const inner = markerKind === 'train' ? TWEMOJI_TRAIN_INNER : TWEMOJI_BUS_INNER;
  const raw = vehicles.map((p) =>
    project(p.lat, p.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT),
  );
  const sep = separateMarkers(raw, MARKER_RADIUS * 2 + 6);
  const markerEls = vehicles.map((p, i) =>
    buildCrossMarker({
      x: sep[i].x,
      y: sep[i].y,
      radius: MARKER_RADIUS,
      color: colorForIndex(p.groupIndex),
      inner,
      opacity: p.opacity ?? 1,
    }),
  );
  const chipEls = vehicles.map((p, i) => {
    const chip = markerLabelChip(sep[i].x, sep[i].y, MARKER_RADIUS, p.label);
    const op = p.opacity ?? 1;
    return op < 1 && chip ? `<g opacity="${op}">${chip}</g>` : chip;
  });

  const legendEl = await buildLegend(legend);

  const titleEls = [];
  if (title) {
    const pillH = 56;
    const pillW = Math.min(WIDTH - 80, title.length * 20 + 48);
    const x0 = (WIDTH - pillW) / 2;
    titleEls.push(
      `<rect x="${x0}" y="24" width="${pillW}" height="${pillH}" rx="10" fill="#000" fill-opacity="0.72"/>`,
      `<text x="${WIDTH / 2}" y="${24 + pillH / 2 + 11}" text-anchor="middle" fill="#fff" font-family="Inter, Helvetica, Arial, sans-serif" font-size="32" font-weight="700">${xmlEscape(title)}</text>`,
    );
  }

  const clockEls = clock ? [buildClipProgress({ ...clock, width: WIDTH, height: HEIGHT })] : [];

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${titleEls.join('')}${legendEl}${markerEls.join('')}${chipEls.join('')}${clockEls.join('')}</svg>`;
  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

// `points`: [{ lat, lon, label, groupIndex }]. `legend`: [{ label, groupIndex }].
// `markerKind`: 'bus' | 'train'. Returns a JPEG buffer (single frame); throws
// (caller posts text-only) on <2 points or a missing Mapbox token.
async function renderCrossBunchingMap({ points, legend = [], title = '', markerKind = 'bus' }) {
  if (!points || points.length < 2) throw new Error('cross-bunching map needs ≥2 points');
  const view = computeCrossView(points);
  const baseMap = await fetchCrossBaseMap(view);
  return renderCrossFrame(view, baseMap, points, { legend, title, markerKind });
}

// Build the normalized { points, legend } from a cluster's members. See the CTA
// twin for parameter docs.
function pointsFromCluster(items, { idOf, groupKeyOf, labels, groupOrder, legendLabelOf }) {
  const groupIndex = new Map(groupOrder.map((k, i) => [k, i]));
  const points = items.map((it) => ({
    lat: it.lat,
    lon: it.lon,
    label: String(labels.get(idOf(it)) ?? '?'),
    groupIndex: groupIndex.get(groupKeyOf(it)) ?? 0,
  }));
  const legend = groupOrder.map((k, i) => ({ label: legendLabelOf(k), groupIndex: i }));
  return { points, legend };
}

module.exports = {
  renderCrossBunchingMap,
  renderCrossFrame,
  computeCrossView,
  fetchCrossBaseMap,
  pointsFromCluster,
  PALETTE,
};
