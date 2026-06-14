const test = require('node:test');
const assert = require('node:assert/strict');
const { detectBusGhosts } = require('../../src/marta/bus/ghosts');

const NOW = 1_781_000_000_000;
const INTERVAL = 10 * 60 * 1000;

// Build observation rows for one route+direction: `counts[i]` distinct vehicles
// in snapshot i (vehicle ids reused across snapshots; the detector counts
// distinct per timestamp).
function buildObs(counts, { direction = '0', startTs = NOW } = {}) {
  const rows = [];
  counts.forEach((c, i) => {
    const ts = startTs + i * INTERVAL;
    for (let k = 0; k < c; k++) rows.push({ ts, vehicleId: `bus${k}`, direction });
  });
  return rows;
}

// Run the detector for a single route with a fixed expectedActive.
function run(counts, active, opts = {}) {
  const drops = [];
  const events = detectBusGhosts({
    routes: ['20'],
    getObservations: () => buildObs(counts, opts),
    expectedActive: () => active,
    onDrop: (d) => drops.push(d),
  });
  return { events, drops };
}

test('a sustained shortfall fires a ghost', () => {
  const { events } = run([4, 4, 4, 4, 4, 4], 10);
  assert.equal(events.length, 1);
  assert.equal(events[0].route, '20');
  assert.equal(events[0].observedActive, 4);
  assert.equal(events[0].expectedActive, 10);
  assert.equal(events[0].missing, 6);
});

test('near-full service does not fire (below absolute threshold)', () => {
  const { events, drops } = run([9, 9, 9, 9, 9, 9], 10);
  assert.equal(events.length, 0);
  assert.ok(drops.some((d) => d.reason === 'below_abs_threshold'));
});

test('sparse routes are skipped', () => {
  // Observations present, but the route is only scheduled for 1 active bus.
  const { events, drops } = run([1, 1, 1, 1], 1);
  assert.equal(events.length, 0);
  assert.ok(drops.some((d) => d.reason === 'sparse_route'));
});

test('too few snapshots is skipped', () => {
  const { events, drops } = run([4, 4, 4], 10);
  assert.equal(events.length, 0);
  assert.ok(drops.some((d) => d.reason === 'too_few_snapshots'));
});

test('observed 0/1 is a gap, not a ghost', () => {
  const { events, drops } = run([1, 1, 1, 1, 1, 1], 10);
  assert.equal(events.length, 0);
  assert.ok(drops.some((d) => d.reason === 'too_few_observed'));
});

test('a filled tail (ramp-up) is not a ghost', () => {
  // Front of the hour under-served, tail at full service.
  const { events, drops } = run([4, 4, 4, 9, 9, 9], 10);
  assert.equal(events.length, 0);
  assert.ok(drops.some((d) => d.reason === 'ramp_up_filled'));
});

test('a deficit concentrated in the tail fires below the absolute bar', () => {
  // active 8, full-window median 6 (missing 2 < 3) but tail dropped to 5.
  const { events } = run([7, 7, 7, 5, 5, 5], 8);
  assert.equal(events.length, 1);
  assert.equal(events[0].missing, 2);
});

test('events sort by descending missing across routes', () => {
  const obsByRoute = {
    20: buildObs([6, 6, 6, 6, 6, 6]), // missing 4
    2: buildObs([3, 3, 3, 3, 3, 3]), // missing 7
  };
  const events = detectBusGhosts({
    routes: ['20', '2'],
    getObservations: (r) => obsByRoute[r],
    expectedActive: (r) => (r === '20' ? 10 : 10),
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].route, '2', 'bigger shortfall first');
  assert.ok(events[0].missing > events[1].missing);
});

test('no schedule for the route+direction is skipped', () => {
  const drops = [];
  const events = detectBusGhosts({
    routes: ['20'],
    getObservations: () => buildObs([4, 4, 4, 4, 4, 4]),
    expectedActive: () => null,
    onDrop: (d) => drops.push(d),
  });
  assert.equal(events.length, 0);
  assert.ok(drops.some((d) => d.reason === 'no_schedule'));
});
