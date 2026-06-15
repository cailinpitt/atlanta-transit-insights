const { projectObservation, pointAlongShape } = require('./shapes');
const { assignBusNumbers } = require('./bunching');
const {
  computeBunchingView,
  fetchBunchingBaseMap,
  renderBunchingFrame,
} = require('../map/busBunching');
const { computeGapView, fetchGapBaseMap, renderGapFrame } = require('../map/busGap');
const { encodeFrames } = require('../shared/video');
const { buildSmoothFrames, snapshotsByTimestamp } = require('../shared/smoothFrames');

const VIDEO_WINDOW_MS = 10 * 60 * 1000;

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
  const frames = buildSmoothFrames(snapshots, {
    idOf: (v) => v.vehicleId,
    trackOf: (v) => v.distFt,
    pointAlong: (track) => pointAlongShape(shape, track),
  });
  const images = [];
  for (const vehicles of frames) {
    images.push(await renderBunchingFrame(view, baseMap, vehicles, opts.stops || [], { labels }));
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
  const view = computeGapView(gap, shape, extra);
  const baseMap = await fetchGapBaseMap(view);
  const frames = buildSmoothFrames(snapshots, {
    idOf: (v) => v.vehicleId,
    trackOf: (v) => v.distFt,
    pointAlong: (track) => pointAlongShape(shape, track),
  });
  const images = [];
  for (const vehicles of frames) {
    const byId = new Map(vehicles.map((v) => [String(v.vehicleId), v]));
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
      ),
    );
  }
  const buffer = await encodeFrames(images, { prefix: 'marta-bus-gap' });
  if (!buffer) return null;
  return {
    buffer,
    elapsedSec: Math.round((snapshots.at(-1).ts - snapshots[0].ts) / 1000),
    frameCount: frames.length,
  };
}

module.exports = {
  VIDEO_WINDOW_MS,
  captureBusBunchingHistoryVideo,
  captureBusGapHistoryVideo,
};
