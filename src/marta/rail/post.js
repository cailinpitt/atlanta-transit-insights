const { formatCallouts } = require('../shared/incidents');
const { describeGhost } = require('../../shared/ghostFormat');
const {
  formatDistance,
  formatMinutes,
  formatTimeET,
  elapsedMinutesLabel,
  keycapNumber,
  formatDeviation,
} = require('../shared/format');
const { displayStationName } = require('./stations');

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

// Name the empty stretch as a range between the stations flanking it, like the
// bus gap post and cta-insights src/train. A long gap can span several stations,
// so "near <midpoint>" both under-states the hole and disagrees with the map
// (which labels the flanks). Fall back to the midpoint station when a flank is
// missing (gap reaching a terminal), and to the bare mileage when we have
// neither.
function gapWhereClause(gap) {
  const before = gap.flankBefore?.name ? displayStationName(gap.flankBefore.name) : null;
  const after = gap.flankAfter?.name ? displayStationName(gap.flankAfter.name) : null;
  const mid = gap.midStation?.name ? displayStationName(gap.midStation.name) : null;
  if (before && after) return ` between ${before} and ${after}`;
  if (before || after) return ` past ${before || after}`;
  if (mid) return ` near ${mid}`;
  return ` across ~${formatDistance(gap.gapFt)}`;
}

function buildGapPostText(gap, callouts = [], opts = {}) {
  const dir = directionLabel(gap.direction, gap.terminus);
  const where = dir ? ` - ${dir}` : '';
  // `leading` is the train already past the gap (last seen); `trailing` is the
  // next one a rider is waiting for — spelled out, matching the map's L/N chips.
  // Each carries its schedule adherence ("3 min late") when the caller supplies it.
  const devSuffix = (min) => {
    const d = formatDeviation(min);
    return d ? ` (${d})` : '';
  };
  const lastSeen = gap.leading?.trainId
    ? `#${gap.leading.trainId}${devSuffix(opts.leadingDev)}`
    : null;
  const nextUp = gap.trailing?.trainId
    ? `#${gap.trailing.trainId}${devSuffix(opts.trailingDev)}`
    : null;
  const trainsLine =
    lastSeen || nextUp
      ? `\n\n${[lastSeen && `Last seen: ${lastSeen}`, nextUp && `Next up: ${nextUp}`]
          .filter(Boolean)
          .join(' · ')}`
      : '';
  const base = `🚇 ${lineTitle(gap.line)}${where}\n\nNo trains${gapWhereClause(gap)} - a ~${formatMinutes(gap.gapMin)} gap, scheduled around every ${formatMinutes(gap.expectedMin)} this hour${trainsLine}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n\n${tail}` : base;
}

function buildGapAltText(gap) {
  const dir = directionLabel(gap.direction, gap.terminus, { lower: true });
  const suffix = dir ? ` ${dir}` : '';
  const before = gap.flankBefore?.name ? displayStationName(gap.flankBefore.name) : null;
  const after = gap.flankAfter?.name ? displayStationName(gap.flankAfter.name) : null;
  const mid = gap.midStation?.name ? displayStationName(gap.midStation.name) : null;
  let where = ` across about ${formatDistance(gap.gapFt)}`;
  if (before && after) where = ` with no trains between ${before} and ${after}`;
  else if (mid) where = ` between trains near ${mid}`;
  return `Map of the ${lineTitle(gap.line)}${suffix} showing a ${formatMinutes(gap.gapMin)} rail gap${where}.`;
}

function buildBunchingPostText(bunch, callouts = [], opts = {}) {
  const dir = directionLabel(bunch.direction, bunch.terminus);
  const where = dir ? ` - ${dir}` : '';
  // Per-train schedule adherence ("3 min late"), keyed by trainId, when supplied.
  const deviations = opts.deviations;
  const trains = [...bunch.trains]
    .sort((a, b) => b.distFt - a.distFt)
    .map((t, i) => {
      const n = keycapNumber(i + 1);
      const d = formatDeviation(deviations?.get(t.trainId));
      return d ? `#${t.trainId} (${n}, ${d})` : `#${t.trainId} (${n})`;
    })
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

// Timelapse reply text. The clip is framed on the gap *midpoint* station
// (video.stationName) with the "Next up" train filmed closing on it, so the
// reply names that station and flags it as "the middle of the gap" — explaining
// why the train still has distance to cover (it's crossing only the back half).
// Falls back to the generic "recent movement" line when no midpoint resolves.
function buildGapVideoPostText(video, gap) {
  const hasMidpoint = video?.reached || video?.endDistFt != null;
  if (!hasMidpoint) {
    const elapsed = video?.elapsedSec
      ? `${Math.max(1, Math.round(video.elapsedSec / 60))} min`
      : 'Several minutes';
    return `${elapsed} of recent movement around this ~${formatMinutes(gap.gapMin)} rail gap.`;
  }
  const gapMin = video.gapMin ?? Math.round(gap.gapMin);
  const lead = `~${gapMin} min ${lineTitle(gap.line)} gap.`;
  const run = gap.trailing?.trainId ? ` (#${gap.trailing.trainId})` : '';
  const elapsed = elapsedMinutesLabel(video.elapsedSec || 0);
  const station = video.stationName ? displayStationName(video.stationName) : null;
  if (video.reached) {
    const where = station ? `${station} — the middle of the gap —` : 'the middle of the gap';
    return `${lead} The next train${run} reached ${where} ${elapsed} later.`;
  }
  const remaining = formatDistance(Math.max(0, video.endDistFt || 0));
  const where = station ? `${station} — the middle of the gap` : 'the middle of the gap';
  return `${lead} ${elapsed} later, the next train${run} had closed to within ~${remaining} of ${where}.`;
}

function buildGapVideoAltText(gap, video = null) {
  const dir = directionLabel(gap.direction, gap.terminus, { lower: true });
  const suffix = dir ? ` ${dir}` : '';
  const hasMidpoint = video?.reached || video?.endDistFt != null;
  if (hasMidpoint) {
    const station = video.stationName ? displayStationName(video.stationName) : null;
    const where = station ? `${station}, the middle of the gap,` : 'the middle of the gap';
    const over = video.elapsedSec ? ` over ${formatMinutes(video.elapsedSec / 60)}` : '';
    return `Timelapse map of the ${lineTitle(gap.line)}${suffix}: the next train closing on ${where}${over}.`;
  }
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
