const { projectTrain } = require('./lines');
const { displayStationName } = require('./stations');
const { TYPICAL_SPEED_FT_PER_MIN } = require('./gaps');
const { pointAlongShape } = require('../bus/shapes');
const {
  viewFor,
  gapViewFor,
  fetchBaseMap,
  renderRailFrame,
  bunchBounds,
} = require('../map/railIncidents');
const { encodeFrames } = require('../shared/video');
const { buildSmoothFrames, snapshotsByTimestamp } = require('../shared/smoothFrames');

const VIDEO_WINDOW_MS = 10 * 60 * 1000;
// Within this distance the "Next up" train counts as having reached the midpoint
// wait station; outside it the readout/reply report the remaining distance.
const ARRIVED_FT = 500;

// One frame's HUD line. `deltaFt` is the signed distance from the "Next up"
// train to the midpoint wait station (positive while approaching, ~0 at the
// station, negative once past). Ported from cta-insights src/train/gapVideo.js.
function gapReadout(gapMin, stationName, deltaFt) {
  const head = `~${gapMin}-min gap · next train`;
  const name = stationName ? displayStationName(stationName) : null;
  if (deltaFt < -ARRIVED_FT) return name ? `${head} left ${name}` : `${head} has left`;
  if (deltaFt <= ARRIVED_FT) return name ? `${head} reaching ${name}` : `${head} arriving`;
  const min = Math.max(1, Math.round(deltaFt / TYPICAL_SPEED_FT_PER_MIN));
  return name ? `${head} ~${min} min to ${name}` : `${head} ~${min} min`;
}

function enrichRows(rows, { lineGeom, line, direction, trainIds }) {
  const ids = new Set([...trainIds].map(String));
  const out = [];
  for (const row of rows || []) {
    const trainId = row.trainId ?? row.train_id;
    if (!ids.has(String(trainId))) continue;
    if (row.line !== line || row.direction !== direction) continue;
    const proj = projectTrain(lineGeom, row);
    if (!proj) continue;
    out.push({ ...row, trainId, distFt: proj.distFt, lengthFt: proj.lengthFt });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function spanFt(items = []) {
  const dists = items.map((v) => v.track ?? v.distFt).filter((d) => Number.isFinite(d));
  if (dists.length < 2) return null;
  return Math.round(Math.max(...dists) - Math.min(...dists));
}

async function captureRailBunchingHistoryVideo(bunch, line, rows, opts = {}) {
  const ids = bunch.trains.map((t) => t.trainId);
  const enriched = enrichRows(rows, {
    lineGeom: opts.lineGeom,
    line: bunch.line,
    direction: bunch.direction,
    trainIds: ids,
  });
  const snapshots = snapshotsByTimestamp(enriched).filter((s) => s.vehicles.length > 0);
  if (snapshots.length < 2) return null;

  // Frame to the bunch's stretch over the whole clip (all enriched positions,
  // ±context) so the viewport stays tight on the event yet stable as trains
  // move. Pass bunch.trains (which carry motionSign) so the arrow points the way
  // the cluster travels; the framing window comes from the full enriched span.
  const view = viewFor(line, bunch.trains, bunchBounds(line, enriched));
  const baseMap = await fetchBaseMap(view);

  const { frames, times, startTs, videoEndTs } = buildSmoothFrames(snapshots, {
    idOf: (t) => t.trainId,
    trackOf: (t) => t.distFt,
    pointAlong: (track) => pointAlongShape(line, track),
  });
  const totalSec = Math.max(1, (videoEndTs - startTs) / 1000);
  const images = [];
  for (let i = 0; i < frames.length; i++) {
    images.push(
      await renderRailFrame(view, baseMap, frames[i], {
        labels: opts.labels,
        clock: { elapsedSec: (times[i] - startTs) / 1000, totalSec },
      }),
    );
  }
  const buffer = await encodeFrames(images, { prefix: 'marta-rail-bunching' });
  if (!buffer) return null;
  return {
    buffer,
    elapsedSec: Math.round((snapshots.at(-1).ts - snapshots[0].ts) / 1000),
    frameCount: frames.length,
    initialSpanFt: spanFt(frames[0]),
    finalSpanFt: spanFt(frames.at(-1)),
  };
}

async function captureRailGapHistoryVideo(gap, line, rows, opts = {}) {
  const leadingId = gap.leading?.trainId;
  const trailingId = gap.trailing?.trainId;
  if (leadingId == null || trailingId == null) return null;
  const enriched = enrichRows(rows, {
    lineGeom: opts.lineGeom,
    line: gap.line,
    direction: gap.direction,
    trainIds: [leadingId, trailingId],
  });
  const snapshots = snapshotsByTimestamp(enriched).filter((s) => s.vehicles.length > 0);
  if (snapshots.length < 2) return null;

  // Midpoint wait station — the back half of the gap the "Next up" train is
  // closing on. Drives the amber map highlight, the HUD readout, and reply text.
  const waitStation = opts.videoStop || gap.midStation || null;

  // Zoom the camera to the trailing ("Next up") train's approach to the wait
  // station: frame on its captured path + the wait station only, leaving the
  // leading train out of the bbox (it can sit miles off near a terminal) so the
  // train stays large while the gap dash runs off-frame toward it. Without this
  // the bbox spanned both trains and showed the whole line. Matches cta-insights
  // src/map/train/gaps.js computeTrainGapVideoView.
  const trailingPath = enriched
    .filter((t) => String(t.trainId) === String(trailingId))
    .map((t) => ({ lat: t.lat, lon: t.lon }));
  const framePoints = [
    ...trailingPath,
    ...(Number.isFinite(waitStation?.lat) ? [waitStation] : []),
  ];
  // Dash the gap stretch (same framing as the still) so the timelapse reads as a
  // hole in service the flanking trains are moving around. Base map fetched once.
  const view = gapViewFor(line, gap, { framePoints });
  const baseMap = await fetchBaseMap(view);
  const highlightStop = waitStation
    ? { lat: waitStation.lat, lon: waitStation.lon, name: waitStation.name }
    : null;

  const { frames, times, startTs, videoEndTs } = buildSmoothFrames(snapshots, {
    idOf: (t) => t.trainId,
    trackOf: (t) => t.distFt,
    pointAlong: (track) => pointAlongShape(line, track),
  });
  const totalSec = Math.max(1, (videoEndTs - startTs) / 1000);
  const gapMin = Math.round(gap.gapMin);
  // The trailing train's distance to the wait station, per frame, for the HUD.
  // Falls back to its last-observed distFt when no interpolated track is present.
  const trailingDeltaAt = (frame) => {
    if (!waitStation) return null;
    const t = frame.find((f) => String(f.trainId) === String(trailingId));
    const dist = t ? (t.track ?? t.distFt) : null;
    return dist == null ? null : waitStation.distFt - dist;
  };

  const images = [];
  for (let i = 0; i < frames.length; i++) {
    const byId = new Map(frames[i].map((t) => [String(t.trainId), t]));
    const delta = trailingDeltaAt(frames[i]);
    images.push(
      await renderRailFrame(
        view,
        baseMap,
        [
          { ...(byId.get(String(trailingId)) || gap.trailing), role: 'N' },
          { ...(byId.get(String(leadingId)) || gap.leading), role: 'L' },
        ],
        {
          clock: { elapsedSec: (times[i] - startTs) / 1000, totalSec },
          highlightStop,
          readout: delta == null ? null : gapReadout(gapMin, waitStation.name || null, delta),
        },
      ),
    );
  }
  const buffer = await encodeFrames(images, { prefix: 'marta-rail-gap' });
  if (!buffer) return null;

  const endDelta = trailingDeltaAt(frames.at(-1));
  return {
    buffer,
    elapsedSec: Math.round((snapshots.at(-1).ts - snapshots[0].ts) / 1000),
    frameCount: frames.length,
    gapMin,
    stationName: waitStation?.name || null,
    endDistFt: endDelta == null ? null : Math.round(Math.max(0, endDelta)),
    reached: endDelta != null && endDelta <= ARRIVED_FT,
  };
}

module.exports = {
  VIDEO_WINDOW_MS,
  ARRIVED_FT,
  gapReadout,
  captureRailBunchingHistoryVideo,
  captureRailGapHistoryVideo,
};
