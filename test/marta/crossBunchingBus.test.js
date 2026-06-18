const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectCrossRouteBunches,
  groupByRoute,
  isAtTerminal,
  LAYOVER_TERMINAL_FT,
} = require('../../src/marta/bus/crossBunching');

const NOW = Date.UTC(2026, 5, 17, 16, 0, 0);
const FT_PER_MILLIDEG_LAT = 364;
const dLatForFt = (ft) => ft / FT_PER_MILLIDEG_LAT / 1000;
const at = (vehicleId, route, ft, extra = {}) => ({
  vehicleId,
  route,
  lat: 33.75 + dLatForFt(ft),
  lon: -84.39,
  tmstmp: NOW,
  ...extra,
});

test('detects a multi-route pileup (2 routes, 3 buses)', () => {
  const vs = [at('a', '110', 0), at('b', '110', 200), at('c', '816', 400)];
  const [bunch] = detectCrossRouteBunches(vs, { now: NOW });
  assert.equal(bunch.vehicles.length, 3);
  assert.deepEqual(bunch.routes, ['110', '816']);
});

test('ignores a single-route cluster', () => {
  const vs = [at('a', '110', 0), at('b', '110', 200), at('c', '110', 400)];
  assert.equal(detectCrossRouteBunches(vs, { now: NOW }).length, 0);
});

test('congestion gate drops/keeps by stopped count', () => {
  const vs = [at('a', '110', 0), at('b', '816', 200), at('c', '102', 400)];
  assert.equal(detectCrossRouteBunches(vs, { now: NOW, stoppedIds: new Set(['a']) }).length, 0);
  assert.equal(
    detectCrossRouteBunches(vs, { now: NOW, stoppedIds: new Set(['a', 'b']) }).length,
    1,
  );
});

test('drops stale fixes', () => {
  const vs = [
    at('a', '110', 0),
    at('b', '816', 200),
    at('c', '102', 400, { tmstmp: NOW - 5 * 60 * 1000 }),
  ];
  assert.equal(detectCrossRouteBunches(vs, { now: NOW }).length, 0);
});

test('layoverIds buses are dropped before clustering', () => {
  // 3 buses / 2 routes would normally post; but a + c are laying over → dissolves.
  const vs = [at('a', '110', 0), at('b', '816', 200), at('c', '102', 400)];
  assert.equal(
    detectCrossRouteBunches(vs, { now: NOW, layoverIds: new Set(['a', 'c']) }).length,
    0,
  );
  // A real through-bus (d) joining two layover buses still doesn't reach 2 routes.
  const vs2 = [at('a', '110', 0), at('b', '110', 100), at('c', '816', 200), at('d', '816', 300)];
  // Drop the two #816 layover buses → only #110 left → single-route → no post.
  assert.equal(
    detectCrossRouteBunches(vs2, { now: NOW, layoverIds: new Set(['c', 'd']) }).length,
    0,
  );
  // Without the layover tag the same set posts.
  assert.equal(detectCrossRouteBunches(vs2, { now: NOW }).length, 1);
});

test('isAtTerminal flags positions within margin of either shape end', () => {
  const len = 10000;
  assert.equal(isAtTerminal(100, len), true); // near start
  assert.equal(isAtTerminal(len - 100, len), true); // near end
  assert.equal(isAtTerminal(5000, len), false); // mid-route
  assert.equal(isAtTerminal(LAYOVER_TERMINAL_FT + 1, len), false); // just past the start zone
  assert.equal(isAtTerminal(NaN, len), false);
  assert.equal(isAtTerminal(100, 0), false); // degenerate shape
});

test('groupByRoute numbers buses across routes, biggest group first', () => {
  const vs = [at('a', '110', 0), at('b', '816', 200), at('c', '816', 400)];
  const [bunch] = detectCrossRouteBunches(vs, { now: NOW });
  const { byRoute, labels } = groupByRoute(bunch);
  assert.equal(byRoute[0].route, '816');
  assert.equal(labels.size, 3);
});
