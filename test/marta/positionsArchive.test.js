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

const file = (rows) => ({ path: 'p', rows, bytes: 1, sha256: 'h' });
const dayFiles = (n) => ({ bus: file(n), rail: file(n + 1), streetcar: file(n + 2) });

test('buildIndex lists only uploaded days, newest first', () => {
  const index = buildIndex(
    {
      '2026-10-02': { uploaded: true, files: dayFiles(2) },
      '2026-10-01': { uploaded: true, files: dayFiles(1) },
      '2026-10-03': { uploaded: false, files: {} },
    },
    0,
  );
  assert.deepStrictEqual(
    index.days.map((d) => d.date),
    ['2026-10-02', '2026-10-01'],
  );
  assert.deepStrictEqual(index.coverage, { first: '2026-10-01', latest: '2026-10-02', days: 2 });
});

test('buildIndex shape and key order', () => {
  const index = buildIndex({ '2026-10-31': { uploaded: true, files: dayFiles(5) } }, 0);
  assert.deepStrictEqual(Object.keys(index), [
    'title',
    'generated_at',
    'timezone',
    'days_are',
    'format',
    'base_url',
    'coverage',
    'feeds',
    'known_gaps',
    'days',
  ]);
  assert.deepStrictEqual(index.days[0], {
    date: '2026-10-31',
    weekday: 'Sat',
    rows: { bus: 5, rail: 6, streetcar: 7 },
    files: dayFiles(5),
  });
  assert.deepStrictEqual(index.feeds.bus.fields.ts, {
    type: 'integer',
    unit: 'epoch ms',
    nullable: false,
    description: 'Poll time',
  });
  assert.strictEqual(index.feeds.bus.fields.vehicle_ts.unit, 'epoch s');
  assert.ok(!('unit' in index.feeds.rail.fields.line));
  for (const { fields } of Object.values(index.feeds)) {
    for (const f of Object.values(fields)) {
      assert.ok(['integer', 'number', 'string'].includes(f.type));
      assert.strictEqual(typeof f.nullable, 'boolean');
    }
  }
  assert.ok(index.known_gaps.every((g) => g.start < g.end && g.feeds.length && g.note));
});

test('buildIndex migrates an old-format index without dropping days', () => {
  const old = {
    generated_at: '2026-11-01T08:40:01.664Z',
    timezone: 'America/New_York',
    format: 'gzipped NDJSON, one JSON object per line, ordered by ts',
    schema: { bus: { ts: 'Poll time, epoch ms' } },
    days: [
      { date: '2026-09-28', files: dayFiles(1) },
      { date: '2026-09-29', files: dayFiles(2) },
    ],
  };
  const manifest = {
    '2026-09-29': { uploaded: true, files: dayFiles(2) },
    '2026-09-30': { uploaded: true, files: dayFiles(3) },
  };
  const index = buildIndex(manifest, 0, old);
  assert.ok(!('schema' in index));
  assert.deepStrictEqual(
    index.days.map((d) => [d.date, d.files]),
    [
      ['2026-09-30', dayFiles(3)],
      ['2026-09-29', dayFiles(2)],
      ['2026-09-28', dayFiles(1)],
    ],
  );
  assert.deepStrictEqual(buildIndex(manifest, 0, index), index);
});
