// MARTA rail bunching — trains packed too close on the same line+direction.
// Same clustering shape as bus bunching, but over train positions grouped by
// (line, direction) and with a rail-scale threshold (trains are far longer than
// bus headways, so "bunched" means within ~half a mile, not ~2 blocks).
const { haversineFt, terminalZoneFt } = require('../../shared/geo');
const { latestTrainPositions } = require('./trains');

const RAIL_BUNCH_THRESHOLD_FT = 2640; // ~0.5 mi
const GEO_SLACK_FT = 1000; // straight-line vs along-line slack (curves, parallel track)

// `trains` are latestTrainPositions() entries. Returns clusters best-first
// (size desc, then tightest max-gap).
function detectRailBunching(trains, { thresholdFt = RAIL_BUNCH_THRESHOLD_FT } = {}) {
  const byKey = new Map();
  for (const t of trains || []) {
    if (!Number.isFinite(t.distFt)) continue;
    const key = `${t.line}/${t.direction}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(t);
  }

  const bunches = [];
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    const [line, direction] = key.split('/');
    // Both ends of a rail line are turnback terminals where trains naturally
    // queue (one arriving, one waiting to depart) — that's not a real bunch.
    // Suppress any cluster that sits entirely within a terminal zone at either
    // end of the line, mirroring the gap detector's terminal exclusion.
    const lengthFt = group[0]?.lengthFt || 0;
    const zoneFt = lengthFt ? terminalZoneFt(lengthFt) : 0;
    const sorted = [...group].sort((a, b) => a.distFt - b.distFt);

    let i = 0;
    while (i < sorted.length - 1) {
      if (sorted[i + 1].distFt - sorted[i].distFt > thresholdFt) {
        i++;
        continue;
      }
      let j = i + 1;
      let maxGap = sorted[j].distFt - sorted[i].distFt;
      while (j + 1 < sorted.length && sorted[j + 1].distFt - sorted[j].distFt <= thresholdFt) {
        maxGap = Math.max(maxGap, sorted[j + 1].distFt - sorted[j].distFt);
        j++;
      }
      const cluster = sorted.slice(i, j + 1);
      // Whole cluster inside the start- or end-terminal zone → layover queue.
      if (
        zoneFt &&
        (cluster[cluster.length - 1].distFt < zoneFt || cluster[0].distFt > lengthFt - zoneFt)
      ) {
        i = j + 1;
        continue;
      }
      const distSpan = cluster[cluster.length - 1].distFt - cluster[0].distFt;
      let geoSpan = 0;
      for (let a = 0; a < cluster.length; a++) {
        for (let b = a + 1; b < cluster.length; b++) {
          const d = haversineFt(cluster[a], cluster[b]);
          if (d > geoSpan) geoSpan = d;
        }
      }
      if (geoSpan > distSpan + GEO_SLACK_FT) {
        i = j + 1;
        continue;
      }
      bunches.push({ line, direction, trains: cluster, maxGapFt: maxGap, spanFt: distSpan });
      i = j + 1;
    }
  }

  bunches.sort((a, b) =>
    a.trains.length !== b.trains.length
      ? b.trains.length - a.trains.length
      : a.maxGapFt - b.maxGapFt,
  );
  return bunches;
}

// Convenience: project rail observations and detect.
function railBunchesFromObservations(observations, { lineGeom, now = Date.now() } = {}) {
  return detectRailBunching(latestTrainPositions(observations, lineGeom, { now }));
}

module.exports = { detectRailBunching, railBunchesFromObservations, RAIL_BUNCH_THRESHOLD_FT };
