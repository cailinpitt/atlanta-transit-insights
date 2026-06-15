// Shared rail helper: reduce a window of rail observations to the most recent
// position per train, projected onto its line. Gaps and bunching both reason
// over "where is each train right now," so this is their common substrate.
const { projectTrain } = require('./lines');

const STALE_MS = 3 * 60 * 1000;
const MOTION_MIN_DELTA_FT = 100;

function motionSign(deltaFt) {
  if (!Number.isFinite(deltaFt) || Math.abs(deltaFt) < MOTION_MIN_DELTA_FT) return null;
  return deltaFt > 0 ? 1 : -1;
}

// `observations` are rail_observations rows
// { ts, train_id, line, direction, lat, lon, delay_sec }. Returns one entry per
// (line, direction, train) — the freshest, projected, dropping stale/off-route.
function latestTrainPositions(
  observations,
  lineGeom,
  { now = Date.now(), staleMs = STALE_MS } = {},
) {
  const latest = new Map();
  const history = new Map();
  for (const o of observations || []) {
    const trainId = o.train_id ?? o.trainId;
    if (trainId == null) continue;
    const key = `${o.line}/${o.direction}/${trainId}`;
    const proj = projectTrain(lineGeom, o);
    if (proj) {
      if (!history.has(key)) history.set(key, []);
      history.get(key).push({ ts: o.ts, distFt: proj.distFt });
    }
    const prev = latest.get(key);
    if (!prev || o.ts > prev.ts) latest.set(key, o);
  }
  const out = [];
  for (const o of latest.values()) {
    if (now - o.ts > staleMs) continue;
    const proj = projectTrain(lineGeom, o);
    if (!proj) continue;
    const pts = (history.get(`${o.line}/${o.direction}/${o.train_id ?? o.trainId}`) || []).sort(
      (a, b) => a.ts - b.ts,
    );
    const sign = pts.length >= 2 ? motionSign(pts[pts.length - 1].distFt - pts[0].distFt) : null;
    out.push({
      line: o.line,
      direction: o.direction,
      trainId: o.train_id ?? o.trainId,
      distFt: proj.distFt,
      lengthFt: proj.lengthFt,
      lat: o.lat,
      lon: o.lon,
      ts: o.ts,
      delaySec: o.delay_sec ?? o.delaySec ?? null,
      motionSign: sign,
    });
  }
  return out;
}

module.exports = { latestTrainPositions, STALE_MS };
