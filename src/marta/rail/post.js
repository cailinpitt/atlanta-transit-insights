const { formatCallouts } = require('../shared/incidents');
const { describeGhost } = require('../../shared/ghostFormat');
const { formatDistance, formatMinutes, formatTimeET, keycapNumber } = require('../shared/format');

function lineTitle(line) {
  // Feed line names are SCREAMING (RED/GOLD/BLUE/GREEN); present them cleanly.
  const name = String(line || '');
  const cased = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
  return `${cased} Line`;
}

const DIRECTION_WORDS = { N: 'Northbound', S: 'Southbound', E: 'Eastbound', W: 'Westbound' };

// "Northbound to North Springs" (or "northbound to North Springs" for alt text,
// which lowercases the leading sentence). Falls back to "<dir>bound" with no
// terminus when either is missing.
function directionLabel(direction, terminus = null, { lower = false } = {}) {
  if (!direction) return '';
  const word = DIRECTION_WORDS[direction] || `${direction}bound`;
  const dir = lower ? word.toLowerCase() : word;
  return terminus ? `${dir} to ${terminus}` : dir;
}

function buildGapPostText(gap, callouts = []) {
  const dir = directionLabel(gap.direction, gap.terminus);
  const where = dir ? ` - ${dir}` : '';
  const base = `🚇 ${lineTitle(gap.line)}${where}\n\nNo trains across ~${formatDistance(gap.gapFt)} - a ~${formatMinutes(gap.gapMin)} gap, scheduled around every ${formatMinutes(gap.expectedMin)} this hour`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n\n${tail}` : base;
}

function buildGapAltText(gap) {
  const dir = directionLabel(gap.direction, gap.terminus, { lower: true });
  const suffix = dir ? ` ${dir}` : '';
  return `Map of the ${lineTitle(gap.line)}${suffix} showing a ${formatMinutes(gap.gapMin)} rail gap across about ${formatDistance(gap.gapFt)}.`;
}

function buildBunchingPostText(bunch, callouts = []) {
  const dir = directionLabel(bunch.direction, bunch.terminus);
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
  const dir = directionLabel(bunch.direction, bunch.terminus, { lower: true });
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
  const dir = directionLabel(bunch.direction, bunch.terminus, { lower: true });
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
  const dir = directionLabel(gap.direction, gap.terminus, { lower: true });
  const suffix = dir ? ` ${dir}` : '';
  return `Timelapse map of the ${lineTitle(gap.line)}${suffix} showing recent movement of the trains flanking a ${formatMinutes(gap.gapMin)} gap.`;
}

function buildSpeedmapPostText(
  line,
  direction,
  summary,
  startTime,
  endTime,
  callouts = [],
  terminus = null,
) {
  const avg = summary.avg == null ? 'unavailable' : `${summary.avg.toFixed(1)} mph`;
  const dir = directionLabel(direction, terminus);
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

function buildSpeedmapAltText(line, direction, summary, terminus = null) {
  const avg = summary.avg == null ? 'unavailable' : `${summary.avg.toFixed(1)} mph`;
  const dir = directionLabel(direction, terminus, { lower: true });
  const suffix = dir ? ` ${dir}` : '';
  return `Speedmap of the ${lineTitle(line)}${suffix} over a one-hour window, with line segments colored by average train speed. Overall average: ${avg}. Red segments indicate trains under 15 mph, orange under 25, yellow under 35, purple under 45, green 45 and above.`;
}

// Display order + names for the system-wide breakdown.
const ALL_LINES = ['RED', 'GOLD', 'BLUE', 'GREEN'];
const LINE_NAMES = { RED: 'Red', GOLD: 'Gold', BLUE: 'Blue', GREEN: 'Green' };

function countByLine(trains) {
  const byLine = new Map();
  for (const t of trains) byLine.set(t.line, (byLine.get(t.line) || 0) + 1);
  return byLine;
}

function buildTimelapsePostText(meta) {
  const trains = meta.allTrains || meta.finalTrains || [];
  const windowMin = meta.windowMin ?? Math.max(1, Math.round(meta.elapsedSec / 60));
  const byLine = countByLine(trains);
  const parts = ALL_LINES.map((l) => `${LINE_NAMES[l]} ${byLine.get(l) || 0}`);
  const window = `${formatTimeET(new Date(meta.startTs))}-${formatTimeET(new Date(meta.endTs))} ET`;
  return `🚆 MARTA Rail · ${windowMin}-min timelapse\n${window} · ${trains.length} trains\n\n${parts.join(' · ')}`;
}

function buildTimelapseAltText(meta) {
  const trains = meta.allTrains || meta.finalTrains || [];
  const windowMin = meta.windowMin ?? Math.max(1, Math.round(meta.elapsedSec / 60));
  const byLine = countByLine(trains);
  const summary = ALL_LINES.map((l) => `${byLine.get(l) || 0} ${LINE_NAMES[l]}`).join(', ');
  return `${windowMin}-minute timelapse of MARTA rail movement across metro Atlanta, colored by line. ${trains.length} trains appeared during the window: ${summary}.`;
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
  buildTimelapsePostText,
  buildTimelapseAltText,
  formatGhostLine,
};
