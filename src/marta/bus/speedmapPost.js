const { formatCallouts } = require('../shared/incidents');
const { formatTimeET } = require('../shared/format');

function buildPostText(routeTitle, direction, summary, startTime, endTime, callouts = []) {
  const avg = summary.avg == null ? 'unavailable' : `${summary.avg.toFixed(1)} mph`;
  const window = `${formatTimeET(startTime)}-${formatTimeET(endTime)} ET`;
  const head = `🚦 ${routeTitle}${direction ? ` - ${direction}` : ''}\n${window} · average speed ${avg}`;
  const tail = formatCallouts(callouts);
  return (
    (tail ? `${head}\n${tail}\n\n` : `${head}\n\n`) +
    'Each colored segment of the route shows how fast buses were moving there:\n' +
    '🟥 under 5 mph - stopped or crawling\n' +
    '🟧 5-10 mph - slow\n' +
    '🟨 10-15 mph - moderate\n' +
    '🟩 15+ mph - moving well'
  );
}

function buildAltText(routeTitle, direction, summary) {
  const avg = summary.avg == null ? 'unavailable' : `${summary.avg.toFixed(1)} mph`;
  const dir = direction ? ` ${String(direction).toLowerCase()}` : '';
  return `Speedmap of ${routeTitle}${dir} over a one-hour window, with route segments colored by average bus speed. Overall average: ${avg}. Red segments indicate stopped or crawling buses under 5 mph, orange under 10, yellow under 15, green 15 and above.`;
}

module.exports = { buildPostText, buildAltText };
