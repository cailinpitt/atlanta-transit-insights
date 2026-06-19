// Detects dead segments on a MARTA rail line: stretches of track where no
// train has appeared recently enough that something is probably wrong. Pure
// function — no DB writes; persistence/cooldown gating lives in the bin script.
//
// This is the MARTA port of cta-insights src/train/pulse.js. MARTA rail is far
// simpler than CTA: four plain point-to-point lines (RED/GOLD = N/S, BLUE/GREEN
// = E/W), ONE representative geometry per line (the longest GTFS shape — see
// src/marta/rail/lines.js), and a true stable TRAIN_ID. So the CTA branch/Loop/
// Express machinery collapses to: project every train onto the single line
// geometry and scan once PER FEED DIRECTION, filtering observations by the feed's
// N/S/E/W DIRECTION field (the analog of CTA's trDr code).
//
// Each direction is binned by along-track distance; a bin is "cold" when no
// train going that direction has projected into it within max(2.5× headway,
// 15 min) — the multiplier opens the threshold up during sparse off-peak service
// while the floor keeps peak detection from getting jumpy (verbatim CTA values).
//
// A candidate is admitted via any of three paths (composite gate):
//   passLong  — run length ≥ 2 mi (sparse outer-stretch fallback)
//   passMulti — ≥ 2 stations completely inside the cold run
//   passSolo  — ≥ 1 station + ≥3 expected-but-missed trains + ≥3.5× headway
//               cold time (excludes held-train false positives)
// Returns { skipped, candidates } so the bin can distinguish "no signal" (don't
// touch existing pulse_state) from "all clear" (advance clear ticks).

const { projectToShape } = require('../bus/shapes');
const { terminalZoneFt } = require('../../shared/geo');
const { MAX_OFFROUTE_FT } = require('./lines');

const MAX_PERP_FT = MAX_OFFROUTE_FT; // reject off-route projections (1000 ft — Five Points slack)
const DEFAULT_LOOKBACK_MS = 20 * 60 * 1000;
const DEFAULT_BIN_FT = 1320; // 0.25 mi
const DEFAULT_MIN_RUN_FT_LONG = 10560; // 2 mi — sparse outer-stretch fallback
const DEFAULT_MIN_COLD_MS = 15 * 60 * 1000;
// Multipliers on scheduled headway (verbatim CTA). The headway-driven threshold
// scales the detector with service density: peak service clamps at the 15-min
// floor, sparse off-peak / late-night opens the threshold up.
const COLD_HEADWAY_MULT = 2.5;
const COLD_HEADWAY_MULT_STRICT = 3.5;
const DEFAULT_MIN_COVERAGE_FRAC = 0.5;
const DEFAULT_MIN_SPAN_FRAC = 0.5;
// Expected-but-missed trains required for the 1-station passSolo admit path.
// Three in a row going missing isn't normal variance.
const SOLO_EXPECTED_TRAINS = 3;

// Concrete-onset recovery. A cold run is only detected once it's *already* been
// cold a while, so the last train through it frequently predates the detection
// lookback — leaving lastSeenInRunMs null and the published onset floored to the
// cold threshold (a lower bound, not a measurement). We hold a wider 2h slice
// (longLookbackPositions) so we can pin a concrete start by scanning it for the
// most recent train actually inside the stretch. Two guards keep it honest:
//   - ONSET_WIDEN_CAP_MS: never back-date onset more than 2h.
//   - ONSET_SERVICE_GAP_MS: a ≥30-min line-wide silence after the run's last
//     train marks a scheduled break (overnight) — clamp onset to when line-wide
//     service resumed instead of pinning it to last night's train.
const ONSET_WIDEN_CAP_MS = 2 * 60 * 60 * 1000;
const ONSET_SERVICE_GAP_MS = 30 * 60 * 1000;

// Feed-coverage guard window/threshold. When the upstream rail feed / observe
// loop stalls, every train stops reporting at once and absence of an observation
// no longer means absence of a train. detectFeedGap inspects the GLOBAL snapshot
// timestamps over the recent window and reports the largest stretch with no
// snapshot (counting leading + trailing edges, so a gap that has scrolled to the
// window start still poisons a detector whose lookback reaches into it).
const FEED_GAP_LOOKBACK_MS = 30 * 60 * 1000;
const FEED_GAP_MS = 5 * 60 * 1000;

// Project a position onto the line geometry. Returns { along, perp } (ft) or
// null if the geometry is unusable.
function projectPos(geom, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const p = projectToShape(geom, lat, lon);
  if (!p) return null;
  return { along: p.distFt, perp: p.offsetFt };
}

// Most recent moment a direction-matched train was actually inside
// [runLoFt, runHiFt] within the 2h cap, guarded against crossing a line-wide
// service break. `positions` is the 2h slice ({ts, lat, lon, direction}).
// Returns a ts (ms), or null when the stretch has been cold longer than the cap.
function recoverConcreteOnset({ positions, geom, directionFilter, runLoFt, runHiFt, now }) {
  const floorTs = now - ONSET_WIDEN_CAP_MS;
  let lastInRun = -Infinity;
  const lineTs = [];
  for (const p of positions) {
    if (p.ts < floorTs) continue;
    lineTs.push(p.ts);
    if (directionFilter && p.direction !== directionFilter) continue;
    const proj = projectPos(geom, p.lat, p.lon);
    if (!proj || proj.perp > MAX_PERP_FT) continue;
    if (proj.along >= runLoFt && proj.along <= runHiFt && p.ts > lastInRun) lastInRun = p.ts;
  }
  if (lastInRun === -Infinity) return null;
  lineTs.sort((a, b) => a - b);
  let resumedTs = null;
  for (let i = 1; i < lineTs.length; i++) {
    if (lineTs[i] - lineTs[i - 1] >= ONSET_SERVICE_GAP_MS && lineTs[i] > lastInRun) {
      resumedTs = lineTs[i];
    }
  }
  return resumedTs != null ? Math.max(lastInRun, resumedTs) : lastInRun;
}

function detectFeedGap({
  positions,
  now,
  lookbackMs = FEED_GAP_LOOKBACK_MS,
  maxGapMs = FEED_GAP_MS,
}) {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const since = nowMs - lookbackMs;
  const tsList = [
    ...new Set(positions.map((p) => p.ts).filter((t) => t >= since && t <= nowMs)),
  ].sort((a, b) => a - b);
  if (tsList.length === 0) return { gap: true, maxGapMs: lookbackMs };
  let maxGap = Math.max(tsList[0] - since, nowMs - tsList[tsList.length - 1]);
  for (let i = 1; i < tsList.length; i++) {
    const g = tsList[i] - tsList[i - 1];
    if (g > maxGap) maxGap = g;
  }
  return { gap: maxGap >= maxGapMs, maxGapMs: maxGap };
}

// Project each roster station that serves `line` onto the geometry. `stations`
// are rail-stations.json entries ({ name, lat, lon, lines: ['red',...] }) whose
// line keys are lowercase, while the feed/geometry line is 'RED' — compare
// case-insensitively. Returns sorted [{ station, trackDist }].
function stationsAlongLine(stations, line, geom) {
  const key = String(line).toLowerCase();
  const out = [];
  for (const s of stations || []) {
    if (!s.lines?.some((l) => String(l).toLowerCase() === key)) continue;
    const proj = projectPos(geom, s.lat, s.lon);
    if (!proj || proj.perp > MAX_PERP_FT) continue;
    out.push({ station: s, trackDist: proj.along });
  }
  out.sort((a, b) => a.trackDist - b.trackDist);
  return out;
}

// Net along-track displacement sign for a direction's trains over the window —
// +1 if they tend to move toward increasing distFt, -1 toward decreasing, 0 when
// indeterminate. The single line geometry has an arbitrary orientation, so we
// learn each feed direction's flow empirically (used by the ramp-up veto).
function flowSignFor(positions, geom, directionFilter) {
  const first = new Map();
  const last = new Map();
  for (const p of positions) {
    if (directionFilter && p.direction !== directionFilter) continue;
    if (p.trainId == null) continue;
    const proj = projectPos(geom, p.lat, p.lon);
    if (!proj || proj.perp > MAX_PERP_FT) continue;
    const f = first.get(p.trainId);
    if (!f || p.ts < f.ts) first.set(p.trainId, { ts: p.ts, along: proj.along });
    const l = last.get(p.trainId);
    if (!l || p.ts > l.ts) last.set(p.trainId, { ts: p.ts, along: proj.along });
  }
  let net = 0;
  for (const [id, f] of first) {
    const l = last.get(id);
    if (!l || l.ts === f.ts) continue;
    net += l.along - f.along;
  }
  return net > 0 ? 1 : net < 0 ? -1 : 0;
}

function detectDeadSegments({ line, geom, stations, headwayMin, now, opts = {} }) {
  if (!geom?.points?.length || !geom.lengthFt) {
    return { skipped: 'no-geometry', candidates: [] };
  }
  const lookbackMs = opts.lookbackMs || DEFAULT_LOOKBACK_MS;
  const binFt = opts.binFt || DEFAULT_BIN_FT;
  const minRunFtLong = opts.minRunFt || DEFAULT_MIN_RUN_FT_LONG;
  const minCoverageFrac =
    opts.minCoverageFrac != null ? opts.minCoverageFrac : DEFAULT_MIN_COVERAGE_FRAC;
  const minSpanFrac = opts.minSpanFrac != null ? opts.minSpanFrac : DEFAULT_MIN_SPAN_FRAC;
  const coldThresholdMs = Math.max(
    DEFAULT_MIN_COLD_MS,
    headwayMin != null ? COLD_HEADWAY_MULT * headwayMin * 60 * 1000 : DEFAULT_MIN_COLD_MS,
  );
  const coldThresholdMsStrict = Math.max(
    DEFAULT_MIN_COLD_MS,
    headwayMin != null ? COLD_HEADWAY_MULT_STRICT * headwayMin * 60 * 1000 : DEFAULT_MIN_COLD_MS,
  );

  const totalFt = geom.lengthFt;
  const recent = opts.recentPositions || [];
  const sinceTs = now - lookbackMs;
  const fresh = recent.filter((p) => p.ts >= sinceTs);
  if (fresh.length === 0) return { skipped: 'noobs', candidates: [] };

  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const p of fresh) {
    if (p.ts < minTs) minTs = p.ts;
    if (p.ts > maxTs) maxTs = p.ts;
  }
  if (maxTs - minTs < lookbackMs * minSpanFrac) {
    return { skipped: 'sparse-span', candidates: [] };
  }

  // Scan once per feed direction present in the window (the two directions the
  // line runs — RED/GOLD N/S, BLUE/GREEN E/W). A fully-dark direction has no obs
  // here and is left to the synthetic full-line path in the bin.
  const directions = [...new Set(fresh.map((p) => p.direction).filter(Boolean))].sort();

  const longRecent = opts.longLookbackPositions || [];
  const numBins = Math.max(2, Math.ceil(totalFt / binFt));
  const binLengthFt = totalFt / numBins;
  const zoneFt = terminalZoneFt(totalFt);
  const zoneBins = Math.ceil(zoneFt / binLengthFt);

  const candidates = [];
  let allDirectionsSparse = true;

  for (const direction of directions) {
    const lastSeenPerBin = new Array(numBins).fill(-Infinity);
    // Per-train trajectories, used to detect trains that crossed the cold run
    // between snapshots (fast traversal) and to infer a held train whose GPS
    // went silent mid-segment.
    const trajById = new Map();
    const runsOnLine = new Set();
    const binIdxOfRun = [];

    for (const p of fresh) {
      if (p.direction !== direction) continue;
      const proj = projectPos(geom, p.lat, p.lon);
      if (!proj || proj.perp > MAX_PERP_FT) continue;
      const idx = Math.min(numBins - 1, Math.max(0, Math.floor(proj.along / binLengthFt)));
      if (p.ts > lastSeenPerBin[idx]) lastSeenPerBin[idx] = p.ts;
      if (p.trainId != null) {
        runsOnLine.add(p.trainId);
        binIdxOfRun.push({ id: p.trainId, idx });
        let traj = trajById.get(p.trainId);
        if (!traj) {
          traj = [];
          trajById.set(p.trainId, traj);
        }
        traj.push({ ts: p.ts, along: proj.along });
      }
    }

    // Active-service-range clip. Project this direction's recent obs and take
    // the [min, max] along-track span; bins outside it aren't part of current
    // service and are skipped. Pinned ranges (from an open pulse_state run)
    // expand the active range so a long sustained outage doesn't self-mask once
    // the active range shrinks past the formerly-active stretch.
    const activeRangeWindowMs =
      opts.activeRangeWindowMs != null
        ? opts.activeRangeWindowMs
        : Math.max(20 * 60 * 1000, headwayMin != null ? headwayMin * 1.5 * 60 * 1000 : 0);
    const activeRangeSinceTs = now - activeRangeWindowMs;
    let activeLo = Infinity;
    let activeHi = -Infinity;
    for (const p of fresh) {
      if (p.ts < activeRangeSinceTs) continue;
      if (p.direction !== direction) continue;
      const proj = projectPos(geom, p.lat, p.lon);
      if (!proj || proj.perp > MAX_PERP_FT) continue;
      if (proj.along < activeLo) activeLo = proj.along;
      if (proj.along > activeHi) activeHi = proj.along;
    }
    if (opts.pinnedRanges) {
      const pin =
        opts.pinnedRanges instanceof Map
          ? opts.pinnedRanges.get(direction)
          : opts.pinnedRanges[direction];
      if (pin && Number.isFinite(pin.lo) && Number.isFinite(pin.hi)) {
        if (pin.lo < activeLo) activeLo = pin.lo;
        if (pin.hi > activeHi) activeHi = pin.hi;
      }
    }
    let corridorLo = 0;
    let corridorHi = numBins;
    if (Number.isFinite(activeLo) && Number.isFinite(activeHi) && activeHi > activeLo) {
      corridorLo = Math.max(0, Math.floor(activeLo / binLengthFt));
      corridorHi = Math.min(numBins, Math.ceil(activeHi / binLengthFt));
    }

    let coveredBins = 0;
    let corridorBinCount = 0;
    for (let i = 0; i < numBins; i++) {
      if (i < corridorLo || i >= corridorHi) continue;
      corridorBinCount++;
      if (lastSeenPerBin[i] > -Infinity) coveredBins++;
    }
    if (corridorBinCount > 0 && coveredBins / corridorBinCount < minCoverageFrac) continue;
    allDirectionsSparse = false;

    const coldBefore = now - coldThresholdMs;
    const cold = lastSeenPerBin.map((ts) => ts < coldBefore);

    let bestStart = -1;
    let bestEnd = -1;
    let curStart = -1;
    const scanStart = Math.max(zoneBins, corridorLo);
    const scanEnd = Math.min(numBins - zoneBins, corridorHi);
    for (let i = scanStart; i < scanEnd; i++) {
      if (cold[i]) {
        if (curStart < 0) curStart = i;
        const curEnd = i;
        if (bestEnd - bestStart < curEnd - curStart) {
          bestStart = curStart;
          bestEnd = curEnd;
        }
      } else {
        curStart = -1;
      }
    }
    if (bestStart < 0) continue;

    const runLoFt = bestStart * binLengthFt;
    const runHiFt = (bestEnd + 1) * binLengthFt;
    const runLengthFt = runHiFt - runLoFt;

    const stationsOnLine = stationsAlongLine(stations, line, geom);
    const stationsInRun = stationsOnLine.filter(
      (s) => s.trackDist >= runLoFt && s.trackDist <= runHiFt,
    );
    if (stationsInRun.length < 1) continue;
    const fromStation = stationsInRun[0];
    const toStation = stationsInRun[stationsInRun.length - 1];
    // A run resolving to a single station (or two with the same name) can't be
    // described as "X to Y" or rendered as a segment — skip rather than emit a
    // degenerate candidate.
    if (fromStation.station.name === toStation.station.name) continue;

    // Ramp-up veto: the day's first direction-matching train may simply not have
    // reached this stretch yet. The 20-min lookback can't tell that from a real
    // outage; a 2h lookback can. The "near edge" of the run (the side trains
    // enter from) depends on this direction's empirical flow.
    if (longRecent.length > 0) {
      const flow = flowSignFor(longRecent, geom, direction);
      if (flow !== 0) {
        let maxAlong = -Infinity;
        let minAlong = Infinity;
        for (const p of longRecent) {
          if (p.direction !== direction) continue;
          const proj = projectPos(geom, p.lat, p.lon);
          if (!proj || proj.perp > MAX_PERP_FT) continue;
          if (proj.along > maxAlong) maxAlong = proj.along;
          if (proj.along < minAlong) minAlong = proj.along;
        }
        const flowIncreasing = flow > 0;
        const reachedNearEdge = flowIncreasing ? maxAlong >= runLoFt : minAlong <= runHiFt;
        if (!reachedNearEdge) continue;
      }
    }

    // Fast-traversal veto: did any train's consecutive obs bracket the cold run?
    // If so it physically crossed between snapshots — not an outage.
    let crossed = false;
    for (const traj of trajById.values()) {
      if (traj.length < 2) continue;
      traj.sort((a, b) => a.ts - b.ts);
      for (let i = 1; i < traj.length; i++) {
        const a = traj[i - 1].along;
        const b = traj[i].along;
        if ((a < runLoFt && b > runHiFt) || (a > runHiFt && b < runLoFt)) {
          crossed = true;
          break;
        }
      }
      if (crossed) break;
    }
    if (crossed) continue;

    let lastSeenInRun = -Infinity;
    for (let i = bestStart; i <= bestEnd; i++) {
      if (lastSeenPerBin[i] > lastSeenInRun) lastSeenInRun = lastSeenPerBin[i];
    }
    const runsInRun = new Set();
    for (const { id, idx } of binIdxOfRun) {
      if (idx >= bestStart && idx <= bestEnd) runsInRun.add(id);
    }
    let trainsOutsideRun = 0;
    for (const id of runsOnLine) if (!runsInRun.has(id)) trainsOutsideRun++;

    const lastSeenInRunMs = lastSeenInRun > -Infinity ? lastSeenInRun : null;
    const coldMs = lastSeenInRunMs ? now - lastSeenInRunMs : lookbackMs;
    let onsetTs = lastSeenInRunMs;
    if (lastSeenInRunMs == null && longRecent.length) {
      onsetTs = recoverConcreteOnset({
        positions: longRecent,
        geom,
        directionFilter: direction,
        runLoFt,
        runHiFt,
        now,
      });
    }
    const expectedTrains = headwayMin ? Math.floor(coldMs / 60_000 / headwayMin) : null;
    const coldStations = stationsInRun.length;
    const coldStationNames = stationsInRun.map((s) => s.station.name);

    // Terminal-adjacency margin. A cold run sitting at the corridor's terminal-
    // most station with coldMs barely clearing threshold is usually a single
    // missed turnaround on a sparse line, not a real outage. Require 1.2× margin
    // unless the run is long.
    let terminalAdjacent = false;
    if (stationsOnLine.length >= 2) {
      const corridorLoFt = corridorLo * binLengthFt;
      const corridorHiFt = corridorHi * binLengthFt;
      const corridorTerminalDistFt = 2640; // 0.5 mi
      const inCorridor = stationsOnLine.filter(
        (s) => s.trackDist >= corridorLoFt && s.trackDist <= corridorHiFt,
      );
      if (inCorridor.length >= 2) {
        const west = inCorridor[0];
        const east = inCorridor[inCorridor.length - 1];
        const fromAdj =
          Math.abs(fromStation.trackDist - west.trackDist) <= corridorTerminalDistFt ||
          Math.abs(fromStation.trackDist - east.trackDist) <= corridorTerminalDistFt;
        const toAdj =
          Math.abs(toStation.trackDist - west.trackDist) <= corridorTerminalDistFt ||
          Math.abs(toStation.trackDist - east.trackDist) <= corridorTerminalDistFt;
        terminalAdjacent = fromAdj || toAdj;
      }
    }

    // Composite admit gate: any one path suffices. Every path requires
    // coldMs >= coldThresholdMs so a 2-mi cold run at 1× scheduled headway
    // (natural bunching variance) can't auto-admit.
    const passLong = runLengthFt >= minRunFtLong && coldMs >= coldThresholdMs;
    const passMulti = coldStations >= 2 && coldMs >= coldThresholdMs;
    const passSolo =
      coldStations >= 1 &&
      expectedTrains != null &&
      expectedTrains >= SOLO_EXPECTED_TRAINS &&
      coldMs >= coldThresholdMsStrict;
    if (!(passLong || passMulti || passSolo)) continue;

    if (terminalAdjacent && !passLong && coldMs < 1.2 * coldThresholdMs) continue;

    // Dispatch-continuity veto: if the schedule says a trip should have started
    // in the window AND coldMs is within 1.5× threshold AND it's not a long
    // sustained outage, treat as a between-dispatch gap.
    if (
      opts.expectedDispatchesInWindow != null &&
      opts.expectedDispatchesInWindow >= 1 &&
      !passLong &&
      coldMs < 1.5 * coldThresholdMs
    ) {
      continue;
    }

    // Inferred-held reclassification. The dominant real-world held failure is
    // "trains held in place, then GPS goes silent" — exactly what trips the cold
    // detector. If any train's trajectory ENDS inside this cold run with low
    // displacement over its tail, relabel the candidate as `held` so the post
    // says trains are stuck rather than missing.
    const INFERRED_TAIL_MS = 10 * 60 * 1000;
    const INFERRED_STATIONARY_FT = 500;
    const INFERRED_MIN_TAIL_SPAN_MS = 5 * 60 * 1000;
    let inferredHeld = null;
    for (const [id, traj] of trajById) {
      if (traj.length < 2) continue;
      const sorted = [...traj].sort((a, b) => a.ts - b.ts);
      const last = sorted[sorted.length - 1];
      if (last.along < runLoFt || last.along > runHiFt) continue;
      const tail = sorted.filter((p) => last.ts - p.ts <= INFERRED_TAIL_MS);
      if (tail.length < 2) continue;
      let minA = Infinity;
      let maxA = -Infinity;
      for (const p of tail) {
        if (p.along < minA) minA = p.along;
        if (p.along > maxA) maxA = p.along;
      }
      const tailSpanMs = last.ts - tail[0].ts;
      if (maxA - minA <= INFERRED_STATIONARY_FT && tailSpanMs >= INFERRED_MIN_TAIL_SPAN_MS) {
        if (
          !inferredHeld ||
          tailSpanMs > inferredHeld.stationaryMs ||
          (tailSpanMs === inferredHeld.stationaryMs && last.ts > inferredHeld.lastSeenTs)
        ) {
          inferredHeld = { id, stationaryMs: tailSpanMs, lastSeenTs: last.ts };
        }
      }
    }

    const candidate = {
      line,
      direction,
      runLoFt,
      runHiFt,
      runLengthFt,
      fromStation: fromStation.station,
      toStation: toStation.station,
      coldBins: bestEnd - bestStart + 1,
      totalBins: numBins,
      observedTrainsInWindow: runsOnLine.size,
      lastSeenInRunMs,
      onsetTs,
      coldThresholdMs,
      lookbackMs,
      trainsOutsideRun,
      coldStations,
      coldStationNames,
      expectedTrains,
      headwayMin: headwayMin != null ? headwayMin : null,
    };
    if (inferredHeld) {
      candidate.kind = 'held';
      candidate.heldEvidence = {
        inferredFromCold: true,
        trainCount: 1,
        stationaryMs: inferredHeld.stationaryMs,
        trainIds: [inferredHeld.id],
        lastSeenTs: inferredHeld.lastSeenTs,
      };
    }
    candidates.push(candidate);
  }

  if (allDirectionsSparse && candidates.length === 0 && directions.length > 0) {
    return { skipped: 'sparse-coverage', candidates: [] };
  }
  candidates.sort((a, b) => {
    if (b.coldStations !== a.coldStations) return b.coldStations - a.coldStations;
    return b.runLengthFt - a.runLengthFt;
  });
  return { skipped: null, candidates };
}

module.exports = {
  detectDeadSegments,
  detectFeedGap,
  recoverConcreteOnset,
  stationsAlongLine,
  flowSignFor,
  ONSET_WIDEN_CAP_MS,
  FEED_GAP_LOOKBACK_MS,
  FEED_GAP_MS,
  DEFAULT_LOOKBACK_MS,
  DEFAULT_BIN_FT,
  DEFAULT_MIN_RUN_FT_LONG,
  DEFAULT_MIN_COVERAGE_FRAC,
  DEFAULT_MIN_SPAN_FRAC,
  COLD_HEADWAY_MULT,
  COLD_HEADWAY_MULT_STRICT,
  SOLO_EXPECTED_TRAINS,
  MAX_PERP_FT,
};
