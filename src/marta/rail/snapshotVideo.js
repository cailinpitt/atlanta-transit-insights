// System-wide rail timelapse — every in-service train across all four lines,
// gliding along the network over a recent window. The MARTA analog of the CTA L
// "snapshot" video. Unlike the incident clips this reads the stored observation
// history (the observe loop already records a snapshot every ~30s), so the bin
// runs fast and never has to poll the live feed.
//
// Each train is snapped to its own line, so the dropout/interpolation kernel
// (src/shared/videoTracks.js) needs a PER-TRAIN pointAlong — hence this builds
// frames directly rather than via the single-route smoothFrames helper.
const { buildVehicleSeries, vehicleStateAt } = require('../../shared/videoTracks');
const { projectTrain } = require('./lines');
const { pointAlongShape } = require('../bus/shapes');
const { computeSystemView, fetchSystemBase, renderSystemFrame } = require('../map/railSystem');
const { encodeFrames } = require('../shared/video');

const DEFAULT_INTERPOLATE = 4;
const DEFAULT_FRAMERATE = 16;
// Fade an end-of-service / dropped train fully over this window so a stale dot
// doesn't linger across the whole system view.
const SNAPSHOT_TAIL_FADE_MS = 90_000;

// Project each rail observation onto its line for an along-route distance and a
// jitter-free snapped position. Rows that don't project (off-route / unknown
// line) keep their raw lat/lon and get no track (kernel lerps lat/lon).
function enrichRows(rows, lineGeom) {
  const out = [];
  for (const r of rows || []) {
    const trainId = r.train_id ?? r.trainId;
    if (trainId == null || !Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    const entry = { ts: r.ts, trainId, line: r.line, lat: r.lat, lon: r.lon, distFt: null };
    const proj = projectTrain(lineGeom, r);
    if (proj) {
      entry.distFt = proj.distFt;
      const snapped = pointAlongShape(lineGeom.get(r.line), proj.distFt);
      if (snapped) {
        entry.lat = snapped.lat;
        entry.lon = snapped.lon;
      }
    }
    out.push(entry);
  }
  return out;
}

function snapshotsByTimestamp(rows) {
  const byTs = new Map();
  for (const r of rows) {
    if (!byTs.has(r.ts)) byTs.set(r.ts, []);
    byTs.get(r.ts).push(r);
  }
  return [...byTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, vehicles]) => ({ ts, vehicles }));
}

async function captureRailSystemTimelapse(rows, lineGeom, opts = {}) {
  const interpolate = Math.max(1, opts.interpolate || DEFAULT_INTERPOLATE);
  const framerate = opts.framerate || DEFAULT_FRAMERATE;

  const snapshots = snapshotsByTimestamp(enrichRows(rows, lineGeom)).filter(
    (s) => s.vehicles.length > 0,
  );
  if (snapshots.length < 2) return null;

  const view = computeSystemView(lineGeom);
  const baseMap = await fetchSystemBase(view, lineGeom);

  const lineByTrain = new Map();
  for (const s of snapshots) {
    for (const v of s.vehicles) if (!lineByTrain.has(v.trainId)) lineByTrain.set(v.trainId, v.line);
  }

  const series = buildVehicleSeries(snapshots, {
    itemsOf: (s) => s.vehicles,
    idOf: (v) => v.trainId,
    trackOf: (v) => v.distFt,
  });
  const videoEndTs = snapshots[snapshots.length - 1].ts;

  const trainFrames = [];
  const pushFrame = (frameTs) => {
    const frame = [];
    for (const [trainId, s] of series) {
      const geom = lineGeom.get(lineByTrain.get(trainId));
      const pointAlong = geom ? (track) => pointAlongShape(geom, track) : null;
      const st = vehicleStateAt(s, frameTs, {
        pointAlong,
        realTerminalEnds: [],
        videoEndTs,
        tailFadeMs: SNAPSHOT_TAIL_FADE_MS,
      });
      if (st) frame.push(st);
    }
    trainFrames.push(frame);
  };
  for (let i = 0; i < snapshots.length - 1; i++) {
    const span = snapshots[i + 1].ts - snapshots[i].ts;
    for (let k = 0; k < interpolate; k++) pushFrame(snapshots[i].ts + (span * k) / interpolate);
  }
  pushFrame(videoEndTs);

  const images = [];
  for (const trains of trainFrames) {
    images.push(await renderSystemFrame(view, baseMap, trains));
  }
  const buffer = await encodeFrames(images, { prefix: 'marta-rail-system', framerate });
  if (!buffer) return null;

  // Union of trains seen across the window, deduped by id — so a train that
  // started or ended service mid-window still counts in the per-line breakdown.
  const seen = new Map();
  for (const s of snapshots) {
    for (const v of s.vehicles) if (!seen.has(v.trainId)) seen.set(v.trainId, { line: v.line });
  }
  return {
    buffer,
    frameCount: trainFrames.length,
    elapsedSec: Math.round((videoEndTs - snapshots[0].ts) / 1000),
    startTs: snapshots[0].ts,
    endTs: videoEndTs,
    allTrains: [...seen.values()],
    finalTrains: snapshots[snapshots.length - 1].vehicles,
  };
}

module.exports = { captureRailSystemTimelapse };
