const test = require('node:test');
const assert = require('node:assert/strict');
const { computeAggregates } = require('../bin/marta/export-web');

const NOW = Date.parse('2026-06-24T18:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const YEAR = 365 * DAY;

// Minimal incident in the schema-v2 shape computeAggregates reads: it only
// touches lifecycle.first_seen_ts and mode.
function incident(firstSeenTs, mode = 'rail') {
  return { mode, lifecycle: { first_seen_ts: firstSeenTs } };
}

test('overall YoY counts the trailing window vs the same window a year ago', () => {
  const incidents = [
    incident(NOW - 1 * DAY), // current window
    incident(NOW - 10 * DAY), // current window
    incident(NOW - 40 * DAY), // older than 30d, not yet a year ago → neither
    incident(NOW - YEAR - 5 * DAY), // prior window (within 30d of a year ago)
  ];
  // dataStartTs old enough that the prior window is fully covered.
  const { yoy } = computeAggregates(incidents, { now: NOW, dataStartTs: NOW - 2 * YEAR });
  assert.equal(yoy.overall.currentCount, 2);
  assert.equal(yoy.overall.priorCount, 1);
  assert.equal(yoy.overall.enoughData, true);
  assert.equal(yoy.overall.pctChange, (2 - 1) / 1);
  assert.equal(yoy.window_days, 30);
});

test('enoughData is false (and pctChange null) when history misses the prior window', () => {
  const incidents = [incident(NOW - 2 * DAY)];
  // dataStartTs after the prior window start → can't compare honestly.
  const { yoy } = computeAggregates(incidents, { now: NOW, dataStartTs: NOW - 100 * DAY });
  assert.equal(yoy.overall.enoughData, false);
  assert.equal(yoy.overall.pctChange, null);
  // The current trailing count is still well-defined.
  assert.equal(yoy.overall.currentCount, 1);
});

test('by_mode folds rail + streetcar into train; bus stays bus', () => {
  const incidents = [
    incident(NOW - 1 * DAY, 'rail'),
    incident(NOW - 1 * DAY, 'bus'),
    incident(NOW - 1 * DAY, 'streetcar'),
    incident(NOW - 1 * DAY, 'streetcar'),
  ];
  const { yoy } = computeAggregates(incidents, { now: NOW, dataStartTs: NOW - 2 * YEAR });
  assert.equal(yoy.overall.currentCount, 4);
  // rail (1) + streetcar (2) → train (3); bus (1).
  assert.equal(yoy.by_mode.train.currentCount, 3);
  assert.equal(yoy.by_mode.bus.currentCount, 1);
});

test('non-website modes are excluded from overall and by_mode (parity with isWebsiteIncident)', () => {
  const incidents = [
    incident(NOW - 1 * DAY, 'rail'),
    incident(NOW - 1 * DAY, 'general'), // not train/bus → dropped by the SPA
  ];
  const { yoy } = computeAggregates(incidents, { now: NOW, dataStartTs: NOW - 2 * YEAR });
  assert.equal(yoy.overall.currentCount, 1);
  assert.equal(yoy.by_mode.train.currentCount, 1);
  assert.equal(yoy.by_mode.bus.currentCount, 0);
});

test('incidents with no first_seen are skipped', () => {
  const incidents = [
    incident(NOW - 1 * DAY),
    { mode: 'rail', lifecycle: { first_seen_ts: null } },
    { mode: 'rail', lifecycle: {} },
    { mode: 'rail' },
  ];
  const { yoy } = computeAggregates(incidents, { now: NOW, dataStartTs: NOW - 2 * YEAR });
  assert.equal(yoy.overall.currentCount, 1);
});

test('per-mode counts sum to the overall count', () => {
  const incidents = [
    incident(NOW - 1 * DAY, 'rail'),
    incident(NOW - 5 * DAY, 'bus'),
    incident(NOW - YEAR - 3 * DAY, 'streetcar'),
    incident(NOW - YEAR - 8 * DAY, 'rail'),
  ];
  const { yoy } = computeAggregates(incidents, { now: NOW, dataStartTs: NOW - 2 * YEAR });
  const sum = (sel) => yoy.by_mode.train[sel] + yoy.by_mode.bus[sel];
  assert.equal(sum('currentCount'), yoy.overall.currentCount);
  assert.equal(sum('priorCount'), yoy.overall.priorCount);
});
