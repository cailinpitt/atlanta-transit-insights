const { formatCallouts } = require('../shared/incidents');
const { describeGhost } = require('../../shared/ghostFormat');
const { formatDistance, formatMinutes, formatTimeET, keycapNumber } = require('../shared/format');

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

function buildBunchingVideoPostText(video, bunch) {
  const elapsed = video?.elapsedSec
    ? `${Math.max(1, Math.round(video.elapsedSec / 60))} min`
    : 'Several minutes';
  return `${elapsed} of recent movement from this ${bunch.trains.length}-train bunch.`;
}

function buildBunchingVideoAltText(bunch) {
  const dir = directionLabel(bunch.direction).toLowerCase();
  const suffix = dir ? ` ${dir}` : '';
  return `Timelapse map of the ${lineTitle(bunch.line)}${suffix} showing recent movement of ${bunch.trains.length} bunched trains.`;
}

function buildGapVideoPostText(video, gap) {
  const elapsed = video?.elapsedSec
    ? `${Math.max(1, Math.round(video.elapsedSec / 60))} min`
    : 'Several minutes';
  return `${elapsed} of recent movement around this ~${formatMinutes(gap.gapMin)} rail gap.`;
}

function buildGapVideoAltText(gap) {
  const dir = directionLabel(gap.direction).toLowerCase();
  const suffix = dir ? ` ${dir}` : '';
  return `Timelapse map of the ${lineTitle(gap.line)}${suffix} showing recent movement of the trains flanking a ${formatMinutes(gap.gapMin)} gap.`;
}

function buildSpeedmapPostText(line, direction, summary, startTime, endTime, callouts = []) {
  const avg = summary.avg == null ? 'unavailable' : `${summary.avg.toFixed(1)} mph`;
  const dir = directionLabel(direction);
  const window = `${formatTimeET(startTime)}-${formatTimeET(endTime)} ET`;
  const head = `🚦 ${lineTitle(line)}${dir ? ` - ${dir}` : ''}\n${window} · average speed ${avg}`;
  const tail = formatCallouts(callouts);
  return (
    (tail ? `${head}\n${tail}\n\n` : `${head}\n\n`) +
    'Each colored segment of the line shows how fast trains were moving there:\n' +
    '🟥 under 15 mph - stopped or crawling\n' +
    '🟧 15-25 mph - slow\n' +
    '🟨 25-35 mph - moderate\n' +
    '🟪 35-45 mph - moving\n' +
    '🟩 45+ mph - moving well'
  );
}

function buildSpeedmapAltText(line, direction, summary) {
  const avg = summary.avg == null ? 'unavailable' : `${summary.avg.toFixed(1)} mph`;
  const dir = directionLabel(direction).toLowerCase();
  const suffix = dir ? ` ${dir}` : '';
  return `Speedmap of the ${lineTitle(line)}${suffix} over a one-hour window, with line segments colored by average train speed. Overall average: ${avg}. Red segments indicate trains under 15 mph, orange under 25, yellow under 35, purple under 45, green 45 and above.`;
}

function formatGhostLine(event) {
  const observed = event.observedDisplay != null ? event.observedDisplay : event.observedActive;
  const { expectedShown, missingShown, pct, headwayPhrase } = describeGhost({
    expectedActive: event.expectedActive,
    observed,
    headway: event.headway,
  });
  const head = `🚇 ${lineTitle(event.route)} · ${missingShown} of ${expectedShown} missing (${pct}%)`;
  return headwayPhrase ? `${head} · ${headwayPhrase}` : head;
}

module.exports = {
  lineTitle,
  directionLabel,
  buildGapPostText,
  buildGapAltText,
  buildBunchingPostText,
  buildBunchingAltText,
  buildBunchingVideoPostText,
  buildBunchingVideoAltText,
  buildGapVideoPostText,
  buildGapVideoAltText,
  buildSpeedmapPostText,
  buildSpeedmapAltText,
  formatGhostLine,
};
