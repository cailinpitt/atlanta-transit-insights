// MARTA rail ghost detection — scheduled rail service that isn't running. Reuses
// the bus ghost engine (observed distinct vehicles/snapshot vs scheduled active
// count), grouped per LINE: the feed's N/S/E/W direction doesn't map to GTFS
// direction_id, so we count all trains on a line and compare to the line's total
// scheduled active trips (both directions). No projection needed — this is a
// head-count over snapshots.
const { detectBusGhosts } = require('../bus/ghosts');
const { loadScheduleIndex, activeForLine, headwayForLine } = require('../bus/schedule');

// `observations` are rail_observations rows { ts, train_id, line }. Returns the
// same event shape as bus ghosts, with `route` = line and direction collapsed.
function railGhostsFromObservations(observations, { index, lines, onDrop, now = Date.now() } = {}) {
  const idx = loadScheduleIndex(index);
  const nowDate = new Date(now);
  const byLine = new Map();
  for (const o of observations || []) {
    const trainId = o.train_id ?? o.trainId;
    if (!o.line || trainId == null) continue;
    if (!byLine.has(o.line)) byLine.set(o.line, []);
    // Collapse direction to a constant so the engine counts the whole line.
    byLine.get(o.line).push({ ts: o.ts, vehicleId: trainId, direction: 'line' });
  }
  return detectBusGhosts({
    routes: lines || [...byLine.keys()],
    getObservations: (line) => byLine.get(line) || [],
    expectedActive: (line) => activeForLine(idx, line, nowDate),
    expectedHeadway: (line) => headwayForLine(idx, line, nowDate),
    onDrop,
  });
}

module.exports = { railGhostsFromObservations };
