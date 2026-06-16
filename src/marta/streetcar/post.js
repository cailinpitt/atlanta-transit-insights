// Post text for the Atlanta Streetcar speedmap. Kept separate from rail/post.js
// because the streetcar has its own (much slower) speed legend and a single
// downtown loop — so it skips rail's compass-direction + terminus phrasing.
const { formatCallouts } = require('../shared/incidents');
const { formatTimeET } = require('../shared/format');
const { STREETCAR_THRESHOLDS } = require('./speedmap');

const T = STREETCAR_THRESHOLDS;
const LEGEND =
  'Each colored segment of the loop shows how fast the streetcar was moving there:\n' +
  `🟥 under ${T.orange} mph - stopped or crawling\n` +
  `🟧 ${T.orange}-${T.yellow} mph - slow\n` +
  `🟨 ${T.yellow}-${T.purple} mph - moderate\n` +
  `🟪 ${T.purple}-${T.green} mph - moving\n` +
  `🟩 ${T.green}+ mph - moving well`;

function buildStreetcarSpeedmapPostText(summary, startTime, endTime, callouts = []) {
  const avg = summary.avg == null ? 'unavailable' : `${summary.avg.toFixed(1)} mph`;
  const window = `${formatTimeET(startTime)}-${formatTimeET(endTime)} ET`;
  const head = `🚦 Atlanta Streetcar\n${window} · average speed ${avg}`;
  const tail = formatCallouts(callouts);
  return `${tail ? `${head}\n${tail}\n\n` : `${head}\n\n`}${LEGEND}`;
}

function buildStreetcarSpeedmapAltText(summary) {
  const avg = summary.avg == null ? 'unavailable' : `${summary.avg.toFixed(1)} mph`;
  return (
    'Speedmap of the Atlanta Streetcar downtown loop over a one-hour window, with ' +
    `loop segments colored by average streetcar speed. Overall average: ${avg}. ` +
    `Red segments indicate the streetcar under ${T.orange} mph, orange under ${T.yellow}, ` +
    `yellow under ${T.purple}, purple under ${T.green}, green ${T.green} and above.`
  );
}

module.exports = { buildStreetcarSpeedmapPostText, buildStreetcarSpeedmapAltText };
