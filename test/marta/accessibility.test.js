const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');

const TMP_DB = Path.join(
  Os.tmpdir(),
  `marta-accessibility-test-${process.pid}-${Date.now()}.sqlite`,
);
process.env.MARTA_HISTORY_DB_PATH = TMP_DB;

const storage = require('../../src/marta/storage');
const {
  ACCESSIBILITY_CLEAR_TICKS,
  upsertAccessibilityOutages,
  reconcileAccessibilityOutages,
  getAccessibilityOutages,
} = storage;
const {
  classifyUnit,
  isAccessibilityAlert,
  parseStationAndUnit,
  toOutageRows,
} = require('../../src/marta/accessibility');
const { buildAccessibilityPayload } = require('../../bin/marta/export-accessibility');
const { main: backfillStations } = require('../../bin/marta/backfill-accessibility-stations');

test.after(() => {
  storage.closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try {
      Fs.unlinkSync(TMP_DB + ext);
    } catch {
      // best effort
    }
  }
});

test('classifies accessibility alerts from effect and prose', () => {
  assert.equal(isAccessibilityAlert({ effect: 'ACCESSIBILITY_ISSUE', header: 'Notice' }), true);
  assert.equal(isAccessibilityAlert({ header: 'Elevator at Midtown Station is out' }), true);
  assert.equal(isAccessibilityAlert({ header: 'Green Line delays' }), false);
  assert.equal(classifyUnit('Escalator at Five Points is unavailable'), 'escalator');
});

test('parses a roster station and unit label from prose', () => {
  const parsed = parseStationAndUnit(
    'Elevator to the Red/Gold Line platform at Midtown Station is out of service.',
  );
  assert.equal(parsed.stationName, 'Midtown');
  assert.equal(parsed.stationSlug, 'midtown-station');
  assert.deepEqual(parsed.stationLines, ['gold', 'red']);
  assert.equal(parsed.unitLabel, 'to the Red/Gold Line platform');
});

test('matches Lakewood-Ft. McPherson despite feed punctuation', () => {
  const parsed = parseStationAndUnit(
    'Elevator EE-1 (bus bay to concourse [Lee St]) is restored. Elevator Alert for Lakewood-Ft. McPherson Station',
  );
  assert.equal(parsed.stationName, 'Lakewood-Ft Mcpherson');
  assert.equal(parsed.stationSlug, 'lakewood-ft-mcpherson-station');
  assert.deepEqual(parsed.stationLines, ['gold', 'red']);
});

test('keeps unmatched stations visible but unlinked', () => {
  const parsed = parseStationAndUnit('Elevator at Mystery Stop is out of service.');
  assert.equal(parsed.stationName, 'Mystery Stop');
  assert.equal(parsed.stationSlug, null);
});

test('maps OTP-style alerts to outage rows', () => {
  const rows = toOutageRows(
    [
      {
        id: Buffer.from('Alert:MARTA:alert-123').toString('base64'),
        effect: 'ACCESSIBILITY_ISSUE',
        header: 'Elevator at Arts Center Station unavailable',
        description: 'Elevator to southbound platform at Arts Center Station is out.',
        url: 'https://itsmarta.com/',
        informedEntities: [{ routeId: 'Red', routeType: 1 }],
      },
    ],
    undefined,
    5000,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceId, 'Alert:MARTA:alert-123');
  assert.equal(rows[0].unitType, 'elevator');
  assert.equal(rows[0].unitLabel, 'to southbound platform');
  assert.equal(rows[0].stationSlug, 'arts-center-station');
  assert.deepEqual(rows[0].lines, ['gold', 'red']);
});

test('prefers description text for unit label over generic headline text', () => {
  const rows = toOutageRows(
    [
      {
        id: Buffer.from('Alert:MARTA:alert-2584506771016740').toString('base64'),
        effect: 'ACCESSIBILITY_ISSUE',
        header: 'Elevator Alert for Dunwoody Station',
        description:
          'Elevator SE-3 (platform to street level [State Farm side]) is out of service. Use white or blue phone for customer assistance.',
        informedEntities: [{ routeId: 'Red', routeType: 1 }],
      },
    ],
    undefined,
    5000,
  );
  assert.equal(rows[0].stationName, 'Dunwoody');
  assert.equal(rows[0].stationSlug, 'dunwoody-station');
  assert.equal(rows[0].unitLabel, 'SE-3 (platform to street level [State Farm side])');
});

test('storage upsert, reconcile, reappear, and export payload', () => {
  const row = {
    sourceId: 'Alert:MARTA:alert-999',
    agency: 'marta',
    stationName: 'Midtown',
    stationSlug: 'midtown-station',
    lines: ['gold', 'red'],
    unitType: 'elevator',
    unitLabel: 'to platform',
    headline: 'Elevator at Midtown out',
    description: 'Elevator to platform at Midtown Station is out.',
    sourceUrl: 'https://itsmarta.com/',
    firstSeenTs: 1000,
  };
  upsertAccessibilityOutages([row], 1000);
  assert.equal(getAccessibilityOutages(0)[0].active, true);

  for (let i = 0; i < ACCESSIBILITY_CLEAR_TICKS - 1; i += 1) {
    reconcileAccessibilityOutages(new Set(), 2000 + i);
  }
  assert.equal(getAccessibilityOutages(0)[0].active, true);

  reconcileAccessibilityOutages(new Set(), 3000);
  let stored = getAccessibilityOutages(0)[0];
  assert.equal(stored.active, false);
  assert.equal(stored.restoredTs, 2000);

  upsertAccessibilityOutages([row], 4000);
  stored = getAccessibilityOutages(0)[0];
  assert.equal(stored.active, true);
  assert.equal(stored.restoredTs, null);

  const payload = buildAccessibilityPayload({ now: 5000 });
  assert.equal(payload.schema_version, 1);
  assert.equal(payload.outages.length, 1);
  assert.equal(payload.outages[0].id, 'marta-Alert:MARTA:alert-999');
  assert.equal(payload.outages[0].station.slug, 'midtown-station');
  assert.equal(payload.outages[0].lifecycle.active, true);
});

test('backfill re-matches stored outages whose station never resolved', () => {
  const unmatched = {
    sourceId: 'Alert:MARTA:alert-backfill',
    agency: 'marta',
    stationName: null,
    stationSlug: null,
    lines: [],
    unitType: 'elevator',
    unitLabel: 'EE-1 (bus bay to concourse [Lee St])',
    headline: 'Elevator Alert for Lakewood-Ft. McPherson Station',
    description: 'Elevator EE-1 (bus bay to concourse [Lee St]) is restored.',
    sourceUrl: 'https://itsmarta.com/',
    firstSeenTs: 6000,
  };
  upsertAccessibilityOutages([unmatched], 6000);
  const before = getAccessibilityOutages(0).find((o) => o.sourceId === unmatched.sourceId);
  assert.equal(before.stationSlug, null);

  backfillStations();

  const after = getAccessibilityOutages(0).find((o) => o.sourceId === unmatched.sourceId);
  assert.equal(after.stationName, 'Lakewood-Ft Mcpherson');
  assert.equal(after.stationSlug, 'lakewood-ft-mcpherson-station');
  assert.deepEqual(after.lines, ['gold', 'red']);
});

test('export reports accessibility archive launch date before retention cutoff', () => {
  const payload = buildAccessibilityPayload({ now: Date.parse('2026-06-24T12:00:00Z') });
  assert.equal(payload.data_start_ts, Date.parse('2026-06-23T12:00:00Z'));
});
