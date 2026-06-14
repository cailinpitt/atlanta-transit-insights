// MARTA rail gap detection — an oversized stretch of a line with no train,
// versus the scheduled rail headway. Same shape as bus gaps, but over train
// positions grouped by (line, direction), with rail-scale constants and a
// line-level headway (the feed's N/S/E/W direction doesn't map to GTFS
// direction_id, and rail headways are ~symmetric, so we use the line headway).
const { terminalZoneFt } = require('../../shared/geo');
const { latestTrainPositions } = require('./trains');
const { loadScheduleIndex, headwayForLine } = require('../bus/schedule');

// Rail cruises ~30 mph ≈ 2640 ft/min between stations — used only as a ratio
// against scheduled headway, not an absolute ETA.
const TYPICAL_SPEED_FT_PER_MIN = 2640;
const RATIO_THRESHOLD = 2.5;
const ABSOLUTE_MIN_MIN = 12; // rail headways are short; a 12-min hole is notable

// `trains` are latestTrainPositions() entries.
//   headwayFor: (line) => scheduled headway minutes, or null to skip
//   lengthFor:  (line) => line length in feet
function detectRailGaps(trains, { headwayFor, lengthFor } = {}) {
  const byKey = new Map();
  for (const t of trains || []) {
    if (!Number.isFinite(t.distFt)) continue;
    const key = `${t.line}/${t.direction}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(t);
  }

  const gaps = [];
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    const [line, direction] = key.split('/');
    const expectedMin = headwayFor(line);
    if (expectedMin == null || expectedMin <= 0) continue;
    const lengthFt = lengthFor(line) || group[0].lengthFt || 0;
    if (!lengthFt) continue;
    const zoneFt = terminalZoneFt(lengthFt);

    const sorted = [...group].sort((a, b) => a.distFt - b.distFt);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (a.distFt < zoneFt) continue;
      if (lengthFt - b.distFt < zoneFt) continue;
      const gapFt = b.distFt - a.distFt;
      const gapMin = gapFt / TYPICAL_SPEED_FT_PER_MIN;
      if (gapMin < ABSOLUTE_MIN_MIN) continue;
      const ratio = gapMin / expectedMin;
      if (ratio < RATIO_THRESHOLD) continue;
      gaps.push({ line, direction, leading: b, trailing: a, gapFt, gapMin, expectedMin, ratio });
    }
  }

  gaps.sort((a, b) => b.ratio - a.ratio);
  return gaps;
}

function railGapsFromObservations(observations, { lineGeom, index, now = Date.now() } = {}) {
  const idx = loadScheduleIndex(index);
  const nowDate = new Date(now);
  const lengthByLine = new Map([...lineGeom].map(([line, g]) => [line, g.lengthFt]));
  return detectRailGaps(latestTrainPositions(observations, lineGeom, { now }), {
    headwayFor: (line) => headwayForLine(idx, line, nowDate),
    lengthFor: (line) => lengthByLine.get(line) || 0,
  });
}

module.exports = {
  detectRailGaps,
  railGapsFromObservations,
  RATIO_THRESHOLD,
  ABSOLUTE_MIN_MIN,
  TYPICAL_SPEED_FT_PER_MIN,
};
