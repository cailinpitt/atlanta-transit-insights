const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CHAIN_WINDOW_MS,
  routesOverlap,
  alertEndTs,
  alertsChainable,
  isAllClearText,
} = require('../../src/marta/alert/chain');

test('routesOverlap: normalized route match; empty lists are agency-wide', () => {
  assert.equal(routesOverlap(['Gold'], ['GOLD']), true);
  assert.equal(routesOverlap(['RED'], ['GOLD']), false);
  assert.equal(routesOverlap([], []), true, 'two agency-wide notices overlap');
  assert.equal(routesOverlap([], ['RED']), false, 'agency-wide does not absorb a line');
});

test('alertEndTs: resolved > last_seen > first_seen', () => {
  assert.equal(alertEndTs({ first_seen_ts: 1, last_seen_ts: 5, resolved_ts: 9 }), 9);
  assert.equal(alertEndTs({ first_seen_ts: 1, last_seen_ts: 5, resolved_ts: null }), 5);
  assert.equal(alertEndTs({ first_seen_ts: 1 }), 1);
});

test('alertsChainable: chains a near-term continuation on the same line', () => {
  const prev = { mode: 'rail', routes: ['GOLD'], first_seen_ts: 0, resolved_ts: 1_000_000 };
  const within = { mode: 'rail', routes: ['Gold'], first_seen_ts: 1_000_000 + 3 * 60_000 };
  const beyond = { mode: 'rail', routes: ['Gold'], first_seen_ts: 1_000_000 + 3 * 60 * 60_000 };
  assert.equal(alertsChainable(prev, within), true);
  assert.equal(alertsChainable(prev, beyond), false);
});

test('alertsChainable: different mode or line never chains', () => {
  const prev = { mode: 'rail', routes: ['GOLD'], first_seen_ts: 0, resolved_ts: 100 };
  assert.equal(alertsChainable(prev, { mode: 'bus', routes: ['GOLD'], first_seen_ts: 200 }), false);
  assert.equal(alertsChainable(prev, { mode: 'rail', routes: ['RED'], first_seen_ts: 200 }), false);
});

test('alertsChainable: a stale active alert (old last_seen) does not absorb later alerts', () => {
  // resolved_ts null but last_seen long ago → not open-ended.
  const stale = {
    mode: 'streetcar',
    routes: ['ATLSC'],
    first_seen_ts: 0,
    last_seen_ts: 0,
    resolved_ts: null,
  };
  const later = {
    mode: 'streetcar',
    routes: ['ATLSC'],
    first_seen_ts: CHAIN_WINDOW_MS + 60_000,
  };
  assert.equal(alertsChainable(stale, later), false);
  // But a freshly-seen active alert does chain a near-term follow-up.
  const fresh = { ...stale, last_seen_ts: CHAIN_WINDOW_MS };
  assert.equal(alertsChainable(fresh, later), true);
});

test('isAllClearText: recognizes resumed/cleared/normal, not "continuing"', () => {
  assert.equal(isAllClearText('Update: Streetcars resumed normal schedule.'), true);
  assert.equal(isAllClearText('Update: Delay clearing on the Gold line.'), true);
  assert.equal(isAllClearText('Service has been resolved.'), true);
  assert.equal(isAllClearText('Update: delays continuing with Gold line service.'), false);
  assert.equal(isAllClearText(null, undefined), false);
});
