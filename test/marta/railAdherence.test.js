const test = require('node:test');
const assert = require('node:assert/strict');
const {
  delayLabel,
  latestDelayByTrain,
  railDeviationsByTrain,
  summarizeLineAdherence,
  median,
  LATE_THRESHOLD_SEC,
} = require('../../src/marta/rail/adherence');

test('delayLabel reads late, early, and on-time', () => {
  assert.equal(delayLabel(0), 'on time');
  assert.equal(delayLabel(40), 'on time'); // sub-minute
  assert.equal(delayLabel(140), '2 min late');
  assert.equal(delayLabel(-130), '2 min early');
  assert.equal(delayLabel(null), 'unknown');
});

test('median handles even and odd lengths', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test('latestDelayByTrain keeps the newest observation per train and skips bad rows', () => {
  const obs = [
    { trainId: 'A', line: 'RED', delaySec: 60, ts: 1 },
    { trainId: 'A', line: 'RED', delaySec: 240, ts: 5 }, // newer wins
    { trainId: 'B', line: 'RED', delaySec: 0, ts: 3 },
    { trainId: 'C', line: 'GOLD', delaySec: null, ts: 4 }, // no delay → skipped
    { trainId: null, line: 'RED', delaySec: 10, ts: 6 }, // no id → skipped
  ];
  const latest = latestDelayByTrain(obs);
  assert.equal(latest.get('A').delaySec, 240);
  assert.equal(latest.get('B').delaySec, 0);
  assert.equal(latest.has('C'), false);
  assert.equal(latest.size, 2);
});

test('summarizeLineAdherence rolls up per line, most-delayed first', () => {
  const obs = [
    // RED: two trains, one 6 min late (counts as late), median 195s
    { trainId: 'R1', line: 'RED', delaySec: 360, ts: 1 },
    { trainId: 'R2', line: 'RED', delaySec: 30, ts: 1 },
    // GOLD: one train on time
    { trainId: 'G1', line: 'GOLD', delaySec: 20, ts: 1 },
  ];
  const out = summarizeLineAdherence(obs);
  assert.equal(out[0].line, 'RED', 'most-delayed line sorts first');
  assert.equal(out[0].trains, 2);
  assert.equal(out[0].medianDelaySec, 195);
  assert.equal(out[0].maxDelaySec, 360);
  assert.equal(out[0].lateCount, 1, 'one RED train past the late threshold');
  assert.equal(out[1].line, 'GOLD');
  assert.equal(out[1].lateCount, 0);
});

test('LATE_THRESHOLD_SEC is the documented 5 minutes', () => {
  assert.equal(LATE_THRESHOLD_SEC, 300);
});

test('railDeviationsByTrain returns latest delay per train in minutes', () => {
  const obs = [
    { trainId: 'A', line: 'RED', delaySec: 60, ts: 1 },
    { trainId: 'A', line: 'RED', delaySec: 300, ts: 5 }, // newer wins → 5 min
    { trainId: 'B', line: 'GOLD', delaySec: -120, ts: 2 }, // 2 min early
  ];
  const devs = railDeviationsByTrain(obs);
  assert.equal(devs.get('A'), 5);
  assert.equal(devs.get('B'), -2);
});

// The bin guards runBin behind require.main, so importing it for the gate helpers
// is safe (it doesn't post on import — feedback_never_require_bins).
const bin = require('../../bin/marta/rail/adherence');

test('qualifies gates on min trains, median, or late-train count', () => {
  // On-time line: enough trains but median + late count both under bar → no post.
  assert.equal(
    bin.qualifies({ trains: 5, medianDelaySec: 40, maxDelaySec: 120, lateCount: 0 }),
    false,
  );
  // Too few trains to trust even a high median.
  assert.equal(
    bin.qualifies({ trains: 2, medianDelaySec: 600, maxDelaySec: 700, lateCount: 2 }),
    false,
  );
  // Material median lateness.
  assert.equal(
    bin.qualifies({ trains: 4, medianDelaySec: 200, maxDelaySec: 400, lateCount: 1 }),
    true,
  );
  // Median fine but several trains badly late.
  assert.equal(
    bin.qualifies({ trains: 6, medianDelaySec: 60, maxDelaySec: 600, lateCount: 2 }),
    true,
  );
});

test('formatLine reads a rider-facing per-line summary', () => {
  const s = bin.formatLine({
    line: 'RED',
    trains: 4,
    medianDelaySec: 200,
    maxDelaySec: 400,
    lateCount: 2,
  });
  assert.match(s, /Red Line/);
  assert.match(s, /median/);
  assert.match(s, /peak/);
  assert.match(s, /2 trains 5\+ min late/);
});
