const Fs = require('fs-extra');
const Os = require('node:os');
const Path = require('node:path');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');

const { getVehicles } = require('./api');
const { assignBusNumbers } = require('./bunching');
const { computeBunchingView, fetchBunchingBaseMap, renderBunchingFrame } = require('../map');
const { cumulativeDistances, haversineFt } = require('../shared/geo');

const TURNAROUND_NEAR_TERMINAL_FT = 1320; // ~0.25 mi
// Glide a turned-around bus to the terminus over this many frames, then park
// the U-turn glyph there for the rest of the clip. Frames-based (not a fixed
// real-time window) because frames are ~tickMs/interpolate of real time apart,
// so a fixed-ms window compresses to ~1 frame at playback speed.
const TURNAROUND_GLIDE_FRAMES = 2;
const { smoothSeries } = require('../shared/stats');
const { snapToLine, pointAlongLine } = require('../train/speedmap');
const { buildVehicleSeries, vehicleStateAt } = require('../shared/videoTracks');

const execP = promisify(exec);

const DEFAULT_TICK_MS = 15_000;
const DEFAULT_TICKS = 40; // 10 min of real time
const DEFAULT_INTERPOLATE = 4; // turns 16 real samples → 61 smoothed frames
const DEFAULT_FRAMERATE = 16; // ~4s clip at 16× speed
// CTA's getvehicles can briefly drop a vehicle (GPS loss, prediction
// suppression near terminals, single missed poll). For tail drops (vehicle
// never reappears) we render a fading gray ghost dead-reckoned along the
// polyline at last-known speed for the rest of the clip rather than letting
// the marker vanish mid-frame.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function captureBunchingVideo(bunch, pattern, opts = {}) {
  const tickMs = opts.tickMs || DEFAULT_TICK_MS;
  const ticks = opts.ticks || DEFAULT_TICKS;
  const framerate = opts.framerate || DEFAULT_FRAMERATE;
  const interpolate = Math.max(1, opts.interpolate || DEFAULT_INTERPOLATE);
  const signals = opts.signals || [];
  const stops = opts.stops || [];

  const bunchVids = new Set(bunch.vehicles.map((v) => v.vid));
  const snapshots = [{ ts: Date.now(), vehicles: bunch.vehicles }];
  // vid → first sighting under a different pid. A bunched vid that reappears on
  // another pid has turned around at a terminal (CTA reassigns the trip), not
  // lost signal — the renderer uses this to show a turnaround, not a ghost.
  const turnedAround = new Map();

  for (let i = 1; i < ticks; i++) {
    await sleep(tickMs);
    let vehicles = [];
    const tickTs = Date.now();
    try {
      const all = await getVehicles([bunch.route], { record: false });
      for (const v of all) {
        if (
          bunchVids.has(v.vid) &&
          v.pid != null &&
          v.pid !== bunch.pid &&
          !turnedAround.has(v.vid)
        ) {
          turnedAround.set(v.vid, { ts: tickTs, vehicle: v });
        }
      }
      vehicles = all.filter((v) => v.pid === bunch.pid && bunchVids.has(v.vid));
    } catch (e) {
      console.warn(`video capture tick ${i}: fetch failed — ${e.message}`);
      continue;
    }
    if (vehicles.length === 0) {
      console.log(`video capture: all bunched buses dropped at tick ${i}, stopping`);
      break;
    }
    snapshots.push({ ts: tickTs, vehicles });
  }

  if (snapshots.length < 2) return null;

  return renderBunchingClip(snapshots, bunch, pattern, {
    tickMs,
    interpolate,
    framerate,
    signals,
    stops,
    turnedAround,
  });
}

// Attach a comet trail (recent positions, oldest → newest) to each non-parked
// vehicle in every frame, spanning up to `trailFrames` of prior frames. Pure;
// mutates frame vehicle objects by setting `.trail`. Turnaround (parked)
// markers are skipped. Exported for testing.
function attachTrails(vehicleFrames, trailFrames) {
  for (let i = 0; i < vehicleFrames.length; i++) {
    for (const veh of vehicleFrames[i]) {
      if (veh.turnaround) continue;
      const start = Math.max(0, i - trailFrames);
      const trail = [];
      for (let j = start; j <= i; j++) {
        const prev = vehicleFrames[j].find((x) => x.vid === veh.vid && !x.turnaround);
        if (prev) trail.push({ lat: prev.lat, lon: prev.lon });
      }
      if (trail.length >= 2) veh.trail = trail;
    }
  }
}

// Real-time window covered by a comet trail. Converted to a frame count via the
// per-frame real-time spacing (tickMs / interpolate).
const TRAIL_MS = 75_000;

// Assemble and encode the clip from captured (or reconstructed) snapshots.
// Split from captureBunchingVideo so it can be driven with historical data.
async function renderBunchingClip(snapshots, bunch, pattern, opts = {}) {
  const tickMs = opts.tickMs || DEFAULT_TICK_MS;
  const interpolate = Math.max(1, opts.interpolate || DEFAULT_INTERPOLATE);
  const framerate = opts.framerate || DEFAULT_FRAMERATE;
  const signals = opts.signals || [];
  const stops = opts.stops || [];
  const turnedAround = opts.turnedAround || new Map();

  if (snapshots.length < 2) return null;

  // Stable identity for every bunched bus, shared across all frames.
  const labels = assignBusNumbers(bunch.vehicles);

  // Per-vid cleanup: snap to polyline → clamp non-decreasing → smooth.
  // Removes lateral GPS jitter and backward jumps (prediction/GPS swaps).
  const linePts = pattern.points.map((p) => [p.lat, p.lon]);
  const lineCum = cumulativeDistances(pattern.points);
  const hasPolyline = linePts.length >= 2;
  if (hasPolyline) {
    const seriesByVid = new Map(); // vid → [{ v, raw }]
    for (const snap of snapshots) {
      for (const v of snap.vehicles) {
        const raw = snapToLine(v.lat, v.lon, linePts, lineCum);
        if (!seriesByVid.has(v.vid)) seriesByVid.set(v.vid, []);
        seriesByVid.get(v.vid).push({ v, raw });
      }
    }
    for (const series of seriesByVid.values()) {
      let prev = null;
      const clamped = series.map(({ raw }) => {
        const next = prev == null ? raw : Math.max(prev, raw);
        prev = next;
        return next;
      });
      const smoothed = smoothSeries(clamped);
      for (let i = 0; i < series.length; i++) {
        const { v } = series[i];
        v.track = smoothed[i];
        const snapped = pointAlongLine(linePts, lineCum, v.track);
        if (snapped) {
          v.lat = snapped.lat;
          v.lon = snapped.lon;
        }
      }
    }
  }

  const extraVehicles = snapshots.slice(1).flatMap((s) => s.vehicles);
  const view = computeBunchingView(bunch, pattern, extraVehicles);
  const baseMap = await fetchBunchingBaseMap(view);

  // Frame assembly via the shared dropout kernel (`src/shared/videoTracks.js`,
  // the same model the train videos + frontend replay use): bridge short feed
  // gaps (≤ 8 min, dimmed), ghost long/un-bridgeable ones, dead-reckon tail
  // drops, and play a turnaround glyph at a terminal. This replaces the old
  // uncapped fillInteriorGaps + bespoke tail-ghost loop.
  const lastSnapIdx = snapshots.length - 1;
  const videoEndTs = snapshots[lastSnapIdx].ts;
  const pointAlong = hasPolyline ? (track) => pointAlongLine(linePts, lineCum, track) : null;
  const kSeries = buildVehicleSeries(snapshots, {
    itemsOf: (s) => s.vehicles,
    idOf: (v) => v.vid,
    trackOf: (v) => v.track ?? null,
  });

  // Per-vid turnaround terminus for tail drops. Bus polylines are end-to-end
  // (no Loop round-trip), so both endpoints are real terminals. A vid that
  // reappeared under a different pid has *provably* turned around (CTA reassigns
  // the trip before the bus crawls the final layover), so force the nearer end
  // regardless of proximity; otherwise fall back to the proximity test.
  const finalByVid = new Map(snapshots[lastSnapIdx].vehicles.map((v) => [v.vid, v]));
  const ends = hasPolyline
    ? [
        { lat: pattern.points[0].lat, lon: pattern.points[0].lon },
        {
          lat: pattern.points[pattern.points.length - 1].lat,
          lon: pattern.points[pattern.points.length - 1].lon,
        },
      ]
    : [];
  const turnaroundEndByVid = new Map();
  if (hasPolyline) {
    for (const [vid, series] of kSeries) {
      if (finalByVid.has(vid)) continue; // present at the end → not a tail drop
      const last = series[series.length - 1];
      let bestEnd = null;
      let bestD = Number.POSITIVE_INFINITY;
      for (const end of ends) {
        const d = haversineFt({ lat: last.lat, lon: last.lon }, end);
        if (d < bestD) {
          bestD = d;
          bestEnd = end;
        }
      }
      if (turnedAround.has(vid) || bestD <= TURNAROUND_NEAR_TERMINAL_FT) {
        turnaroundEndByVid.set(vid, bestEnd);
      }
    }
  }

  // Bus turnaround glide is frames-based (a fixed-ms window compresses to ~1
  // frame at playback speed) and parks the U-turn glyph rather than fading it.
  const turnaroundGlideMs = TURNAROUND_GLIDE_FRAMES * (tickMs / interpolate);
  const vehicleFrames = [];
  const frameTimes = []; // parallel to vehicleFrames: real ts of each frame
  let anyGhost = false;

  const pushFrame = (frameTs) => {
    const vehicles = [];
    // kSeries iteration order is stable across frames (same Map), so
    // separateMarkers gets consistent input order each tick.
    for (const [vid, series] of kSeries) {
      const st = vehicleStateAt(series, frameTs, {
        pointAlong,
        turnaroundEnd: turnaroundEndByVid.get(vid) ?? null,
        turnaroundPark: true,
        turnaroundGlideMs,
        videoEndTs,
      });
      if (!st) continue;
      if (st.ghost) anyGhost = true;
      vehicles.push(st);
    }
    vehicleFrames.push(vehicles);
    frameTimes.push(frameTs);
  };

  for (let i = 0; i < snapshots.length - 1; i++) {
    const span = snapshots[i + 1].ts - snapshots[i].ts;
    for (let k = 0; k < interpolate; k++) pushFrame(snapshots[i].ts + (span * k) / interpolate);
  }
  pushFrame(videoEndTs);

  // Comet trails: recent path behind each moving bus (~TRAIL_MS of real time).
  const trailFrames = Math.max(2, Math.round(TRAIL_MS / (tickMs / interpolate)));
  attachTrails(vehicleFrames, trailFrames);

  const clipStartTs = snapshots[0].ts;
  const totalSec = Math.max(1, (videoEndTs - clipStartTs) / 1000);

  const tmpDir = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'cta-bunch-video-'));
  try {
    for (let i = 0; i < vehicleFrames.length; i++) {
      const buf = await renderBunchingFrame(view, baseMap, vehicleFrames[i], signals, stops, {
        compactStops: true,
        compactSignals: true,
        showGhostLegend: anyGhost,
        labels,
        clock: { elapsedSec: (frameTimes[i] - clipStartTs) / 1000, totalSec },
      });
      const framePath = Path.join(tmpDir, `frame_${String(i).padStart(3, '0')}.jpg`);
      await Fs.writeFile(framePath, buf);
    }

    // ~1s hold on the last frame so viewers can read the final state before loop.
    const holdFrames = framerate;
    const lastIdx = vehicleFrames.length - 1;
    const lastPath = Path.join(tmpDir, `frame_${String(lastIdx).padStart(3, '0')}.jpg`);
    for (let k = 1; k <= holdFrames; k++) {
      const dst = Path.join(tmpDir, `frame_${String(lastIdx + k).padStart(3, '0')}.jpg`);
      await Fs.copyFile(lastPath, dst);
    }

    const outPath = Path.join(tmpDir, 'out.mp4');
    // yuv420p requires even dims — scale filter is cheap insurance.
    const cmd = [
      'ffmpeg -y -hide_banner -loglevel error',
      `-framerate ${framerate}`,
      `-i "${Path.join(tmpDir, 'frame_%03d.jpg')}"`,
      '-vf "scale=trunc(iw/2)*2:trunc(ih/2)*2"',
      '-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -movflags +faststart',
      `"${outPath}"`,
    ].join(' ');
    await execP(cmd, { timeout: 60_000 });
    const buffer = await Fs.readFile(outPath);

    const initialSpanFt = Math.round(bunch.spanFt);
    const finalVehicles = snapshots[snapshots.length - 1].vehicles;
    const finalPdists = finalVehicles
      .map((v) => v.pdist)
      .filter((p) => typeof p === 'number' || !Number.isNaN(parseFloat(p)))
      .map((p) => parseFloat(p));
    const finalSpanFt =
      finalPdists.length >= 2
        ? Math.round(Math.max(...finalPdists) - Math.min(...finalPdists))
        : null;
    const elapsedSec = Math.round((snapshots[snapshots.length - 1].ts - snapshots[0].ts) / 1000);

    return {
      buffer,
      ticksCaptured: snapshots.length,
      elapsedSec,
      initialSpanFt,
      finalSpanFt,
      hadGhosts: anyGhost,
    };
  } finally {
    await Fs.remove(tmpDir).catch(() => {});
  }
}

module.exports = {
  captureBunchingVideo,
  renderBunchingClip,
  attachTrails,
};
