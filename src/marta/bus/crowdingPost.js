const { formatCallouts } = require('../shared/incidents');
const { formatTimeET } = require('../shared/format');
const { crowdedBinFraction, crowdingLabel } = require('./crowding');

const LEGEND = [
  '🟩 seats available',
  '🟨 few seats left',
  '🟧 standing room only',
  '🟥 crushed or full',
];

function pctText(frac) {
  return `${Math.round(frac * 100)}%`;
}

// Map post: route + direction, the window, the share of mapped segments that
// were standing-room-or-fuller, optional callouts, then the color legend. Neutral
// and descriptive — it reports what the feed showed, no judgment.
function buildMapPostText(routeTitle, direction, summary, startTime, endTime, callouts = []) {
  const crowded = pctText(crowdedBinFraction(summary));
  const window = `${formatTimeET(startTime)}-${formatTimeET(endTime)} ET`;
  const head = `🧍 ${routeTitle}${direction ? ` - ${direction}` : ''}\n${window} · ${crowded} of the route standing-room or fuller`;
  const tail = formatCallouts(callouts);
  return (
    (tail ? `${head}\n${tail}\n\n` : `${head}\n\n`) +
    'Each colored segment shows how full buses were there:\n' +
    LEGEND.join('\n')
  );
}

function buildMapAltText(routeTitle, direction, summary) {
  const crowded = pctText(crowdedBinFraction(summary));
  const dir = direction ? ` ${String(direction).toLowerCase()}` : '';
  return (
    `Crowding map of ${routeTitle}${dir} over a one-hour window, with route segments ` +
    'colored by how full buses were: green seats available, yellow few seats, orange ' +
    `standing room only, red crushed or full. ${crowded} of the mapped route was standing-room or fuller.`
  );
}

// One rollup line for the "most crowded routes" digest, mirroring formatGhostLine.
// `rec` is a summarizeRouteCrowding row.
function formatCrowdingRollupLine(rec, routeTitle) {
  return `${routeTitle} · ${pctText(rec.pctCrowded)} standing-room or fuller · peak: ${crowdingLabel(rec.peakScore)}`;
}

module.exports = {
  buildMapPostText,
  buildMapAltText,
  formatCrowdingRollupLine,
};
