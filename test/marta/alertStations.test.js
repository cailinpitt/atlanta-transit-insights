const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');

const TMP_DB = Path.join(
  Os.tmpdir(),
  `marta-alertstations-test-${process.pid}-${Date.now()}.sqlite`,
);
process.env.MARTA_HISTORY_DB_PATH = TMP_DB;

const storage = require('../../src/marta/storage');
const alerts = require('../../src/marta/alert/store');
const { buildExport } = require('../../bin/marta/export-web');
const { extractAlertStations, resolveStationOnLines } = require('../../src/marta/alert/stations');

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

test('extracts both endpoints + impact mentions from a "from X to Y" rail alert', () => {
  // The real live alert that motivated this: it names Bankhead and Ashby in
  // prose but the feed carried no structured stop list.
  const out = extractAlertStations({
    headline: 'Rail Service Alert for Green Line',
    description:
      'Green line is only servicing from Bankhead to Ashby, on the EB platform. ' +
      'Customers must board on the EB platform at Ashby for service to Bankhead.',
    lines: ['green'],
  });
  assert.equal(out.affectedFromStation, 'BANKHEAD Station');
  assert.equal(out.affectedToStation, 'ASHBY Station');
  assert.deepEqual([...out.mentionedStations].sort(), ['ASHBY Station', 'BANKHEAD Station']);
});

test('extracts a single station from "delays at X" impact phrasing', () => {
  const out = extractAlertStations({
    headline: 'Red Line delays',
    description: 'Delays at Lindbergh Center due to a medical emergency.',
    lines: ['red'],
  });
  assert.equal(out.affectedFromStation, null);
  assert.equal(out.affectedToStation, null);
  assert.deepEqual(out.mentionedStations, ['LINDBERGH CENTER Station']);
});

test('handles the "between X and Y stations" phrasing', () => {
  const out = extractAlertStations({
    headline: 'Blue Line',
    description: 'No service between Indian Creek and Kensington stations.',
    lines: ['blue'],
  });
  assert.equal(out.affectedFromStation, 'INDIAN CREEK Station');
  assert.equal(out.affectedToStation, 'KENSINGTON Station');
});

test('resolution is line-scoped — a station not on the alert line does not resolve', () => {
  // Bankhead is Green only; an alert scoped to Red must not resolve it.
  assert.equal(resolveStationOnLines('Bankhead', ['red']), null);
  assert.equal(resolveStationOnLines('Bankhead', ['green']), 'BANKHEAD Station');
  // Five Points serves every line.
  assert.equal(resolveStationOnLines('Five Points', ['blue']), 'FIVE POINTS Station');
});

test('non-rail alerts and station-less text yield empty fields', () => {
  assert.deepEqual(
    extractAlertStations({ headline: 'Bus detour', description: 'Route 1 on detour.', lines: [] }),
    { affectedFromStation: null, affectedToStation: null, mentionedStations: [] },
  );
  assert.deepEqual(
    extractAlertStations({
      headline: 'Rail Service Alert',
      description: 'Trains running with residual delays systemwide.',
      lines: ['red', 'gold'],
    }),
    { affectedFromStation: null, affectedToStation: null, mentionedStations: [] },
  );
});

test('the store persists station fields and the web export surfaces them in scope', () => {
  const NOW = Date.UTC(2026, 5, 17, 12, 0, 0);
  const stations = extractAlertStations({
    headline: 'Rail Service Alert for Green Line',
    description: 'Green line is only servicing from Bankhead to Ashby.',
    lines: ['green'],
  });
  alerts.recordAlertSeen(
    {
      alertId: 'rail-green-stations',
      mode: 'rail',
      routes: 'GREEN',
      headline: 'Rail Service Alert for Green Line',
      description: 'Green line is only servicing from Bankhead to Ashby.',
      activeStartTs: NOW,
      activeEndTs: null,
      postUri: 'at://did:plc:example/app.bsky.feed.post/rail-green-stations',
      ...stations,
    },
    NOW,
  );

  const out = buildExport(storage.getDb(), NOW + 10 * 60_000);
  const incident = out.incidents.find((row) => row.official_alert?.id === 'rail-green-stations');
  assert.ok(incident, 'expected the rail alert incident in the export');
  const scope = incident.official_alert.scope;
  assert.equal(scope.from_station, 'BANKHEAD Station');
  assert.equal(scope.to_station, 'ASHBY Station');
  assert.deepEqual([...scope.mentioned_stations].sort(), ['ASHBY Station', 'BANKHEAD Station']);
});
