const { formatCallouts } = require('../shared/incidents');
const { formatDistance, formatMinutes, keycapNumber } = require('../shared/format');

function lineTitle(line) {
  return `${line} Line`;
}

function directionLabel(direction) {
  return direction ? `${direction}bound` : '';
}

function buildGapPostText(gap, callouts = []) {
  const dir = directionLabel(gap.direction);
  const where = dir ? ` - ${dir}` : '';
  const base = `🚇 ${lineTitle(gap.line)}${where}\n\nNo trains across ~${formatDistance(gap.gapFt)} - a ~${formatMinutes(gap.gapMin)} gap, scheduled around every ${formatMinutes(gap.expectedMin)} this hour`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n\n${tail}` : base;
}

function buildGapAltText(gap) {
  const dir = directionLabel(gap.direction).toLowerCase();
  const suffix = dir ? ` ${dir}` : '';
  return `Map of the ${lineTitle(gap.line)}${suffix} showing a ${formatMinutes(gap.gapMin)} rail gap across about ${formatDistance(gap.gapFt)}.`;
}

function buildBunchingPostText(bunch, callouts = []) {
  const dir = directionLabel(bunch.direction);
  const where = dir ? ` - ${dir}` : '';
  const trains = [...bunch.trains]
    .sort((a, b) => b.distFt - a.distFt)
    .map((t, i) => `#${t.trainId} (${keycapNumber(i + 1)})`)
    .join(', ');
  const base = `🚇 ${lineTitle(bunch.line)}${where}\n\n${bunch.trains.length} trains within ${formatDistance(bunch.spanFt)}\n\nTrains: ${trains}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n\n${tail}` : base;
}

function buildBunchingAltText(bunch) {
  const dir = directionLabel(bunch.direction).toLowerCase();
  const suffix = dir ? ` ${dir}` : '';
  return `Map of the ${lineTitle(bunch.line)}${suffix} showing ${bunch.trains.length} trains bunched within ${formatDistance(bunch.spanFt)}.`;
}

module.exports = {
  lineTitle,
  directionLabel,
  buildGapPostText,
  buildGapAltText,
  buildBunchingPostText,
  buildBunchingAltText,
};
