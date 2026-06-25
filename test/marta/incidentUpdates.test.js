const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');

// Throwaway DB before requiring storage/incidents (path read on first getDb()).
const TMP_DB = Path.join(Os.tmpdir(), `marta-incupd-test-${process.pid}-${Date.now()}.sqlite`);
process.env.MARTA_HISTORY_DB_PATH = TMP_DB;

const storage = require('../../src/marta/storage');
const incidents = require('../../src/marta/shared/incidents');
const {
  dueForUpdate,
  formatElapsed,
  thinGapUpdate,
  busPulseUpdate,
  railPulseUpdate,
} = require('../../src/marta/shared/incidentUpdates');
const backfill = require('../../bin/marta/backfill-incident-updates');

const HOUR = 60 * 60 * 1000;

test.after(() => {
  storage.closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try {
      Fs.unlinkSync(TMP_DB + ext);
    } catch {
      /* best effort */
    }
  }
});

// --- Pure cadence gate ---

test('dueForUpdate enforces the hourly interval and the post-open grace', () => {
  const now = 10 * HOUR;
  // Just opened: under the min-age grace → not yet.
  assert.equal(dueForUpdate({ openedTs: now - 10 * 60 * 1000, lastUpdateTs: null, now }), false);
  // Open ~1h, no update yet → due.
  assert.equal(dueForUpdate({ openedTs: now - HOUR, lastUpdateTs: null, now }), true);
  // Updated 30 min ago → not due.
  assert.equal(
    dueForUpdate({ openedTs: now - 3 * HOUR, lastUpdateTs: now - 30 * 60 * 1000, now }),
    false,
  );
  // Updated ~1h ago → due again.
  assert.equal(dueForUpdate({ openedTs: now - 3 * HOUR, lastUpdateTs: now - HOUR, now }), true);
  // No open ts → never.
  assert.equal(dueForUpdate({ openedTs: null, lastUpdateTs: null, now }), false);
});

test('formatElapsed rounds to whole hours past 60 min', () => {
  assert.equal(formatElapsed(45), '~45 min');
  assert.equal(formatElapsed(60), '~1h');
  assert.equal(formatElapsed(180), '~3h');
  assert.equal(formatElapsed(-5), null);
});

// --- Pure text/evidence builders ---

test('thinGapUpdate counts missed scheduled trips', () => {
  const u = thinGapUpdate({ routeTitle: 'Route 110', headwayMin: 35, elapsedMin: 180 });
  assert.equal(
    u.description,
    '🚌 Route 110 · still no buses observed — ~3h in, ~5 scheduled trips missed so far.',
  );
  assert.deepEqual(u.evidence, { elapsedMin: 180, headwayMin: 35, missedTrips: 5 });
});

test('busPulseUpdate names the normal active count', () => {
  const u = busPulseUpdate({ routeTitle: 'Route 1', expectedActive: 6, elapsedMin: 120 });
  assert.equal(
    u.description,
    '🚌 Route 1 · service still appears suspended — ~2h in; ~6 buses normally running this time.',
  );
});

test('railPulseUpdate distinguishes a segment from a line-wide outage', () => {
  const seg = railPulseUpdate({
    lineTitle: 'Red Line',
    fromStation: 'Lenox',
    toStation: 'Brookhaven',
    expectedTrains: 4,
    elapsedMin: 120,
  });
  assert.equal(
    seg.description,
    '🚇 Red Line · still no trains observed between Lenox and Brookhaven — ~2h in; ~4 trains normally running this time.',
  );
  const whole = railPulseUpdate({ lineTitle: 'Gold Line', synthetic: true, elapsedMin: 60 });
  assert.match(whole.description, /still no trains observed line-wide — ~1h in/);
});

// --- Storage round-trip ---

test('incident_updates round-trip, latest ts, hour idempotency, grouped read', () => {
  const T = 1_781_000_000_000;
  incidents.recordIncidentUpdate({
    disruptionId: 1,
    kind: 'bus',
    line: '110',
    source: 'observed-thin',
    ts: T,
    evidence: { elapsedMin: 60 },
    description: 'first',
    postUri: 'at://a',
  });
  incidents.recordIncidentUpdate({
    disruptionId: 1,
    kind: 'bus',
    line: '110',
    source: 'observed-thin',
    ts: T + HOUR,
    evidence: { elapsedMin: 120 },
    description: 'second',
    postUri: null,
  });
  assert.equal(incidents.getLatestIncidentUpdateTs(1), T + HOUR);
  assert.equal(incidents.getLatestIncidentUpdateTs(999), null);
  // Same clock hour as T → exists; a far-off hour → not.
  assert.equal(incidents.incidentUpdateExistsForHour(1, T + 5 * 60 * 1000), true);
  assert.equal(incidents.incidentUpdateExistsForHour(1, T + 5 * HOUR), false);

  const grouped = incidents.listIncidentUpdatesByDisruption([1, 2]);
  assert.equal(grouped.get(1).length, 2);
  assert.deepEqual(
    grouped.get(1).map((r) => r.description),
    ['first', 'second'],
  );
  assert.equal(grouped.has(2), false);
});

// --- Backfill reconstruction from frozen disruption evidence ---

test('planBackfillUpdates reconstructs one update per completed hour, excluding the clear boundary', () => {
  const T = 1_782_000_000_000;
  // A 3h-exact thin-service event: open at T, cleared at T+3h.
  incidents.recordDisruption(
    {
      kind: 'bus',
      line: '855',
      source: 'observed-thin',
      posted: true,
      postUri: 'at://thin-855',
      evidence: { headwayMin: 30 },
    },
    T,
  );
  incidents.recordDisruption(
    { kind: 'bus', line: '855', source: 'observed-clear', posted: false, postUri: null },
    T + 3 * HOUR,
  );

  const rows = backfill.readAbsenceDisruptions(incidents.getDb()).filter((r) => r.line === '855');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resolved_ts, T + 3 * HOUR);

  const planned = backfill.planBackfillUpdates(rows, T + 10 * HOUR, new Map());
  // +1h and +2h only — the clear reply covers +3h.
  assert.equal(planned.length, 2);
  assert.deepEqual(
    planned.map((u) => u.ts),
    [T + HOUR, T + 2 * HOUR],
  );
  assert.match(planned[0].description, /Route 855 · still no buses observed — ~1h in/);
  assert.match(planned[1].description, /~2h in, ~4 scheduled trips missed/);

  // An open event (no clear) walks up to now.
  const T2 = 1_783_000_000_000;
  incidents.recordDisruption(
    {
      kind: 'bus',
      line: '999',
      source: 'observed',
      posted: true,
      postUri: 'at://pulse-999',
      evidence: { expectedActive: 6 },
    },
    T2,
  );
  const openRows = backfill
    .readAbsenceDisruptions(incidents.getDb())
    .filter((r) => r.line === '999');
  assert.equal(openRows[0].resolved_ts, null);
  const openPlanned = backfill.planBackfillUpdates(
    openRows,
    T2 + 2 * HOUR + 5 * 60 * 1000,
    new Map(),
  );
  assert.equal(openPlanned.length, 2);
  assert.match(openPlanned[1].description, /service still appears suspended — ~2h in; ~6 buses/);
});
