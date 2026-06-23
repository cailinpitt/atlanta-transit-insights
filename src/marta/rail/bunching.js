// MARTA rail bunching — trains packed too close on the same line+direction.
// Same clustering shape as bus bunching, but over train positions grouped by
// (line, direction) and with a rail-scale threshold (trains are far longer than
// bus headways, so "bunched" means within ~half a mile, not ~2 blocks).
const { haversineFt, terminalZoneFt } = require('../../shared/geo');
const { latestTrainPositions } = require('./trains');

const RAIL_BUNCH_THRESHOLD_FT = 2640; // ~0.5 mi
const GEO_SLACK_FT = 1000; // straight-line vs along-line slack (curves, parallel track)

// The (line, direction) feed label is sometimes shared by trains physically
// moving opposite ways (e.g. one reversing at a pocket track, or a mislabeled
// run). motionSign — derived from each train's recent along-line movement —
// is the ground truth. Return the sign the most members share; null if no
// member has moved enough to have a sign.
function dominantMotionSign(cluster) {
  const counts = new Map();
  for (const t of cluster) {
    if (t.motionSign == null) continue;
    counts.set(t.motionSign, (counts.get(t.motionSign) || 0) + 1);
  }
  if (counts.size === 0) return null;
  let best = null;
  let bestCount = -1;
  for (const [sign, n] of counts) {
    if (n > bestCount) {
      bestCount = n;
      best = sign;
    }
  }
  return best;
}

// A train is "at a terminal" when its along-line distFt sits within the line's
// terminal zone at either end. Both ends of every MARTA line are turnback
// terminals where trains naturally queue (one arriving while another waits to
// depart), so a layover train has to be dropped BEFORE clustering — otherwise it
// pairs with a train arriving just outside the zone and the two read as a bunch.
// Same per-train gate the cross-line detector uses
// (src/marta/rail/crossBunching.js#isTrainAtTerminal). Needs distFt + lengthFt;
// without them returns false, so geometry-only callers/tests are unaffected.
function isTrainAtTerminal(train) {
  const len = train?.lengthFt;
  const d = train?.distFt;
  if (!Number.isFinite(len) || !Number.isFinite(d) || len <= 0) return false;
  const zone = terminalZoneFt(len);
  return d <= zone || d >= len - zone;
}

// `trains` are latestTrainPositions() entries. Returns clusters best-first
// (size desc, then tightest max-gap).
function detectRailBunching(
  trains,
  { thresholdFt = RAIL_BUNCH_THRESHOLD_FT, excludeTerminal = true } = {},
) {
  const byKey = new Map();
  for (const t of trains || []) {
    if (!Number.isFinite(t.distFt)) continue;
    // Drop terminal layovers up front (see isTrainAtTerminal) so a turnback
    // queue can't anchor a false bunch with an arriving train.
    if (excludeTerminal && isTrainAtTerminal(t)) continue;
    const key = `${t.line}/${t.direction}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(t);
  }

  const bunches = [];
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    const [line, direction] = key.split('/');
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
      const rawCluster = sorted.slice(i, j + 1);
      // Drop members moving against the cluster's dominant direction so a train
      // passing the other way (opposite motionSign) isn't counted in the bunch.
      // Trains with no sign yet (barely moved) stay — they're ambiguous, not
      // contradictory.
      const dom = dominantMotionSign(rawCluster);
      const cluster =
        dom == null
          ? rawCluster
          : rawCluster.filter((t) => t.motionSign == null || t.motionSign === dom);
      if (cluster.length < 2) {
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

module.exports = {
  detectRailBunching,
  railBunchesFromObservations,
  isTrainAtTerminal,
  RAIL_BUNCH_THRESHOLD_FT,
};
