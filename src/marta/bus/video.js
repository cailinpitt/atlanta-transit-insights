const { projectObservation, pointAlongShape } = require('./shapes');
const { assignBusNumbers } = require('./bunching');
const { TYPICAL_SPEED_FT_PER_MIN } = require('./gaps');
const {
  computeBunchingView,
  fetchBunchingBaseMap,
  renderBunchingFrame,
} = require('../map/busBunching');
const { computeGapView, fetchGapBaseMap, renderGapFrame } = require('../map/busGap');
const { encodeFrames } = require('../shared/video');
const { buildSmoothFrames, snapshotsByTimestamp } = require('../shared/smoothFrames');

const VIDEO_WINDOW_MS = 10 * 60 * 1000;
// Within this distance the "Next up" bus counts as having reached the midpoint
// wait stop; outside it the readout/reply report the remaining distance.
const ARRIVED_FT = 400;

// Pick the stop nearest the gap *midpoint* — the back half the "Next up" bus
// must still cross, which is what the timelapse frames it closing on. Returns
// the stop object ({ stopName, distFt, lat, lon }) or null.
function midpointStop(gap, stops = []) {
  const candidates = (stops || []).filter((s) => Number.isFinite(s.distFt));
  if (candidates.length === 0) return null;
  const midDistFt = (gap.leading.distFt + gap.trailing.distFt) / 2;
  return candidates.reduce((best, s) =>
    Math.abs(s.distFt - midDistFt) < Math.abs(best.distFt - midDistFt) ? s : best,
  );
}

// One frame's HUD line. `deltaFt` is the signed distance from the "Next up" bus
// to the midpoint wait stop (positive while approaching, ~0 at the stop, negative
// once past) so the label tracks the bus through the stop. Ported from
// cta-insights src/bus/gapVideo.js gapReadout.
function gapReadout(gapMin, stopName, deltaFt) {
  const head = `~${gapMin}-min gap · next bus`;
  if (deltaFt < -ARRIVED_FT) return stopName ? `${head} left ${stopName}` : `${head} has left`;
  if (deltaFt <= ARRIVED_FT) return stopName ? `${head} reaching ${stopName}` : `${head} arriving`;
  const min = Math.max(1, Math.round(deltaFt / TYPICAL_SPEED_FT_PER_MIN));
  return stopName ? `${head} ~${min} min to ${stopName}` : `${head} ~${min} min`;
}

function enrichRows(rows, { gtfs, shapes, shapeId, vehicleIds }) {
  const ids = new Set([...vehicleIds].map(String));
  const out = [];
  for (const row of rows || []) {
    if (!ids.has(String(row.vehicleId))) continue;
    const proj = projectObservation(row, { gtfs, shapes });
    if (!proj || proj.shapeId !== shapeId) continue;
    const trip = gtfs.tripsById.get(row.tripId);
    const route = trip
      ? (gtfs.routesById.get(trip.route_id)?.route_short_name ?? row.route)
      : row.route;
    out.push({
      ...row,
      route,
      shapeId: proj.shapeId,
      distFt: proj.distFt,
      tmstmp: row.ts,
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

async function captureBusBunchingHistoryVideo(bunch, shape, rows, opts = {}) {
  const ids = bunch.vehicles.map((v) => v.vehicleId);
  const enriched = enrichRows(rows, {
    gtfs: opts.gtfs,
    shapes: opts.shapes,
    shapeId: bunch.shapeId,
    vehicleIds: ids,
  });
  const snapshots = snapshotsByTimestamp(enriched).filter((s) => s.vehicles.length > 0);
  if (snapshots.length < 2) return null;

  const extra = enriched.map((v) => ({ lat: v.lat, lon: v.lon, distFt: v.distFt }));
  const view = computeBunchingView(bunch, shape, extra);
  const baseMap = await fetchBunchingBaseMap(view);
  const labels = assignBusNumbers(bunch.vehicles);
  const { frames, times, startTs, videoEndTs } = buildSmoothFrames(snapshots, {
    idOf: (v) => v.vehicleId,
    trackOf: (v) => v.distFt,
    pointAlong: (track) => pointAlongShape(shape, track),
  });
  const totalSec = Math.max(1, (videoEndTs - startTs) / 1000);
  const images = [];
  for (let i = 0; i < frames.length; i++) {
    images.push(
      await renderBunchingFrame(view, baseMap, frames[i], opts.stops || [], {
        labels,
        clock: { elapsedSec: (times[i] - startTs) / 1000, totalSec },
      }),
    );
  }
  const buffer = await encodeFrames(images, { prefix: 'marta-bus-bunching' });
  if (!buffer) return null;
  return {
    buffer,
    elapsedSec: Math.round((snapshots.at(-1).ts - snapshots[0].ts) / 1000),
    frameCount: frames.length,
  };
}

async function captureBusGapHistoryVideo(gap, shape, rows, opts = {}) {
  const leadingId = gap.leading?.vehicleId;
  const trailingId = gap.trailing?.vehicleId;
  if (leadingId == null || trailingId == null) return null;
  const enriched = enrichRows(rows, {
    gtfs: opts.gtfs,
    shapes: opts.shapes,
    shapeId: gap.shapeId,
    vehicleIds: [leadingId, trailingId],
  });
  const snapshots = snapshotsByTimestamp(enriched).filter((s) => s.vehicles.length > 0);
  if (snapshots.length < 2) return null;

  const extra = enriched.map((v) => ({ lat: v.lat, lon: v.lon, distFt: v.distFt }));
  // Midpoint wait stop — the back half of the gap the "Next up" bus is closing
  // on. Drives the amber map highlight, the HUD readout, and the reply text.
  const waitStop = opts.videoStop || midpointStop(gap, opts.stops);
  const view = computeGapView(gap, shape, [...extra, ...(waitStop ? [waitStop] : [])]);
  const baseMap = await fetchGapBaseMap(view);
  const { frames, times, startTs, videoEndTs } = buildSmoothFrames(snapshots, {
    idOf: (v) => v.vehicleId,
    trackOf: (v) => v.distFt,
    pointAlong: (track) => pointAlongShape(shape, track),
  });
  const totalSec = Math.max(1, (videoEndTs - startTs) / 1000);
  const gapMin = Math.round(gap.gapMin);
  const highlightStop = waitStop
    ? { lat: waitStop.lat, lon: waitStop.lon, name: waitStop.stopName }
    : null;
  // The trailing bus's distance to the wait stop, per frame, for the HUD. Falls
  // back to its last-observed distFt when an interpolated track isn't available.
  const trailingDeltaAt = (frame) => {
    if (!waitStop) return null;
    const v = frame.find((f) => String(f.vehicleId) === String(trailingId));
    const dist = v ? (v.track ?? v.distFt) : null;
    return dist == null ? null : waitStop.distFt - dist;
  };

  const images = [];
  for (let i = 0; i < frames.length; i++) {
    const byId = new Map(frames[i].map((v) => [String(v.vehicleId), v]));
    const delta = trailingDeltaAt(frames[i]);
    images.push(
      await renderGapFrame(
        view,
        baseMap,
        {
          ...gap,
          leading: byId.get(String(leadingId)) || gap.leading,
          trailing: byId.get(String(trailingId)) || gap.trailing,
        },
        opts.stops || [],
        {
          clock: { elapsedSec: (times[i] - startTs) / 1000, totalSec },
          highlightStop,
          readout: delta == null ? null : gapReadout(gapMin, waitStop.stopName || null, delta),
        },
      ),
    );
  }
  const buffer = await encodeFrames(images, { prefix: 'marta-bus-gap' });
  if (!buffer) return null;

  const endDelta = trailingDeltaAt(frames.at(-1));
  return {
    buffer,
    elapsedSec: Math.round((snapshots.at(-1).ts - snapshots[0].ts) / 1000),
    frameCount: frames.length,
    gapMin,
    stopName: waitStop?.stopName || null,
    endDistFt: endDelta == null ? null : Math.round(Math.max(0, endDelta)),
    reached: endDelta != null && endDelta <= ARRIVED_FT,
  };
}

module.exports = {
  VIDEO_WINDOW_MS,
  ARRIVED_FT,
  captureBusBunchingHistoryVideo,
  captureBusGapHistoryVideo,
  midpointStop,
  gapReadout,
};
