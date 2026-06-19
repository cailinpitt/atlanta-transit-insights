const test = require('node:test');
const assert = require('node:assert/strict');
const { detectBusGhosts, ghostsFromObservations } = require('../../src/marta/bus/ghosts');
const { formatGhostLine } = require('../../src/marta/bus/ghostPost');

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

test('ghost event includes canceled trip context when provided', () => {
  const events = detectBusGhosts({
    routes: ['20'],
    getObservations: () => buildObs([4, 4, 4, 4, 4, 4]),
    expectedActive: () => 10,
    canceledTrips: () => 3,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].missing, 6);
  assert.equal(events[0].canceledTrips, 3);
});

test('drops carry canceledTrips so the roundup near-miss can subtract them', () => {
  // observed 8 of 10 → missing 2 (below abs threshold), 2 announced cancellations
  // → fully explained, so the bin records zero unexplained severity.
  const drops = [];
  detectBusGhosts({
    routes: ['20'],
    getObservations: () => buildObs([8, 8, 8, 8, 8, 8]),
    expectedActive: () => 10,
    canceledTrips: () => 2,
    onDrop: (d) => drops.push(d),
  });
  const near = drops.find((d) => d.reason === 'below_abs_threshold');
  assert.ok(near, 'expected a below_abs_threshold drop');
  assert.equal(near.missing, 2);
  assert.equal(near.canceledTrips, 2);
});

test('ghost post line uses headsign labels instead of raw dir ids', () => {
  const line = formatGhostLine(
    {
      direction: '0',
      directionLabel: 'Decatur Station',
      observedActive: 2,
      expectedActive: 4,
      missing: 2,
      headway: 15,
    },
    'Route 15 (Clifton Road / Candler Road)',
  );
  assert.match(line, /Decatur Station/);
  assert.doesNotMatch(line, /dir 0/);
});

test('near-full service does not fire (below absolute threshold)', () => {
  const { events, drops } = run([9, 9, 9, 9, 9, 9], 10);
  assert.equal(events.length, 0);
  assert.ok(drops.some((d) => d.reason === 'below_abs_threshold'));
});

test('a below-abs-threshold drop carries the detail the roundup near-miss needs', () => {
  // observed 8 of 10 → missing 2, under MISSING_ABS_THRESHOLD (3) so no posted
  // ghost, but missing ≥ 3*0.5 so the bin records a scaled-severity meta_signal.
  const { events, drops } = run([8, 8, 8, 8, 8, 8], 10);
  assert.equal(events.length, 0);
  const near = drops.find((d) => d.reason === 'below_abs_threshold');
  assert.ok(near, 'expected a below_abs_threshold drop');
  assert.equal(near.route, '20');
  assert.equal(near.missing, 2);
  assert.equal(near.observedActive, 8);
  assert.equal(near.expectedActive, 10);
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

test('ghostsFromObservations resolves canceled trip statuses through GTFS direction', () => {
  const gtfs = {
    tripsById: new Map([
      ['trip-live', { route_id: 'r20', direction_id: '0' }],
      ['trip-cancel-1', { route_id: 'r20', direction_id: '0' }],
      ['trip-cancel-2', { route_id: 'r20', direction_id: '0' }],
      ['trip-other-dir', { route_id: 'r20', direction_id: '1' }],
    ]),
    routesById: new Map([['r20', { route_short_name: '20' }]]),
  };
  const observations = buildObs([4, 4, 4, 4, 4, 4]).map((row) => ({
    ...row,
    tripId: 'trip-live',
  }));
  const tripStatuses = [
    { tripId: 'trip-cancel-1', tripRelationship: 'CANCELED' },
    { tripId: 'trip-cancel-2', tripRelationship: 'CANCELED' },
    { tripId: 'trip-cancel-2', tripRelationship: 'CANCELED' },
    { tripId: 'trip-other-dir', tripRelationship: 'CANCELED' },
  ];
  const events = ghostsFromObservations(observations, {
    gtfs,
    tripStatuses,
    routes: ['20'],
    index: {
      routes: {
        20: {
          0: {
            activeByHour: { weekday: Object.fromEntries([...Array(24)].map((_, h) => [h, 10])) },
          },
          1: {
            activeByHour: { weekday: Object.fromEntries([...Array(24)].map((_, h) => [h, 10])) },
          },
        },
      },
    },
    now: Date.UTC(2026, 5, 15, 12),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].canceledTrips, 2, 'dedupes repeated canceled trip statuses');
});
