const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectCrossLineBunches,
  groupByLine,
  isTrainAtTerminal,
} = require('../../src/marta/rail/crossBunching');
const { buildPostText } = require('../../src/marta/rail/crossBunchingPost');

const FT_PER_MILLIDEG_LAT = 364;
const dLatForFt = (ft) => ft / FT_PER_MILLIDEG_LAT / 1000;
// motionSign null = stopped (the congestion signal); 1 = moving.
const at = (trainId, line, ft, motionSign = null) => ({
  trainId,
  line,
  lat: 33.754 + dLatForFt(ft),
  lon: -84.39,
  motionSign,
});

test('detects a multi-line cluster at Five Points (RED + GOLD)', () => {
  const ts = [at('t1', 'RED', 0), at('t2', 'GOLD', 400), at('t3', 'GOLD', 800)];
  const [bunch] = detectCrossLineBunches(ts);
  assert.equal(bunch.trains.length, 3);
  assert.deepEqual(bunch.lines, ['GOLD', 'RED']);
});

test('ignores a single-line cluster', () => {
  const ts = [at('t1', 'RED', 0), at('t2', 'RED', 400), at('t3', 'RED', 800)];
  assert.equal(detectCrossLineBunches(ts).length, 0);
});

test('congestion is intrinsic via motionSign (moving trains do not count)', () => {
  // All moving (motionSign=1) → not a cluster.
  const moving = [at('t1', 'RED', 0, 1), at('t2', 'GOLD', 400, 1), at('t3', 'BLUE', 800, 1)];
  assert.equal(detectCrossLineBunches(moving).length, 0);
  // Two stopped → cluster.
  const stalled = [at('t1', 'RED', 0, null), at('t2', 'GOLD', 400, null), at('t3', 'BLUE', 800, 1)];
  assert.equal(detectCrossLineBunches(stalled).length, 1);
});

test('stoppedIds overrides motionSign for tests', () => {
  const ts = [at('t1', 'RED', 0, 1), at('t2', 'GOLD', 400, 1), at('t3', 'BLUE', 800, 1)];
  assert.equal(detectCrossLineBunches(ts, { stoppedIds: new Set(['t1', 't2']) }).length, 1);
});

test('isTrainAtTerminal flags trains in either end-zone, ignores mid-line', () => {
  const len = 100_000;
  assert.equal(isTrainAtTerminal({ distFt: 200, lengthFt: len }), true); // start turnback
  assert.equal(isTrainAtTerminal({ distFt: len - 200, lengthFt: len }), true); // end turnback
  assert.equal(isTrainAtTerminal({ distFt: 50_000, lengthFt: len }), false); // mid-line
  assert.equal(isTrainAtTerminal({ lat: 1, lon: 1 }), false); // no projection → false
});

test('suppresses a terminal layover knot but keeps a mid-line cluster', () => {
  const len = 100_000;
  // RED + GOLD close together at the southern Airport turnback (distFt ~0) → layover.
  const terminal = [at('t1', 'RED', 0), at('t2', 'GOLD', 400), at('t3', 'GOLD', 800)].map((t) => ({
    ...t,
    distFt: 150,
    lengthFt: len,
  }));
  assert.equal(detectCrossLineBunches(terminal).length, 0);

  // Same cluster mid-line → still a real cluster.
  const midline = terminal.map((t) => ({ ...t, distFt: 50_000 }));
  assert.equal(detectCrossLineBunches(midline).length, 1);

  // excludeTerminal:false restores the old whole-network behavior.
  assert.equal(detectCrossLineBunches(terminal, { excludeTerminal: false }).length, 1);
});

test('groupByLine numbers trains across lines, biggest group first', () => {
  const ts = [at('t1', 'RED', 0), at('t2', 'GOLD', 400), at('t3', 'GOLD', 800)];
  const [bunch] = detectCrossLineBunches(ts);
  const { byLine, labels } = groupByLine(bunch);
  assert.equal(byLine[0].line, 'GOLD');
  assert.equal(labels.size, 3);
});

test('cross-line cluster post weaves per-train schedule adherence', () => {
  const ts = [at('t1', 'RED', 0), at('t2', 'GOLD', 400), at('t3', 'GOLD', 800)];
  const [bunch] = detectCrossLineBunches(ts);
  const deviations = new Map([
    ['t1', 4],
    ['t2', 0],
    ['t3', -2],
  ]);
  const text = buildPostText(bunch, { placeName: 'Five Points' }, [], { deviations });
  assert.match(text, /are close together at Five Points right now/);
  assert.match(text, /4 min late/);
  assert.match(text, /on time/);
  assert.match(text, /2 min early/);
});
