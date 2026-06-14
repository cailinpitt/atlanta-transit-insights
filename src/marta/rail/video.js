const { projectTrain } = require('./lines');
const { viewFor, fetchBaseMap, renderRailFrame } = require('../map/railIncidents');
const { encodeFrames } = require('../shared/video');

const VIDEO_WINDOW_MS = 10 * 60 * 1000;

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

function framesByTimestamp(rows) {
  const byTs = new Map();
  for (const row of rows) {
    if (!byTs.has(row.ts)) byTs.set(row.ts, []);
    byTs.get(row.ts).push(row);
  }
  return [...byTs.entries()].sort((a, b) => a[0] - b[0]);
}

async function captureRailBunchingHistoryVideo(bunch, line, rows, opts = {}) {
  const ids = bunch.trains.map((t) => t.trainId);
  const enriched = enrichRows(rows, {
    lineGeom: opts.lineGeom,
    line: bunch.line,
    direction: bunch.direction,
    trainIds: ids,
  });
  const frames = framesByTimestamp(enriched).filter(([, trains]) => trains.length > 0);
  if (frames.length < 2) return null;

  const lo = Math.min(...enriched.map((t) => t.distFt)) - 3500;
  const hi = Math.max(...enriched.map((t) => t.distFt)) + 3500;
  const view = viewFor(line, enriched, { loFt: lo, hiFt: hi });
  const baseMap = await fetchBaseMap(view);
  const images = [];
  for (const [, trains] of frames) {
    images.push(await renderRailFrame(view, baseMap, trains, { labels: opts.labels }));
  }
  const buffer = await encodeFrames(images, { prefix: 'marta-rail-bunching' });
  if (!buffer) return null;
  return {
    buffer,
    elapsedSec: Math.round((frames.at(-1)[0] - frames[0][0]) / 1000),
    frameCount: frames.length,
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
  const frames = framesByTimestamp(enriched).filter(([, trains]) => trains.length > 0);
  if (frames.length < 2) return null;

  const lo = Math.min(...enriched.map((t) => t.distFt)) - 3500;
  const hi = Math.max(...enriched.map((t) => t.distFt)) + 3500;
  const view = viewFor(line, enriched, { loFt: lo, hiFt: hi });
  const baseMap = await fetchBaseMap(view);
  const images = [];
  for (const [, trains] of frames) {
    const byId = new Map(trains.map((t) => [String(t.trainId), t]));
    images.push(
      await renderRailFrame(view, baseMap, [
        { ...(byId.get(String(trailingId)) || gap.trailing), role: 'N' },
        { ...(byId.get(String(leadingId)) || gap.leading), role: 'L' },
      ]),
    );
  }
  const buffer = await encodeFrames(images, { prefix: 'marta-rail-gap' });
  if (!buffer) return null;
  return {
    buffer,
    elapsedSec: Math.round((frames.at(-1)[0] - frames[0][0]) / 1000),
    frameCount: frames.length,
  };
}

module.exports = {
  VIDEO_WINDOW_MS,
  captureRailBunchingHistoryVideo,
  captureRailGapHistoryVideo,
};
