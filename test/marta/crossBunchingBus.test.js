const test = require('node:test');
const assert = require('node:assert/strict');
const { detectCrossRouteBunches, groupByRoute } = require('../../src/marta/bus/crossBunching');

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

test('groupByRoute numbers buses across routes, biggest group first', () => {
  const vs = [at('a', '110', 0), at('b', '816', 200), at('c', '816', 400)];
  const [bunch] = detectCrossRouteBunches(vs, { now: NOW });
  const { byRoute, labels } = groupByRoute(bunch);
  assert.equal(byRoute[0].route, '816');
  assert.equal(labels.size, 3);
});
