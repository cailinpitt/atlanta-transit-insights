// Smooth vehicle motion for the MARTA timelapses. The observe loop records a
// position every ~30s, so playing one frame per observation looks choppy — each
// vehicle jumps a block at a time. This wraps the shared dropout/interpolation
// kernel (src/shared/videoTracks.js, also used by the CTA videos) to generate
// `interpolate` evenly spaced in-between frames per observation gap, gliding each
// vehicle ALONG its route (via pointAlong) rather than cutting corners with a
// straight lat/lon lerp. Pure: returns an array of frames, each an array of
// render objects ({ ...payload, lat, lon, opacity, ghost }).
const { buildVehicleSeries, vehicleStateAt } = require('../../shared/videoTracks');

const DEFAULT_INTERPOLATE = 4;

// `snapshots`: [{ ts, vehicles: [...] }] sorted by ts.
//   idOf(v)     → stable id (trainId / vehicleId)
//   trackOf(v)  → along-route distance (distFt), or null to lerp lat/lon
//   pointAlong(track) → { lat, lon } on the route, or null
//   tailFadeMs  → optional; fade dropped vehicles fully over this window
function buildSmoothFrames(snapshots, opts = {}) {
  if (!snapshots || snapshots.length < 2) return [];
  const {
    idOf,
    trackOf = () => null,
    pointAlong = null,
    interpolate = DEFAULT_INTERPOLATE,
    tailFadeMs = null,
  } = opts;
  const steps = Math.max(1, interpolate);

  const series = buildVehicleSeries(snapshots, {
    itemsOf: (s) => s.vehicles,
    idOf,
    trackOf,
  });
  const videoEndTs = snapshots[snapshots.length - 1].ts;

  const frames = [];
  const pushFrame = (frameTs) => {
    const frame = [];
    for (const s of series.values()) {
      const st = vehicleStateAt(s, frameTs, {
        pointAlong,
        realTerminalEnds: [],
        videoEndTs,
        tailFadeMs,
      });
      if (st) frame.push(st);
    }
    frames.push(frame);
  };

  for (let i = 0; i < snapshots.length - 1; i++) {
    const span = snapshots[i + 1].ts - snapshots[i].ts;
    for (let k = 0; k < steps; k++) pushFrame(snapshots[i].ts + (span * k) / steps);
  }
  pushFrame(videoEndTs);
  return frames;
}

// Group enriched observation rows (each with a `ts`) into snapshots sorted by ts.
function snapshotsByTimestamp(rows) {
  const byTs = new Map();
  for (const row of rows) {
    if (!byTs.has(row.ts)) byTs.set(row.ts, []);
    byTs.get(row.ts).push(row);
  }
  return [...byTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, vehicles]) => ({ ts, vehicles }));
}

module.exports = { buildSmoothFrames, snapshotsByTimestamp, DEFAULT_INTERPOLATE };
