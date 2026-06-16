// MARTA rail speedmap.
//
// Unlike bus, the rail feed reports no speed — but Path A gives stable train
// identity + true positions, so speed is reconstructed from how far a train
// moved along its line between snapshots (the CTA approach). Each consecutive
// pair of observations of the same train becomes one { distFt, mph } sample,
// binned along the line per direction.
const { projectTrain } = require('./lines');
const { binSamples } = require('../bus/speedmap');

const MIN_DT_MS = 10_000; // need a real time gap (observers tick ~30s apart)
const MAX_DT_MS = 5 * 60_000; // a pair spanning a gap/outage isn't a clean sample
const MAX_MPH = 75; // reject GPS jumps / shape wraparound at Five Points
const FT_PER_S_TO_MPH = 3600 / 5280;

// 5-bucket rail scheme, matching the CTA train slow-zone bands.
const RAIL_THRESHOLDS = { orange: 15, yellow: 25, purple: 35, green: 45 };

function colorForRailSpeed(mph) {
  if (mph == null) return '444';
  if (mph < 15) return 'ff2a2a'; // red
  if (mph < 25) return 'ff8c1a'; // orange
  if (mph < 35) return 'ffd21a'; // yellow
  if (mph < 45) return 'a855f7'; // purple
  return '2ad17f'; // green
}

// Build per-(line, direction) speed samples from rail observations. `obs` rows:
// { ts, train_id, line, direction, lat, lon } (streetcar rows carry vehicleId
// instead of train_id). Returns Map<"line/direction", [{ distFt, mph }]>.
// `maxMph` caps GPS jumps / loop wraparound and is tighter for the streetcar.
function buildSpeedSamples(observations, { lineGeom, maxMph = MAX_MPH } = {}) {
  const byTrain = new Map();
  for (const o of observations || []) {
    const proj = projectTrain(lineGeom, o);
    if (!proj) continue;
    const id = o.train_id ?? o.trainId ?? o.vehicle_id ?? o.vehicleId;
    const key = `${o.line}/${o.direction}/${id}`;
    if (!byTrain.has(key)) byTrain.set(key, []);
    byTrain.get(key).push({ ts: o.ts, distFt: proj.distFt, line: o.line, direction: o.direction });
  }

  const byLineDir = new Map();
  for (const pts of byTrain.values()) {
    pts.sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < pts.length; i++) {
      const dt = pts[i].ts - pts[i - 1].ts;
      if (dt < MIN_DT_MS || dt > MAX_DT_MS) continue;
      // abs: the canonical shape may run opposite to the train's direction, so
      // one direction decreases distFt. Speed is unsigned.
      const dft = Math.abs(pts[i].distFt - pts[i - 1].distFt);
      const mph = (dft / (dt / 1000)) * FT_PER_S_TO_MPH;
      if (mph > maxMph) continue;
      const midDist = (pts[i].distFt + pts[i - 1].distFt) / 2;
      const key = `${pts[i].line}/${pts[i].direction}`;
      if (!byLineDir.has(key)) byLineDir.set(key, []);
      byLineDir.get(key).push({ distFt: midDist, mph });
    }
  }
  return byLineDir;
}

function summarize(bins, thresholds = RAIL_THRESHOLDS) {
  const valid = bins.filter((s) => s != null);
  const base = {
    avg: null,
    red: 0,
    orange: 0,
    yellow: 0,
    purple: 0,
    green: 0,
    bins: bins.length,
    covered: valid.length,
  };
  if (valid.length === 0) return base;
  base.avg = valid.reduce((a, v) => a + v, 0) / valid.length;
  for (const s of valid) {
    if (s < thresholds.orange) base.red++;
    else if (s < thresholds.yellow) base.orange++;
    else if (s < thresholds.purple) base.yellow++;
    else if (s < thresholds.green) base.purple++;
    else base.green++;
  }
  return base;
}

// End-to-end: rail observations → per-(line, direction) speedmap
// { line, direction, lengthFt, bins, summary, sampleCount }. `maxMph` and
// `thresholds` let the streetcar reuse this with its slower speed profile.
function buildLineSpeedmaps(
  observations,
  { lineGeom, numBins = 30, maxMph = MAX_MPH, thresholds = RAIL_THRESHOLDS } = {},
) {
  const samples = buildSpeedSamples(observations, { lineGeom, maxMph });
  const out = new Map();
  for (const [key, list] of samples) {
    const [line, direction] = key.split('/');
    const lengthFt = lineGeom.get(line)?.lengthFt || 0;
    const bins = binSamples(list, lengthFt, numBins);
    out.set(key, {
      line,
      direction,
      lengthFt,
      bins,
      summary: summarize(bins, thresholds),
      sampleCount: list.length,
    });
  }
  return out;
}

module.exports = {
  buildSpeedSamples,
  buildLineSpeedmaps,
  summarize,
  colorForRailSpeed,
  RAIL_THRESHOLDS,
  MAX_MPH,
  MIN_DT_MS,
  MAX_DT_MS,
};
