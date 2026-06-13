// Metra recap reliability chart — a horizontal bar per line, least-reliable on
// top. The Metra analog of src/map/gapChart.js (which charts CTA headway gaps),
// but the axis is a percentage, not a raw count.
//
// Scale note: Metra reliability clusters high (often 90–99%), so a literal 0–100%
// axis would render every bar nearly full and hide the differences. We zoom the
// axis to a floor at or below the worst line (rounded down to a clean 5%), and
// print the exact percentage at the end of each bar so the number is always
// authoritative even though the bar length is relative to the zoomed floor. The
// floor is drawn in the subtitle so the zoom is never silently misleading.

const sharp = require('sharp');
const { xmlEscape } = require('../common');
const { LINE_NAMES } = require('../../metra/lines');

// Square — Bluesky crops non-square images in the feed.
const SIZE = 1200;
const BG = '#1a1a1d';
const GRID = '#2d2d33';
const TEXT = '#f5f5f7';
const SUBTEXT = '#9a9aa2';

const PAD_X = 80;
const PAD_TOP = 90;
const PAD_BOTTOM = 110;
const TITLE_SIZE = 52;
const SUBTITLE_SIZE = 26;
const BAR_LABEL_W = 360; // Metra line names are long ("Union Pacific Northwest")
const PCT_LABEL_W = 130;
const BAR_GAP = 18;

const WINDOW_LABELS = { week: 'this week', month: 'this month' };

// Clean axis floor at or below the worst line, capped at 90 so a perfect week
// still shows readable bars, never below 0.
function axisFloor(entries) {
  const min = Math.min(100, ...entries.map((e) => e.reliabilityPct));
  return Math.max(0, Math.min(90, Math.floor((min - 2) / 5) * 5));
}

function renderRecapChart({ entries, window, windowLabel = null, lineColors = null }) {
  const title = '🚆 Metra on-time by line';
  const label = windowLabel || WINDOW_LABELS[window] || window;
  const floor = entries.length > 0 ? axisFloor(entries) : 0;
  const subtitle =
    entries.length > 0
      ? `% of trips on time (within 15 min, not cancelled) · ${label} · axis from ${floor}%`
      : `No data · ${label}`;

  const rows = entries.length;
  const chartTop = PAD_TOP + TITLE_SIZE + 20 + SUBTITLE_SIZE + 40;
  const chartBottom = SIZE - PAD_BOTTOM;
  const chartHeight = chartBottom - chartTop;
  const rowHeight = rows > 0 ? (chartHeight - BAR_GAP * (rows - 1)) / rows : 0;
  const barX = PAD_X + BAR_LABEL_W;
  const barMaxW = SIZE - PAD_X - barX - PCT_LABEL_W;
  const span = Math.max(1, 100 - floor);

  const bars = entries
    .map((e, i) => {
      const y = chartTop + i * (rowHeight + BAR_GAP);
      const frac = Math.max(0, Math.min(1, (e.reliabilityPct - floor) / span));
      const w = Math.max(6, frac * barMaxW);
      const color = lineColors?.[e.line] ? `#${lineColors[e.line]}` : '#5a8dee';
      const labelText = LINE_NAMES[e.line] || e.line;
      const labelY = y + rowHeight / 2 + 10;
      const pctX = barX + w + 16;
      const barRadius = Math.min(10, rowHeight / 2);
      return [
        `<text x="${barX - 16}" y="${labelY}" fill="${TEXT}" text-anchor="end" font-family="Inter, Helvetica, Arial, sans-serif" font-size="28" font-weight="600">${xmlEscape(labelText)}</text>`,
        `<rect x="${barX}" y="${y}" width="${w}" height="${rowHeight}" rx="${barRadius}" fill="${color}"/>`,
        `<text x="${pctX}" y="${labelY}" fill="${TEXT}" text-anchor="start" font-family="Inter, Helvetica, Arial, sans-serif" font-size="28" font-weight="700">${e.reliabilityPct}%</text>`,
      ].join('');
    })
    .join('\n');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
    <rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>
    <text x="${PAD_X}" y="${PAD_TOP + TITLE_SIZE}" fill="${TEXT}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${TITLE_SIZE}" font-weight="700">${xmlEscape(title)}</text>
    <text x="${PAD_X}" y="${PAD_TOP + TITLE_SIZE + 20 + SUBTITLE_SIZE}" fill="${SUBTEXT}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${SUBTITLE_SIZE}" font-weight="500">${xmlEscape(subtitle)}</text>
    <line x1="${barX}" y1="${chartTop - 10}" x2="${barX}" y2="${chartBottom + 10}" stroke="${GRID}" stroke-width="2"/>
    ${bars}
  </svg>`;

  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

module.exports = { renderRecapChart, axisFloor };
