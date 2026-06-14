// Shared Mapbox-static + SVG-composite render helpers for MARTA map images.
// Ported from the still-image subset of cta-insights src/map/common.js. Dropped
// here: the articulated-bus glyph + fleet lookup (MARTA exposes no fleet
// metadata), and the video-only helpers (comet trail, clip progress/HUD pills,
// ghost legend) — those return with the video phase.
const axios = require('axios');
const sharp = require('sharp');

const STYLE = 'mapbox/dark-v11';
const WIDTH = 1200;
const HEIGHT = 1200;

// Two-tone route line: dark halo + bright core makes the route pop on the basemap.
const ROUTE_HALO_COLOR = '000';
const ROUTE_HALO_STROKE = 14;
const ROUTE_CORE_COLOR = '00d8ff';
const ROUTE_CORE_STROKE = 8;

// SVG path so cross-host rendering is identical (librsvg font fallback differs
// between macOS Helvetica and Ubuntu DejaVu, which warped the Unicode arrow).
const ARROW_PATH_D = 'M -40,-30 L 0,-75 L 40,-30 M 0,-75 L 0,75';

function buildDirectionArrow(cx, cy, bearingDeg) {
  const rotation = Math.round(bearingDeg / 45) * 45;
  const transform = `translate(${cx} ${cy}) rotate(${rotation})`;
  return [
    `<path d="${ARROW_PATH_D}" fill="none" stroke="#000" stroke-width="26" stroke-linecap="round" stroke-linejoin="round" transform="${transform}"/>`,
    `<path d="${ARROW_PATH_D}" fill="none" stroke="#fff" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" transform="${transform}"/>`,
  ].join('');
}

// Inlined Twemoji bus paths so rendering doesn't need a color emoji font.
const TWEMOJI_BUS_INNER =
  '<path fill="#808285" d="M0 21v7c0 1.657 1.343 3 3 3h30c1.657 0 3-1.343 3-3v-7H0z"/><path fill="#CCD6DD" d="M36 22v-9c0-1.657-3.343-3-5-3H11c-8 0-11 2.343-11 4v8h36z"/><path fill="#939598" d="M0 22h36v3H0z"/><path fill="#BCBEC0" d="M7 25c-3.063 0-5.586 2.298-5.95 5.263.526.453 1.202.737 1.95.737h10c0-3.313-2.686-6-6-6zm27.95 5.263C34.586 27.298 32.063 25 29 25c-3.313 0-6 2.687-6 6h10c.749 0 1.425-.284 1.95-.737z"/><circle cx="7" cy="31" r="4"/><circle fill="#99AAB5" cx="7" cy="31" r="2"/><circle cx="29" cy="31" r="4"/><circle fill="#99AAB5" cx="29" cy="31" r="2"/><path fill="#F4900C" d="M0 25h1v2H0zm35-2h1v2h-1z"/><path fill="#58595B" d="M1 13h35v10H1z"/><path fill="#292F33" d="M2 13H.342C.11 13.344 0 13.685 0 14v11h2c1.104 0 2-.896 2-2v-8c0-1.104-.896-2-2-2z"/><path fill="#55ACEE" d="M31 20c0 .553-.447 1-1 1H7c-.552 0-1-.447-1-1v-4c0-.552.448-1 1-1h23c.553 0 1 .448 1 1v4z"/><path fill="#FFAC33" d="M35 19h1v2h-1z"/><path fill="#55ACEE" d="M1 15H0v8h1c.552 0 1-.447 1-1v-6c0-.552-.448-1-1-1z"/>';

// Simplified house, sized for ~40px on a dark basemap. Origin marker.
const TWEMOJI_HOUSE_INNER = [
  '<rect fill="#6D3A2C" x="24" y="4" width="4.5" height="2"/>',
  '<rect fill="#8A4B38" x="24" y="6" width="4.5" height="7"/>',
  '<path fill="#8B4423" d="M18 1 L0 19 L4 19 L4 35 L32 35 L32 19 L36 19 Z"/>',
  '<path fill="#FFCC4D" d="M5 19 L18 7 L31 19 L31 35 L5 35 Z"/>',
  '<rect fill="#E8A935" x="5" y="19" width="26" height="2"/>',
  '<rect fill="#A0241B" x="14.5" y="24" width="7" height="11"/>',
  '<circle fill="#FFD700" cx="20" cy="30" r="0.8"/>',
  '<rect fill="#6D3A2C" x="7" y="23" width="6" height="6"/>',
  '<rect fill="#55ACEE" x="7.7" y="23.7" width="4.6" height="4.6"/>',
  '<rect fill="#fff" x="9.85" y="23.7" width="0.3" height="4.6"/>',
  '<rect fill="#fff" x="7.7" y="25.85" width="4.6" height="0.3"/>',
  '<rect fill="#6D3A2C" x="23" y="23" width="6" height="6"/>',
  '<rect fill="#55ACEE" x="23.7" y="23.7" width="4.6" height="4.6"/>',
  '<rect fill="#fff" x="25.85" y="23.7" width="0.3" height="4.6"/>',
  '<rect fill="#fff" x="23.7" y="25.85" width="4.6" height="0.3"/>',
].join('');

// Checkered flag — destination marker, paired with the house at origin.
const TWEMOJI_FLAG_INNER = [
  '<rect fill="#3B2412" x="7.5" y="3" width="2" height="30"/>',
  '<circle fill="#FFD700" cx="8.5" cy="3" r="1.5"/>',
  '<rect fill="#FFFFFF" x="9.5" y="6" width="22" height="12"/>',
  '<rect fill="#000" x="9.5"  y="6"  width="5.5" height="4"/>',
  '<rect fill="#000" x="20.5" y="6"  width="5.5" height="4"/>',
  '<rect fill="#000" x="15"   y="10" width="5.5" height="4"/>',
  '<rect fill="#000" x="26"   y="10" width="5.5" height="4"/>',
  '<rect fill="#000" x="9.5"  y="14" width="5.5" height="4"/>',
  '<rect fill="#000" x="20.5" y="14" width="5.5" height="4"/>',
  '<rect fill="none" stroke="#000" stroke-width="0.6" x="9.5" y="6" width="22" height="12"/>',
].join('');

// Bus-stop sign: amber placard with a white mini-bus glyph. Amber (#f57c00)
// sits well clear of the cyan route line and the pink buses on a dark basemap.
const TWEMOJI_BUS_STOP_INNER = [
  '<rect fill="#f57c00" stroke="#fff" stroke-width="2" x="2" y="2" width="32" height="32" rx="3" ry="3"/>',
  '<rect fill="#fff" x="7" y="10" width="22" height="16" rx="2" ry="2"/>',
  '<rect fill="#f57c00" x="9" y="12" width="18" height="6" rx="0.8" ry="0.8"/>',
  '<circle fill="#222" cx="12" cy="26" r="2.3"/>',
  '<circle fill="#222" cx="24" cy="26" r="2.3"/>',
].join('');

function buildStopMarker(x, y, size) {
  return `<svg x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" viewBox="0 0 36 36">${TWEMOJI_BUS_STOP_INNER}</svg>`;
}

// Compact form: a small amber dot. Used where the full sign reads as visual
// noise on dense routes — the dot still marks "there's a stop here."
function buildStopDot(x, y, radius) {
  return `<circle cx="${x}" cy="${y}" r="${radius}" fill="#f57c00" stroke="#fff" stroke-width="1.5"/>`;
}

// Bus marker: colored disc + bus glyph + white ring. Identity chips are drawn
// by the caller in a separate top layer (markerLabelChip) so an overlapping
// disc can never bury another bus's chip.
function buildBusMarker({ x, y, radius, color }) {
  const size = radius * 1.6;
  return [
    `<circle cx="${x}" cy="${y}" r="${radius}" fill="#${color}"/>`,
    `<svg x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" viewBox="0 0 36 36">${TWEMOJI_BUS_INNER}</svg>`,
    `<circle cx="${x}" cy="${y}" r="${radius}" fill="none" stroke="#fff" stroke-width="4"/>`,
  ].join('');
}

// Identity chip at a marker's upper-right. Render these in a layer ABOVE all
// markers so an overlapping disc never hides a neighbor's chip. '' when no label.
function markerLabelChip(x, y, radius, label) {
  return label != null
    ? buildNumberBadge(x + radius * 0.66, y - radius * 0.66, radius * 0.5, label)
    : '';
}

// Small numbered badge: white disc + dark numeral so it reads on any marker fill.
function buildNumberBadge(cx, cy, r, label) {
  const fontSize = r * 1.3;
  return [
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" stroke="#1c1c1c" stroke-width="2"/>`,
    `<text x="${cx}" y="${cy + fontSize * 0.35}" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#1c1c1c">${xmlEscape(String(label))}</text>`,
  ].join('');
}

function buildTerminalMarker(x, y, radius, glyph) {
  const iconSize = radius * 1.6;
  const iconX = x - iconSize / 2;
  const iconY = y - iconSize / 2;
  return [
    `<circle cx="${x}" cy="${y}" r="${radius}" fill="#7cb342"/>`,
    `<svg x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="0 0 36 36">${glyph}</svg>`,
    `<circle cx="${x}" cy="${y}" r="${radius}" fill="none" stroke="#fff" stroke-width="4"/>`,
  ];
}

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function requireMapboxToken() {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');
  return token;
}

async function fetchMapboxStatic(url, timeoutMs = 30000) {
  // One retry with jittered backoff for transient 429/5xx.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: timeoutMs });
      return data;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) {
        const wait = 500 + Math.floor(Math.random() * 750);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

// `opts.axis` (pixel-space unit vector) constrains pushes to ±axis. Pass the
// route-perpendicular axis so a bunch fans sideways instead of spreading along
// the road, which would make tight bunches look spread out.
function separateMarkers(points, minDist, opts = {}) {
  const { axis, maxIterations = 60 } = opts;
  const out = points.map((p) => ({ ...p }));
  for (let iter = 0; iter < maxIterations; iter++) {
    let moved = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const dx = out[j].x - out[i].x;
        const dy = out[j].y - out[i].y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 >= minDist * minDist) continue;

        if (axis) {
          const a = dx * axis.x + dy * axis.y;
          const perp2 = Math.max(0, dist2 - a * a);
          if (perp2 >= minDist * minDist) continue;
          const targetAbs = Math.sqrt(minDist * minDist - perp2);
          // Below STABLE_THRESH, GPS noise can flip Math.sign(a) — fall back to
          // caller-order sign for stability.
          const STABLE_THRESH = minDist * 0.2;
          const sign = Math.abs(a) < STABLE_THRESH ? 1 : Math.sign(a);
          const targetA = sign * targetAbs;
          const delta = (targetA - a) / 2;
          out[i].x -= axis.x * delta;
          out[i].y -= axis.y * delta;
          out[j].x += axis.x * delta;
          out[j].y += axis.y * delta;
          moved = true;
        } else {
          const dist = Math.sqrt(dist2);
          let ux;
          let uy;
          if (dist < 1e-6) {
            const angle = ((i * 97 + j * 31) % 360) * (Math.PI / 180);
            ux = Math.cos(angle);
            uy = Math.sin(angle);
          } else {
            ux = dx / dist;
            uy = dy / dist;
          }
          const push = (minDist - dist) / 2;
          out[i].x -= ux * push;
          out[i].y -= uy * push;
          out[j].x += ux * push;
          out[j].y += uy * push;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return out;
}

// Compass bearing → pixel-space perpendicular (rotated 90° CW = right of travel).
function perpendicularFromBearing(bearingDeg) {
  const rad = (bearingDeg * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

// Compute a title pill width and font size that fits within `maxPillWidth`,
// shrinking the font when the rendered text would overflow.
async function fitTitlePill(text, baseFontSize, maxPillWidth, { padding = 48 } = {}) {
  let fontSize = baseFontSize;
  let textW = await measureTextWidth(text, fontSize, { bold: true });
  if (padding + textW > maxPillWidth) {
    const ratio = (maxPillWidth - padding) / textW;
    fontSize = Math.max(20, Math.floor(fontSize * ratio));
    textW = await measureTextWidth(text, fontSize, { bold: true });
  }
  return { fontSize, pillWidth: padding + textW };
}

// Real glyph measurement via librsvg — the same renderer that draws the SVG
// composite. librsvg's font fallback differs by host, so a per-character
// estimator drifts; always use this for pill sizing.
async function measureTextWidth(text, fontSize, { bold = false } = {}) {
  const weight = bold ? 'bold' : 'normal';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="${Math.ceil(fontSize * 2)}"><text x="0" y="${fontSize}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="${weight}">${xmlEscape(text)}</text></svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true });
  let maxX = 0;
  const stride = info.channels;
  for (let y = 0; y < info.height; y++) {
    for (let x = info.width - 1; x > maxX; x--) {
      const alpha = data[(y * info.width + x) * stride + (stride - 1)];
      if (alpha > 8) {
        if (x > maxX) maxX = x;
        break;
      }
    }
  }
  return maxX + 1;
}

function bboxOf(points) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    const lat = Array.isArray(p) ? p[0] : p.lat;
    const lon = Array.isArray(p) ? p[1] : p.lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

function paddedBbox(bbox, fracMargin, minSpanDeg) {
  const latSpan = Math.max(bbox.maxLat - bbox.minLat, minSpanDeg);
  const lonSpan = Math.max(bbox.maxLon - bbox.minLon, minSpanDeg);
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const padLat = (latSpan * (1 + fracMargin)) / 2;
  const padLon = (lonSpan * (1 + fracMargin)) / 2;
  return {
    minLat: centerLat - padLat,
    maxLat: centerLat + padLat,
    minLon: centerLon - padLon,
    maxLon: centerLon + padLon,
  };
}

module.exports = {
  STYLE,
  WIDTH,
  HEIGHT,
  ROUTE_HALO_COLOR,
  ROUTE_HALO_STROKE,
  ROUTE_CORE_COLOR,
  ROUTE_CORE_STROKE,
  ARROW_PATH_D,
  buildDirectionArrow,
  TWEMOJI_BUS_INNER,
  TWEMOJI_HOUSE_INNER,
  TWEMOJI_FLAG_INNER,
  TWEMOJI_BUS_STOP_INNER,
  buildBusMarker,
  buildNumberBadge,
  markerLabelChip,
  buildTerminalMarker,
  buildStopMarker,
  buildStopDot,
  xmlEscape,
  requireMapboxToken,
  fetchMapboxStatic,
  separateMarkers,
  perpendicularFromBearing,
  measureTextWidth,
  fitTitlePill,
  bboxOf,
  paddedBbox,
};
