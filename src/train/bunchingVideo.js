const Fs = require('fs-extra');
const Os = require('node:os');
const Path = require('node:path');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');

const { getAllTrainPositions } = require('./api');
const { assignTrainNumbers } = require('./bunching');
const {
  computeTrainBunchingView,
  fetchTrainBunchingBaseMap,
  renderTrainBunchingFrame,
} = require('../map');
const { haversineFt } = require('../shared/geo');
const { smoothSeries } = require('../shared/stats');
const { buildLinePolyline, snapToLine, pointAlongLine, inLoopTrunk } = require('./speedmap');
const { buildVehicleSeries, vehicleStateAt, realTerminalEnds } = require('../shared/videoTracks');

const execP = promisify(exec);

const DEFAULT_TICK_MS = 15_000;
const DEFAULT_TICKS = 40; // 10 min of real time
const DEFAULT_INTERPOLATE = 4;
const DEFAULT_FRAMERATE = 16;
// Dropout handling (bridge short gaps, ghost long/tail drops, terminal
// turnarounds) lives in the shared `videoTracks` kernel so the snapshot video
// and the frontend replay behave identically.

// CTA occasionally returns a single-tick GPS teleport (~0.5–1 mi off-route
// and back). At ~15 s tick spacing, anything past this caps real train motion
// (top speed ~70 mph = ~1540 ft / 15 s). The bound is generous on purpose —
// real express stretches can clear ~1500 ft/tick — but cleanly rejects the
// multi-thousand-foot jumps we see in the wild.
const MAX_TRACK_STEP_FT = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Polyline orientation isn't fixed per line — for some lines/branches the
// train's destination is at trackDist=0, for others at the max. We infer
// "forward" from the series' net travel, reject single-tick teleports, and
// clamp monotonic in the forward direction. A non-decreasing clamp alone
// (the prior implementation) silently accepted a glitched step in the
// polyline-forward direction even when the train was physically moving the
// other way — a single CTA GPS spike then froze the train at the bogus
// position for the remainder of the video.
function clampTrackSeries(rawSeries) {
  if (rawSeries.length === 0) return [];
  const first = rawSeries[0];
  const last = rawSeries[rawSeries.length - 1];
  const forward = last >= first ? 1 : -1;
  let prev = null;
  return rawSeries.map((raw) => {
    if (prev == null) {
      prev = raw;
      return raw;
    }
    if (Math.abs(raw - prev) > MAX_TRACK_STEP_FT) return prev;
    if ((raw - prev) * forward < 0) return prev;
    prev = raw;
    return raw;
  });
}

function trainsSpanFt(trains, linePts, lineCum) {
  if (trains.length < 2) return null;
  if (linePts && linePts.length >= 2) {
    const dists = trains.map((t) => snapToLine(t.lat, t.lon, linePts, lineCum));
    return Math.round(Math.max(...dists) - Math.min(...dists));
  }
  // No polyline → farthest haversine pair.
  let max = 0;
  for (let i = 0; i < trains.length; i++) {
    for (let j = i + 1; j < trains.length; j++) {
      const d = haversineFt(trains[i], trains[j]);
      if (d > max) max = d;
    }
  }
  return Math.round(max);
}

// Real-time window covered by a comet trail; converted to a frame count via the
// per-frame real-time spacing (tickMs / interpolate).
const TRAIL_MS = 75_000;

// Attach a comet trail (recent positions, oldest → newest) to each non-parked
// train in every frame, spanning up to `trailFrames` of prior frames. Pure;
// mutates frame train objects by setting `.trail`. Turnaround (parked) markers
// are skipped. Exported for testing.
function attachTrails(trainFrames, trailFrames) {
  for (let i = 0; i < trainFrames.length; i++) {
    for (const t of trainFrames[i]) {
      if (t.turnaround) continue;
      const start = Math.max(0, i - trailFrames);
      const trail = [];
      for (let j = start; j <= i; j++) {
        const prev = trainFrames[j].find((x) => x.rn === t.rn && !x.turnaround);
        if (prev) trail.push({ lat: prev.lat, lon: prev.lon });
      }
      if (trail.length >= 2) t.trail = trail;
    }
  }
}

async function captureTrainBunchingVideo(bunch, lineColors, trainLines, stations, opts = {}) {
  const tickMs = opts.tickMs || DEFAULT_TICK_MS;
  const ticks = opts.ticks || DEFAULT_TICKS;
  const framerate = opts.framerate || DEFAULT_FRAMERATE;
  const interpolate = Math.max(1, opts.interpolate || DEFAULT_INTERPOLATE);

  const bunchRns = new Set(bunch.trains.map((t) => t.rn));
  const snapshots = [{ ts: Date.now(), trains: bunch.trains }];

  for (let i = 1; i < ticks; i++) {
    await sleep(tickMs);
    let trains = [];
    try {
      const all = await getAllTrainPositions([bunch.line], { includeApprox: true });
      trains = all.filter((t) => t.line === bunch.line && bunchRns.has(t.rn));
    } catch (e) {
      console.warn(`train video capture tick ${i}: fetch failed — ${e.message}`);
      continue;
    }
    if (trains.length === 0) {
      console.log(`train video capture: all bunched trains dropped at tick ${i}, stopping`);
      break;
    }
    snapshots.push({ ts: Date.now(), trains });
  }

  if (snapshots.length < 2) return null;

  return renderTrainBunchingClip(snapshots, bunch, lineColors, trainLines, stations, {
    tickMs,
    interpolate,
    framerate,
  });
}

// Assemble and encode the clip from captured (or reconstructed) snapshots.
// Split from captureTrainBunchingVideo so it can be driven with historical data.
async function renderTrainBunchingClip(
  snapshots,
  bunch,
  lineColors,
  trainLines,
  stations,
  opts = {},
) {
  const tickMs = opts.tickMs || DEFAULT_TICK_MS;
  const interpolate = Math.max(1, opts.interpolate || DEFAULT_INTERPOLATE);
  const framerate = opts.framerate || DEFAULT_FRAMERATE;

  if (snapshots.length < 2) return null;

  // Per-rn cleanup: snap to polyline → reject teleports → clamp toward
  // destination → smooth. Removes lateral jitter and backward GPS/prediction
  // swaps that would flip adjacent trains' apparent order.
  const { points: linePts, cumDist: lineCum } = buildLinePolyline(trainLines, bunch.line);
  const hasPolyline = linePts.length >= 2;
  if (hasPolyline) {
    const seriesByRn = new Map();
    for (const snap of snapshots) {
      for (const t of snap.trains) {
        const raw = snapToLine(t.lat, t.lon, linePts, lineCum);
        if (!seriesByRn.has(t.rn)) seriesByRn.set(t.rn, []);
        seriesByRn.get(t.rn).push({ t, raw });
      }
    }
    for (const series of seriesByRn.values()) {
      const clamped = clampTrackSeries(series.map((s) => s.raw));
      const smoothed = smoothSeries(clamped);
      for (let i = 0; i < series.length; i++) {
        const { t } = series[i];
        t.track = smoothed[i];
        const snapped = pointAlongLine(linePts, lineCum, t.track);
        if (snapped) {
          t.lat = snapped.lat;
          t.lon = snapped.lon;
        }
      }
    }
  }

  const extraTrains = snapshots.slice(1).flatMap((s) => s.trains);
  const view = computeTrainBunchingView(bunch, lineColors, trainLines, stations, extraTrains);
  const baseMap = await fetchTrainBunchingBaseMap(view);

  // Stable identity for every bunched train, shared across all frames.
  const labels = assignTrainNumbers(bunch.trains);

  // Frame assembly via the shared dropout kernel: bridge short feed gaps, fade
  // a ghost across long/un-bridgeable gaps, dead-reckon tail drops, and play a
  // turnaround glyph at real terminals — so a train the feed briefly drops mid-
  // clip never hard-disappears and pops back in (the old loop only handled
  // trains missing from the *final* snapshot).
  const trainFrames = [];
  const frameTimes = []; // parallel to trainFrames: real ts of each frame
  const videoEndTs = snapshots[snapshots.length - 1].ts;
  const pointAlong = hasPolyline ? (track) => pointAlongLine(linePts, lineCum, track) : null;
  const ends = hasPolyline ? realTerminalEnds(linePts, inLoopTrunk) : [];
  const seriesByRn = buildVehicleSeries(snapshots, { trackOf: (t) => t.track ?? null });
  let anyGhost = false;

  const pushFrame = (frameTs) => {
    const frame = [];
    for (const series of seriesByRn.values()) {
      const st = vehicleStateAt(series, frameTs, {
        pointAlong,
        realTerminalEnds: ends,
        videoEndTs,
      });
      if (!st) continue;
      if (st.ghost) anyGhost = true;
      frame.push(st);
    }
    trainFrames.push(frame);
    frameTimes.push(frameTs);
  };

  for (let i = 0; i < snapshots.length - 1; i++) {
    const span = snapshots[i + 1].ts - snapshots[i].ts;
    for (let k = 0; k < interpolate; k++) pushFrame(snapshots[i].ts + (span * k) / interpolate);
  }
  pushFrame(videoEndTs);

  // Comet trails: recent path behind each moving train (~TRAIL_MS of real time).
  const trailFrames = Math.max(2, Math.round(TRAIL_MS / (tickMs / interpolate)));
  attachTrails(trainFrames, trailFrames);

  const clipStartTs = snapshots[0].ts;
  const totalSec = Math.max(1, (videoEndTs - clipStartTs) / 1000);

  const tmpDir = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'cta-train-video-'));
  try {
    for (let i = 0; i < trainFrames.length; i++) {
      const buf = await renderTrainBunchingFrame(view, baseMap, trainFrames[i], {
        showGhostLegend: anyGhost,
        labels,
        clock: { elapsedSec: (frameTimes[i] - clipStartTs) / 1000, totalSec },
      });
      const framePath = Path.join(tmpDir, `frame_${String(i).padStart(3, '0')}.jpg`);
      await Fs.writeFile(framePath, buf);
    }
    const holdFrames = framerate;
    const lastIdx = trainFrames.length - 1;
    const lastPath = Path.join(tmpDir, `frame_${String(lastIdx).padStart(3, '0')}.jpg`);
    for (let k = 1; k <= holdFrames; k++) {
      const dst = Path.join(tmpDir, `frame_${String(lastIdx + k).padStart(3, '0')}.jpg`);
      await Fs.copyFile(lastPath, dst);
    }

    const outPath = Path.join(tmpDir, 'out.mp4');
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

    const initialDistFt = Math.round(bunch.spanFt);
    const finalDistFt = trainsSpanFt(snapshots[snapshots.length - 1].trains, linePts, lineCum);
    const elapsedSec = Math.round((snapshots[snapshots.length - 1].ts - snapshots[0].ts) / 1000);

    return {
      buffer,
      ticksCaptured: snapshots.length,
      elapsedSec,
      initialDistFt,
      finalDistFt,
      hadGhosts: anyGhost,
    };
  } finally {
    await Fs.remove(tmpDir).catch(() => {});
  }
}

module.exports = {
  captureTrainBunchingVideo,
  renderTrainBunchingClip,
  clampTrackSeries,
  MAX_TRACK_STEP_FT,
  attachTrails,
};
