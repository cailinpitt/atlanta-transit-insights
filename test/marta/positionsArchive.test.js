const test = require('node:test');
const assert = require('node:assert');

const {
  toRecord,
  localMidnight,
  dayBounds,
  completedDays,
  filePath,
  rolloffCutoff,
  buildIndex,
} = require('../../src/marta/positionsArchive');

const HOUR = 60 * 60 * 1000;

test('localMidnight handles EDT and EST', () => {
  assert.strictEqual(localMidnight('2026-10-30'), Date.UTC(2026, 9, 30, 4));
  assert.strictEqual(localMidnight('2026-11-02'), Date.UTC(2026, 10, 2, 5));
});

test('dayBounds spans 25 hours on the fall-back day', () => {
  const { start, end } = dayBounds('2026-11-01');
  assert.strictEqual(end - start, 25 * HOUR);
});

test('completedDays runs from the start date through yesterday in Atlanta', () => {
  // 03:00 UTC on Oct 31 is still Oct 30 in Atlanta.
  const now = Date.UTC(2026, 9, 31, 3);
  assert.deepStrictEqual(completedDays(now, '2026-10-27'), [
    '2026-10-27',
    '2026-10-28',
    '2026-10-29',
  ]);
});

test('filePath nests by kind, year and month', () => {
  assert.strictEqual(filePath('rail', '2026-09-28'), 'rail/2026/09/2026-09-28.ndjson.gz');
});

test('toRecord keeps only the kind’s published fields', () => {
  const rec = toRecord('rail', { ts: 1, train_id: '101', line: 'RED', extra: 'x' });
  assert.strictEqual(rec.train_id, '101');
  assert.ok(!('extra' in rec));
  assert.ok('event_ts' in rec);
});

test('rolloffCutoff keeps the 14-day window when every old day is uploaded', () => {
  const now = Date.UTC(2026, 9, 31, 17);
  const manifest = {};
  for (const d of completedDays(now, '2026-10-01')) manifest[d] = { uploaded: true };
  assert.strictEqual(rolloffCutoff(manifest, now, '2026-10-01'), localMidnight('2026-10-17'));
});

test('rolloffCutoff stops at the first day that is not uploaded', () => {
  const now = Date.UTC(2026, 9, 31, 17);
  const manifest = {};
  for (const d of completedDays(now, '2026-10-01')) manifest[d] = { uploaded: true };
  manifest['2026-10-05'] = { uploaded: false };
  assert.strictEqual(rolloffCutoff(manifest, now, '2026-10-01'), localMidnight('2026-10-05'));
  delete manifest['2026-10-05'];
  assert.strictEqual(rolloffCutoff(manifest, now, '2026-10-01'), localMidnight('2026-10-05'));
});

test('rolloffCutoff deletes nothing before an empty manifest’s start date', () => {
  const now = Date.UTC(2026, 9, 31, 17);
  assert.strictEqual(rolloffCutoff({}, now, '2026-10-01'), localMidnight('2026-10-01'));
});

test('buildIndex lists only uploaded days, sorted', () => {
  const index = buildIndex(
    {
      '2026-10-02': { uploaded: true, files: { bus: { rows: 2 } } },
      '2026-10-01': { uploaded: true, files: { bus: { rows: 1 } } },
      '2026-10-03': { uploaded: false, files: {} },
    },
    0,
  );
  assert.deepStrictEqual(
    index.days.map((d) => d.date),
    ['2026-10-01', '2026-10-02'],
  );
  assert.ok(index.schema.streetcar.event_ts);
});
