const { formatCallouts } = require('../shared/incidents');
const { formatMinutes, formatDeviation } = require('../shared/format');

function buildPostText(gap, ctx = {}, callouts = [], opts = {}) {
  const routeTitle = ctx.routeTitle || `Route ${gap.route}`;
  const direction = ctx.direction ? ` — ${ctx.direction}` : '';
  const before = gap.flankBefore?.stopName;
  const after = gap.flankAfter?.stopName;
  const near = ctx.nearStopName;
  let where = '';
  if (before && after) where = ` between ${before} and ${after}`;
  else if (before || after) where = ` past ${before || after}`;
  else if (near) where = ` near ${near}`;

  const devSuffix = (min) => {
    const d = formatDeviation(min);
    return d ? ` (${d})` : '';
  };
  const lastSeen = gap.leading?.vehicleId
    ? `#${gap.leading.vehicleId}${devSuffix(opts.leadingDev)}`
    : null;
  const nextUp = gap.trailing?.vehicleId
    ? `#${gap.trailing.vehicleId}${devSuffix(opts.trailingDev)}`
    : null;
  const busesLine =
    lastSeen || nextUp
      ? `\n\n${[lastSeen && `Last seen: ${lastSeen}`, nextUp && `Next up: ${nextUp}`]
          .filter(Boolean)
          .join(' · ')}`
      : '';

  const nearScheduleMin = 6;
  const explainMissing =
    opts.trailingDev != null &&
    Math.abs(opts.trailingDev) <= nearScheduleMin &&
    gap.expectedMin > 0 &&
    gap.gapMin >= 2 * gap.expectedMin;
  const missingLine = explainMissing
    ? '\n\nBoth buses here are near schedule - the gap is from trips missing between them.'
    : '';

  const base = `🕳️ ${routeTitle}${direction}\n\nNo buses${where} - a ~${formatMinutes(gap.gapMin)} gap, scheduled around every ${formatMinutes(gap.expectedMin)} this hour${busesLine}${missingLine}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n\n${tail}` : base;
}

function buildAltText(gap, ctx = {}) {
  const routeTitle = ctx.routeTitle || `Route ${gap.route}`;
  const direction = ctx.direction ? ` ${String(ctx.direction).toLowerCase()}` : '';
  const before = gap.flankBefore?.stopName;
  const after = gap.flankAfter?.stopName;
  const near = ctx.nearStopName;
  let where = ' between buses';
  if (before && after) where = ` with no buses between ${before} and ${after}`;
  else if (near) where = ` between buses near ${near}`;
  return `Map of ${routeTitle}${direction} showing a ${formatMinutes(gap.gapMin)} gap${where}.`;
}

function buildVideoPostText(video, gap) {
  const elapsed = video?.elapsedSec
    ? `${Math.max(1, Math.round(video.elapsedSec / 60))} min`
    : 'Several minutes';
  return `${elapsed} of recent movement around this ~${formatMinutes(gap.gapMin)} bus gap.`;
}

function buildVideoAltText(gap, ctx = {}) {
  const routeTitle = ctx.routeTitle || `Route ${gap.route}`;
  const direction = ctx.direction ? ` ${String(ctx.direction).toLowerCase()}` : '';
  return `Timelapse map of ${routeTitle}${direction} showing recent movement of the buses flanking a ${formatMinutes(gap.gapMin)} gap.`;
}

module.exports = { buildPostText, buildAltText, buildVideoPostText, buildVideoAltText };
