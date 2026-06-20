const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectCancellationSurges,
  CANCEL_ABS_FLOOR,
  CANCEL_FRAC_THRESHOLD,
} = require('../../src/marta/bus/cancellationSurge');

// A fixed schedule lookup keyed by route for these table-driven cases.
const sched = (map) => (route) => (route in map ? map[route] : null);

test('fires only when BOTH the abs floor and the fraction threshold are met', () => {
  const events = detectCancellationSurges({
    perRoute: [
      { route: '49', count: 5 }, // 5/10 = 50% → fires
      { route: '84', count: 3 }, // below abs floor (3 < 4) → no
      { route: '12', count: 5 }, // 5/40 = 12.5% < 25% → no
    ],
    scheduledForRoute: sched({ 49: 10, 84: 6, 12: 40 }),
  });
  assert.deepEqual(
    events.map((e) => e.route),
    ['49'],
  );
  assert.equal(events[0].canceled, 5);
  assert.equal(events[0].scheduled, 10);
  assert.equal(events[0].fraction, 0.5);
  assert.equal(events[0].severity, 0.5);
});

test('the abs floor and fraction threshold match the exported constants', () => {
  // Exactly at the floor and exactly at the fraction → fires (>= on both).
  const scheduled = Math.ceil(CANCEL_ABS_FLOOR / CANCEL_FRAC_THRESHOLD);
  const events = detectCancellationSurges({
    perRoute: [{ route: '49', count: CANCEL_ABS_FLOOR }],
    scheduledForRoute: sched({ 49: scheduled }),
  });
  assert.equal(events.length, 1);
  assert.ok(events[0].fraction >= CANCEL_FRAC_THRESHOLD);
});

test('severity is the share lost, clamped to 1 when cancellations exceed schedule', () => {
  const events = detectCancellationSurges({
    perRoute: [{ route: '49', count: 20 }], // 20/10 = 200%
    scheduledForRoute: sched({ 49: 10 }),
  });
  assert.equal(events[0].fraction, 2);
  assert.equal(events[0].severity, 1);
});

test('drops routes with no schedule and the unrouted bucket; reports reasons', () => {
  const drops = [];
  const events = detectCancellationSurges({
    perRoute: [
      { route: '?', count: 9 }, // unrouted → no_route
      { route: '49', count: 9 }, // no schedule denominator → no_schedule
    ],
    scheduledForRoute: sched({}),
    onDrop: (d) => drops.push(d),
  });
  assert.equal(events.length, 0);
  assert.deepEqual(drops.map((d) => d.reason).sort(), ['no_route', 'no_schedule']);
});

test('events are sorted by fraction descending', () => {
  const events = detectCancellationSurges({
    perRoute: [
      { route: '10', count: 5 }, // 5/10 = 50%
      { route: '20', count: 9 }, // 9/10 = 90%
      { route: '30', count: 7 }, // 7/10 = 70%
    ],
    scheduledForRoute: sched({ 10: 10, 20: 10, 30: 10 }),
  });
  assert.deepEqual(
    events.map((e) => e.route),
    ['20', '30', '10'],
  );
});
