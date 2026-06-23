// MARTA rail schedule adherence — turns the rail feed's signed DELAY field
// (stored as rail_observations.delay_sec, "T-21S" = 21s early, "T249S" = 249s
// late) into a per-line "how late are trains running right now" summary.
//
// Unlike bus adherence (which has to back out lateness from arrival predictions,
// and is contaminated by recycled trip ids — see the deferred bus work), rail
// gives us a clean per-train delay straight from the feed. Pure functions; the
// bin wires them to storage + posting.
//
// Descriptive only — minutes late is data, not a grade. The bin stays silent
// unless lateness is material, so on a normal (on-time) day nothing posts.

// A train counts as "late" at this delay. 5 min mirrors the rail gap/pulse sense
// of a felt delay and keeps sub-minute schedule noise out of the count.
const LATE_THRESHOLD_SEC = 300;

function median(nums) {
  if (!nums || nums.length === 0) return null;
  const v = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Rider-facing phrase for a signed delay in seconds. Rounds to the minute once
// past a minute; sub-minute reads "on time".
function delayLabel(sec) {
  if (sec == null) return 'unknown';
  if (Math.abs(sec) < 60) return 'on time';
  const min = Math.round(Math.abs(sec) / 60);
  return sec > 0 ? `${min} min late` : `${min} min early`;
}

// Latest delay per distinct train over the observation set (the feed repeats a
// train across snapshots; we want its current delay). `observations` rows carry
// { trainId, line, delaySec, ts }. Rows without a finite delay are skipped.
function latestDelayByTrain(observations) {
  const latest = new Map();
  for (const o of observations || []) {
    if (o.trainId == null || !o.line) continue;
    if (!Number.isFinite(o.delaySec)) continue;
    const prev = latest.get(o.trainId);
    if (!prev || o.ts > prev.ts)
      latest.set(o.trainId, { line: o.line, delaySec: o.delaySec, ts: o.ts });
  }
  return latest;
}

// Per-line adherence over the window: distinct-train count, median + peak delay,
// and how many trains are late past the threshold. Sorted most-delayed first
// (median, then peak). Lines with no trains are omitted.
function summarizeLineAdherence(observations) {
  const byLine = new Map();
  for (const { line, delaySec } of latestDelayByTrain(observations).values()) {
    const rec = byLine.get(line) || { line, delays: [] };
    rec.delays.push(delaySec);
    byLine.set(line, rec);
  }
  const out = [];
  for (const { line, delays } of byLine.values()) {
    out.push({
      line,
      trains: delays.length,
      medianDelaySec: median(delays),
      maxDelaySec: Math.max(...delays),
      lateCount: delays.filter((d) => d >= LATE_THRESHOLD_SEC).length,
    });
  }
  out.sort((a, b) => b.medianDelaySec - a.medianDelaySec || b.maxDelaySec - a.maxDelaySec);
  return out;
}

// Per-train schedule deviation in MINUTES (+late / −early), keyed by trainId, for
// the post builders' adherence annotations ("#1234 (1️⃣, 3 min late)"). Derived
// from the same clean feed delay as the rollup. Pass to buildBunchingPostText /
// buildGapPostText / the cross-line post via opts.deviations / leadingDev /
// trailingDev. The bus analog has to project position onto the schedule; rail
// gets it for free from the feed's signed delay.
function railDeviationsByTrain(observations) {
  const out = new Map();
  for (const [trainId, { delaySec }] of latestDelayByTrain(observations)) {
    out.set(trainId, delaySec / 60);
  }
  return out;
}

module.exports = {
  LATE_THRESHOLD_SEC,
  median,
  delayLabel,
  latestDelayByTrain,
  railDeviationsByTrain,
  summarizeLineAdherence,
};
