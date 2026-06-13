const { test } = require('node:test');
const assert = require('node:assert');

const {
  buildRecap,
  chartEntries,
  buildPostText,
  buildAltText,
  worstDelayLabel,
} = require('../../src/metra/recap');
const { axisFloor } = require('../../src/map/metra/recapChart');
const { scheduledCountsByLine } = require('../../bin/metra/recap');

// --- buildRecap ---

const SCHEDULED = { BNSF: 100, 'UP-N': 50, 'UP-NW': 40 };

function delay(line, delayMin, extra = {}) {
  return { line, source: 'delay', evidence: { delayMin, ...extra } };
}
function cancel(line, inferred = false) {
  return { line, source: inferred ? 'cancellation-inferred' : 'cancellation', evidence: {} };
}

test('reliability = (scheduled − cancelled − delayed) / scheduled', () => {
  const events = [cancel('BNSF'), cancel('BNSF'), delay('BNSF', 20)];
  const recap = buildRecap({ events, scheduledByLine: SCHEDULED });
  const bnsf = recap.lines.find((l) => l.line === 'BNSF');
  assert.strictEqual(bnsf.cancelled, 2);
  assert.strictEqual(bnsf.delayed, 1);
  assert.strictEqual(bnsf.disrupted, 3);
  assert.strictEqual(bnsf.reliabilityPct, 97); // (100-3)/100
});

test('confirmed and inferred cancellations both count as cancelled', () => {
  const recap = buildRecap({
    events: [cancel('UP-N'), cancel('UP-N', true)],
    scheduledByLine: SCHEDULED,
  });
  const upn = recap.lines.find((l) => l.line === 'UP-N');
  assert.strictEqual(upn.cancelled, 2);
  assert.strictEqual(upn.reliabilityPct, 96); // (50-2)/50
});

test('a line with no incidents is seeded at 100%', () => {
  const recap = buildRecap({ events: [], scheduledByLine: SCHEDULED });
  for (const l of recap.lines) assert.strictEqual(l.reliabilityPct, 100);
});

test('systemwide folds only lines with a denominator', () => {
  // GHOST line has incidents but no scheduled count — must not poison the headline.
  const events = [delay('BNSF', 16), cancel('GHOST')];
  const recap = buildRecap({ events, scheduledByLine: SCHEDULED });
  assert.strictEqual(recap.systemwide.scheduled, 190);
  assert.strictEqual(recap.systemwide.disrupted, 1); // GHOST excluded
  assert.strictEqual(recap.systemwide.reliabilityPct, 99.5); // (190-1)/190
});

test('worstDelay tracks the single largest delayMin', () => {
  const events = [
    delay('BNSF', 20, { headsign: 'Aurora', scheduledDepLabel: '6:30 PM' }),
    delay('UP-N', 71, { headsign: 'Waukegan', scheduledDepLabel: '5:10 PM' }),
  ];
  const recap = buildRecap({ events, scheduledByLine: SCHEDULED });
  assert.strictEqual(recap.worstDelay.delayMin, 71);
  assert.strictEqual(recap.worstDelay.line, 'UP-N');
});

// --- chartEntries ---

test('chartEntries drops lines with no denominator and sorts least-reliable first', () => {
  const events = [cancel('BNSF'), cancel('UP-N'), cancel('UP-N'), cancel('GHOST')];
  const recap = buildRecap({ events, scheduledByLine: SCHEDULED });
  const entries = chartEntries(recap);
  assert.ok(!entries.some((e) => e.line === 'GHOST'));
  // UP-N (96%) worse than BNSF (99%) worse than UP-NW (100%)
  assert.deepStrictEqual(
    entries.map((e) => e.line),
    ['UP-N', 'BNSF', 'UP-NW'],
  );
});

// --- post text ---

test('post text leads with systemwide on-time and trip count', () => {
  const recap = buildRecap({
    events: [
      cancel('UP-NW'),
      delay('UP-NW', 30, { headsign: 'Harvard', scheduledDepLabel: '7:00 AM' }),
    ],
    scheduledByLine: SCHEDULED,
  });
  const text = buildPostText({ recap, windowLabel: 'May 2026' });
  assert.match(text, /🚆 Metra recap · May 2026/);
  assert.match(text, /on-time/i);
  assert.match(text, /scheduled trips/);
  assert.match(text, /Worst delay: 30 min — 7:00 AM Harvard \(Union Pacific Northwest\)/);
  assert.ok(text.length <= 300, 'within Bluesky grapheme budget');
});

test('post text handles an empty schedule gracefully', () => {
  const recap = buildRecap({ events: [], scheduledByLine: {} });
  const text = buildPostText({ recap, windowLabel: 'May 2026' });
  assert.match(text, /No Metra schedule data/);
});

test('alt text names the on-time definition and worst lines', () => {
  const recap = buildRecap({ events: [cancel('BNSF')], scheduledByLine: SCHEDULED });
  const alt = buildAltText({ recap, windowLabel: 'this week' });
  assert.match(alt, /within 15 minutes/);
  assert.match(alt, /BNSF/);
});

// --- worstDelayLabel ---

test('worstDelayLabel composes dep + headsign + line, dropping missing pieces', () => {
  assert.strictEqual(
    worstDelayLabel({ line: 'BNSF', delayMin: 20, depLabel: '6:30 PM', headsign: 'Aurora' }),
    '6:30 PM Aurora (BNSF)',
  );
  assert.strictEqual(worstDelayLabel({ line: 'UP-N', delayMin: 20 }), 'Union Pacific North');
  assert.strictEqual(worstDelayLabel(null), null);
});

// --- axisFloor (chart zoom) ---

test('axisFloor zooms to a clean 5% step at or below the worst line', () => {
  assert.strictEqual(axisFloor([{ reliabilityPct: 92.1 }, { reliabilityPct: 99 }]), 90);
  assert.strictEqual(axisFloor([{ reliabilityPct: 100 }]), 90); // perfect week still readable
  assert.strictEqual(axisFloor([{ reliabilityPct: 71 }]), 65);
});

// --- scheduledCountsByLine ---

test('scheduledCountsByLine counts active trips per line across the window', () => {
  // Two trips, one always-active service, spanning a 2-day window → counted once per day.
  const index = {
    calendar: { S1: { days: [1, 1, 1, 1, 1, 1, 1], start_date: '20260101', end_date: '20271231' } },
    calendarDates: [],
    trips: {
      t1: { route_id: 'BNSF', service_id: 'S1' },
      t2: { route_id: 'UP-N', service_id: 'S1' },
      t3: { route_id: 'BNSF', service_id: 'OFF' }, // inactive service
    },
  };
  // A ~2-day window (use a fixed range well inside the calendar).
  const since = Date.UTC(2026, 4, 4, 5); // 2026-05-04 ~midnight CT
  const until = Date.UTC(2026, 4, 6, 5); // 2026-05-06 ~midnight CT
  const counts = scheduledCountsByLine(index, since, until);
  assert.strictEqual(counts.BNSF, 2); // 1 trip × 2 days
  assert.strictEqual(counts['UP-N'], 2);
  assert.ok(!('OFF' in counts));
});
