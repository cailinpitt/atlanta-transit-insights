const { describeGhost } = require('../../shared/ghostFormat');

function abbreviateDirection(dir) {
  if (dir == null) return '';
  const s = String(dir);
  if (s === '0') return 'dir 0';
  if (s === '1') return 'dir 1';
  const m = s.match(/(North|South|East|West)bound/i);
  return m ? `${m[1][0].toUpperCase()}B` : s;
}

function formatGhostLine(event, routeTitle) {
  const dir = abbreviateDirection(event.direction);
  const observed = event.observedDisplay != null ? event.observedDisplay : event.observedActive;
  const { expectedShown, missingShown, pct, headwayPhrase } = describeGhost({
    expectedActive: event.expectedActive,
    observed,
    headway: event.headway,
  });
  const head = `🚌 ${routeTitle} ${dir} · ${missingShown} of ${expectedShown} missing (${pct}%)`;
  const parts = [head];
  if (headwayPhrase) parts.push(headwayPhrase);
  if (event.canceledTrips > 0) {
    parts.push(`${event.canceledTrips} MARTA-canceled trip${event.canceledTrips === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

module.exports = { abbreviateDirection, formatGhostLine };
