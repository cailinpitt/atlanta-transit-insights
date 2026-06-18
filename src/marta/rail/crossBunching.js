// Cross-line rail bunching — trains from 2+ lines stacked at one spot. Port of
// cta-insights src/train/crossBunching.js. The per-line detector in bunching.js
// groups by (line, direction) and projects to that line's geometry, so it never
// compares a RED train against a GOLD one. But MARTA lines converge: RED+GOLD
// share the N-S trunk, BLUE+GREEN the E-W, and all four pass through Five
// Points — so a real pileup there spans lines. Here we cluster purely on
// geography across ALL lines, then require 2+ lines and congestion.
const { clusterByProximity, clusterStats } = require('../shared/geoClusters');

const CROSS_RADIUS_FT = 1500; // station + platform approach (trains are long)
const MIN_TRAINS = 3;
const MIN_LINES = 2;
const MIN_STOPPED = 2; // congestion evidence — a real pileup, not trains passing through

// `trains` are latestTrainPositions() entries { line, trainId, lat, lon,
// motionSign, ... }. Congestion is intrinsic: a train with motionSign == null
// barely moved over the window (stopped/crawling). `stoppedIds` (Set of
// trainIds) overrides that derivation for tests. Best-first: most trains,
// tie-break tightest span.
function detectCrossLineBunches(
  trains,
  {
    stoppedIds = null,
    radiusFt = CROSS_RADIUS_FT,
    minTrains = MIN_TRAINS,
    minLines = MIN_LINES,
    minStopped = MIN_STOPPED,
  } = {},
) {
  const positioned = (trains || []).filter(
    (t) => Number.isFinite(t?.lat) && Number.isFinite(t?.lon) && t?.line,
  );
  const isStopped = (t) => (stoppedIds ? stoppedIds.has(t.trainId) : t.motionSign == null);

  const out = [];
  for (const members of clusterByProximity(positioned, { radiusFt })) {
    if (members.length < minTrains) continue;
    const { spanFt, routes: lines, centroid } = clusterStats(members, { routeKey: (t) => t.line });
    if (lines.size < minLines) continue;
    if (members.filter(isStopped).length < minStopped) continue;
    out.push({
      trains: members,
      lines: [...lines].sort(),
      lineCount: lines.size,
      spanFt: Math.round(spanFt),
      centroid,
    });
  }
  out.sort((a, b) =>
    a.trains.length !== b.trains.length ? b.trains.length - a.trains.length : a.spanFt - b.spanFt,
  );
  return out;
}

// Group a cluster's trains by line, each group sorted by trainId, with a
// per-train disc number (1 = first listed). Returns
// { byLine: [{ line, trains:[{trainId,n}] }], labels: Map<trainId,n> } in line
// order (most trains first, tie-break line name).
function groupByLine(cluster) {
  const groups = new Map();
  for (const t of cluster.trains) {
    if (!groups.has(t.line)) groups.set(t.line, []);
    groups.get(t.line).push(t);
  }
  const ordered = [...groups.entries()]
    .map(([line, ts]) => ({
      line,
      trains: ts.sort((a, b) => String(a.trainId).localeCompare(String(b.trainId))),
    }))
    .sort((a, b) =>
      a.trains.length !== b.trains.length
        ? b.trains.length - a.trains.length
        : String(a.line).localeCompare(String(b.line)),
    );
  const labels = new Map();
  let n = 0;
  const byLine = ordered.map((g) => ({
    line: g.line,
    trains: g.trains.map((t) => {
      n += 1;
      labels.set(t.trainId, n);
      return { trainId: t.trainId, n };
    }),
  }));
  return { byLine, labels };
}

module.exports = {
  detectCrossLineBunches,
  groupByLine,
  CROSS_RADIUS_FT,
  MIN_TRAINS,
  MIN_LINES,
  MIN_STOPPED,
};
