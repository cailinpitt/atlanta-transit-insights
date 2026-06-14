// Bunching post text/alt builders. Ported from cta-insights src/bus/bunchingPost.js.
// The bin supplies display strings (route title, direction, near-stop) since
// MARTA derives route/direction metadata from GTFS rather than a CTA route list.
// Video-post builders are omitted for this slice.
const { assignBusNumbers } = require('./bunching');
const { formatCallouts } = require('../shared/incidents');
const { formatDistance, formatDeviation, keycapNumber } = require('../shared/format');

// `ctx` = { routeTitle, direction, nearStopName }.
function buildPostText(bunch, ctx, callouts = [], opts = {}) {
  const { routeTitle, direction, nearStopName } = ctx;
  // Tag each run with the identity number it carries on the map (1 = lead bus)
  // so a reader can tie a numbered disc back to its bus.
  const labels = assignBusNumbers(bunch.vehicles);
  const deviations = opts.deviations;
  const vids = bunch.vehicles
    .filter((v) => v.vehicleId != null)
    .map((v) => ({
      label: `#${v.vehicleId}`,
      n: labels.get(v.vehicleId),
      dev: deviations?.get(v.vehicleId),
    }))
    .sort((a, b) => a.n - b.n)
    .map((x) => {
      const n = keycapNumber(x.n);
      const d = formatDeviation(x.dev);
      return d ? `${x.label} (${n}, ${d})` : `${x.label} (${n})`;
    })
    .join(', ');
  const busesLine = vids ? `\n\nBuses: ${vids}` : '';
  // 🥇 medal when this bunch sets a new record for most buses ever bunched.
  const recordLine = opts.isAllTimeRecord
    ? `\n\n🥇 New record: most buses ever bunched${
        opts.previousRecord != null ? ` (was ${opts.previousRecord})` : ''
      }`
    : '';
  // The gap the bunch leaves behind it is the rider-facing cost.
  const gapLine = opts.gapBehind
    ? `\n\nNext bus ${formatDistance(opts.gapBehind.distFt)}${
        opts.gapBehind.minutes != null ? ` / ~${opts.gapBehind.minutes} min` : ''
      } behind`
    : '';
  const dirPart = direction ? ` — ${direction}` : '';
  const nearPart = nearStopName ? ` near ${nearStopName}` : '';
  const base = `🚌 ${routeTitle}${dirPart}\n\n${bunch.vehicles.length} buses within ${formatDistance(bunch.spanFt)}${nearPart}${recordLine}${gapLine}${busesLine}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n\n${tail}` : base;
}

function buildAltText(bunch, ctx) {
  const { routeTitle, direction, nearStopName } = ctx;
  const dirPart = direction ? ` ${direction.toLowerCase()}` : '';
  const nearPart = nearStopName ? ` near ${nearStopName}` : '';
  return `Map of ${routeTitle}${nearPart} showing ${bunch.vehicles.length}${dirPart} buses within ${formatDistance(bunch.spanFt)} of each other.`;
}

module.exports = { buildPostText, buildAltText };
