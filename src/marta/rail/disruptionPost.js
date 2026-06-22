// Post text for rail dead-segment ("pulse") disruptions — MARTA-branded port of
// the train half of cta-insights src/shared/disruption.js.
//
// Disruption shape:
//   { line, suspendedSegment: {from, to}, terminus?: string|null,
//     source: 'observed'|'observed-held', kind: 'cold'|'held', evidence }
//
// These are an inference from live train positions (not an official MARTA
// declaration), so the framing hedges — "stalled" / "may be holding" — and the
// footer says so.

const { lineTitle } = require('./post');
// rail-stations.json names are SCREAMING with a "Station" suffix ("LENOX
// Station"); present them rider-facing in post text ("Lenox"). The canonical
// name stays in the disruption/evidence for /station/:slug matching downstream.
const { displayStationName: displayStation } = require('./stations');

const POST_GRAPHEME_LIMIT = 300;

function seg(d) {
  return {
    from: displayStation(d.suspendedSegment?.from),
    to: displayStation(d.suspendedSegment?.to),
  };
}

function graphemeLen(s) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
    let n = 0;
    for (const _ of seg.segment(s)) n++;
    return n;
  }
  return [...s].length;
}

function titleFor(d) {
  const name = lineTitle(d.line);
  if (d.kind === 'held' || d.source === 'observed-held') {
    const anchor = displayStation(d.suspendedSegment?.from) || 'this stretch';
    return `🚇🚨 ${name}: trains stuck around ${anchor}`;
  }
  // Cold-segment detection measures whether trains have *advanced through* a
  // stretch. A train held in a station keeps pinging the same bin and reads
  // "cold" once the threshold passes even though it's still visible — "stalled"
  // is accurate whether trains are missing or just stopped.
  if (d.terminus) return `🚇⚠️ ${name}: trains toward ${d.terminus} stalled`;
  return `🚇⚠️ ${name}: trains stalled`;
}

function evidenceLine(e, { compact = false, minimal = false, kind = 'cold' } = {}) {
  if (kind === 'held' && e.held) {
    const minutes = Math.round((e.held.stationaryMs || 0) / 60000);
    const stationsList =
      e.coldStationNames && e.coldStationNames.length > 0
        ? ` near ${e.coldStationNames.slice(0, 3).join(', ')}`
        : '';
    if (minimal) {
      return `🛑 ${e.held.trainCount} train${e.held.trainCount === 1 ? '' : 's'} stationary ${minutes}+ min.`;
    }
    if (compact) {
      return `🛑 ${e.held.trainCount} train${e.held.trainCount === 1 ? '' : 's'} stationary ${minutes}+ min${stationsList}.`;
    }
    return `🛑 ${e.held.trainCount} train${e.held.trainCount === 1 ? '' : 's'} stationary ${minutes}+ min${stationsList}. No moving trains nearby.`;
  }
  const headwayClause =
    e.headwayMin != null ? ` — scheduled every ${Math.round(e.headwayMin)} min` : '';
  if (e.synthetic) {
    if (minimal) return '📡 No trains observed anywhere on the line.';
    const stations = e.coldStations >= 2 ? ` (${e.coldStations} stations affected)` : '';
    return `📡 No trains observed anywhere on the line in the last ${e.lookbackMin || 20} min${stations}${headwayClause}.`;
  }
  const stretch = e.runLengthMi != null ? `${e.runLengthMi}-mi stretch` : 'this stretch';
  const stations = e.coldStations >= 2 ? ` (${e.coldStations} stations affected)` : '';
  const since =
    e.minutesSinceLastTrain != null
      ? `the last ${e.minutesSinceLastTrain} min`
      : `the last ${e.lookbackMin || 20} min`;
  if (minimal) {
    return `📡 No trains have moved through this stretch in ${since}. Trains may be holding.`;
  }
  if (compact) {
    return `📡 No trains have moved through this ${stretch} in ${since}${headwayClause}. Trains may be holding.`;
  }
  const missing =
    e.expectedTrains != null && e.expectedTrains >= 1
      ? `, ~${e.expectedTrains} train${e.expectedTrains === 1 ? '' : 's'} missed`
      : '';
  const elsewhere =
    e.trainsOutsideRun != null
      ? ` (${e.trainsOutsideRun} train${e.trainsOutsideRun === 1 ? '' : 's'} still moving elsewhere on the line)`
      : '';
  return `📡 No trains have moved through this ${stretch}${stations} in ${since}${headwayClause}${missing}${elsewhere}. Trains may be holding in stations.`;
}

function footerFor(source, { alertOpen = false } = {}) {
  if (source === 'observed' || source === 'observed-held') {
    return alertOpen
      ? 'Inferred from live train positions. (See MARTA alert in this thread.)'
      : 'Inferred from live train positions; no MARTA alert on this at the moment.';
  }
  return '';
}

function buildPostText(d, { alertOpen = false } = {}) {
  const { source, evidence } = d;
  const suspendedSegment = seg(d);
  const isObserved = source === 'observed' || source === 'observed-held';
  const fullEvidence = isObserved && evidence ? evidenceLine(evidence, { kind: d.kind }) : null;
  const shortEvidence =
    isObserved && evidence ? evidenceLine(evidence, { compact: true, kind: d.kind }) : null;
  const minimalEvidence =
    isObserved && evidence ? evidenceLine(evidence, { minimal: true, kind: d.kind }) : null;

  const compose = (evidenceText) => {
    const lines = [titleFor(d)];
    lines.push('', `Between ${suspendedSegment.from} and ${suspendedSegment.to}.`);
    if (evidenceText) lines.push('', evidenceText);
    lines.push('', footerFor(source, { alertOpen }));
    return lines.join('\n');
  };

  let text = compose(fullEvidence);
  if (graphemeLen(text) <= POST_GRAPHEME_LIMIT) return text;
  text = compose(shortEvidence);
  if (graphemeLen(text) <= POST_GRAPHEME_LIMIT) return text;
  text = compose(minimalEvidence);
  if (graphemeLen(text) <= POST_GRAPHEME_LIMIT) return text;
  return compose(null);
}

function buildAltText(d) {
  const name = lineTitle(d.line);
  const s = seg(d);
  const directionPhrase = d.terminus ? ` toward ${d.terminus}` : '';
  const dimDescription =
    d.kind === 'held' || d.source === 'observed-held'
      ? `dimmed to indicate trains${directionPhrase} are held in stations there`
      : `dimmed to indicate trains${directionPhrase} have not advanced through that stretch`;
  return `Map of the ${name} with the segment between ${s.from} and ${s.to} ${dimDescription}.`;
}

function buildClearPostText(d, { alertOpen = false } = {}) {
  const name = lineTitle(d.line);
  const s = seg(d);
  const segment = `${s.from} ↔ ${s.to}`;
  if (alertOpen) {
    return `🚇 ${name}: the bot's earlier observation cleared — trains running through ${segment} again. MARTA's alert at the top of this thread is still active.`;
  }
  return `🚇✅ ${name} trains running through ${segment} again. (No relevant MARTA alert was posted.)`;
}

// Concise headline for the resolution link card (drops emoji + alert clause).
function buildClearCardTitle(d) {
  const name = lineTitle(d.line);
  const s = seg(d);
  return `${name} trains running through ${s.from} ↔ ${s.to} again`;
}

module.exports = {
  buildPostText,
  buildAltText,
  buildClearPostText,
  buildClearCardTitle,
  titleFor,
  footerFor,
  evidenceLine,
};
