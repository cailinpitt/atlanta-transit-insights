const test = require('node:test');
const assert = require('node:assert');
const Fs = require('node:fs');
const Path = require('node:path');

const {
  toRecord,
  localMidnight,
  dayBounds,
  completedDays,
  filePath,
  rolloffCutoff,
  buildIndex,
  KINDS,
  SCHEMA,
  SORT_ORDER,
  KNOWN_GAPS,
  newManifest,
  verifiedDay,
} = require('../../src/marta/positionsArchive');

const HOUR = 60 * 60 * 1000;

test('localMidnight handles EDT and EST', () => {
  assert.strictEqual(localMidnight('2026-10-30'), Date.UTC(2026, 9, 30, 4));
  assert.strictEqual(localMidnight('2026-11-02'), Date.UTC(2026, 10, 2, 5));
});

test('dayBounds spans 25 hours on the fall-back day', () => {
  const { start, end } = dayBounds('2026-11-01');
  assert.strictEqual(start, Date.UTC(2026, 10, 1, 4));
  assert.strictEqual(end - start, 25 * HOUR);
});

test('dayBounds spans 23 hours on the spring-forward day', () => {
  const { start, end } = dayBounds('2026-03-08');
  assert.strictEqual(start, Date.UTC(2026, 2, 8, 5));
  assert.strictEqual(end - start, 23 * HOUR);
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

test('filePath uses immutable SHA-256 revisions', () => {
  const hash = 'a'.repeat(64);
  assert.strictEqual(
    filePath('rail', '2026-09-28', hash),
    `rail/2026/09/2026-09-28.${hash}.parquet`,
  );
  assert.throws(() => filePath('rail', '2026-09-28', 'invalid'));
  assert.throws(() => filePath('train', '2026-09-28', hash));
});

test('toRecord keeps only the kind’s published fields, in schema order', () => {
  const rec = toRecord({ kind: 'rail', ts: 1, train_id: '101', line: 'RED', extra: 'x' });
  assert.strictEqual(rec.train_id, '101');
  assert.ok(!('extra' in rec));
  assert.strictEqual(rec.event_ts, null);
  assert.deepStrictEqual(Object.keys(rec), Object.keys(SCHEMA.rail.fields));
});

test('toRecord leaves bus vehicle_ts in epoch seconds', () => {
  const rec = toRecord({ kind: 'bus', ts: 1793595600000, route: '1', vehicle_ts: 1793595340 });
  assert.strictEqual(rec.vehicle_ts, 1793595340);
});

function entry(date) {
  return {
    verified: true,
    committed: true,
    files: Object.fromEntries(
      KINDS.map((kind) => [
        kind,
        {
          path: `positions/${filePath(kind, date, 'a'.repeat(64))}`,
          rows: 2,
          bytes: 100,
          sha256: 'a'.repeat(64),
          data_revision: 'a'.repeat(64),
          format: 'parquet',
          schema_version: 2,
        },
      ]),
    ),
  };
}

test('rolloff requires all feeds verified, committed and included in a publication', () => {
  const now = Date.UTC(2026, 9, 31, 17);
  const manifest = newManifest();
  for (const d of completedDays(now, '2026-10-01')) manifest.days[d] = entry(d);
  assert.strictEqual(rolloffCutoff(manifest, now, '2026-10-01'), localMidnight('2026-10-01'));
  manifest.published = { path: 'positions/manifests/test.json' };
  assert.strictEqual(rolloffCutoff(manifest, now, '2026-10-01'), localMidnight('2026-10-17'));
  for (const failure of ['committed', 'verified']) {
    manifest.days['2026-10-05'][failure] = false;
    assert.strictEqual(rolloffCutoff(manifest, now, '2026-10-01'), localMidnight('2026-10-05'));
    manifest.days['2026-10-05'][failure] = true;
  }
  delete manifest.days['2026-10-05'].files.streetcar;
  assert.strictEqual(rolloffCutoff(manifest, now, '2026-10-01'), localMidnight('2026-10-05'));
  assert.strictEqual(rolloffCutoff({}, now, '2026-10-01'), localMidnight('2026-10-01'));
});

test('a legacy manifest never permits rolloff', () => {
  const now = Date.UTC(2026, 9, 31, 17);
  const legacy = {};
  for (const d of completedDays(now, '2026-10-01')) legacy[d] = { uploaded: true, files: {} };
  assert.strictEqual(rolloffCutoff(legacy, now, '2026-10-01'), localMidnight('2026-10-01'));
});

test('buildIndex is Parquet-only, complete, newest first and explicitly versioned', () => {
  const manifest = newManifest();
  manifest.days['2026-10-01'] = entry('2026-10-01');
  manifest.days['2026-10-02'] = entry('2026-10-02');
  manifest.days['2026-10-03'] = { verified: false, files: {} };
  const index = buildIndex(manifest, 0);
  assert.deepStrictEqual(
    index.days.map((d) => d.date),
    ['2026-10-02', '2026-10-01'],
  );
  assert.deepStrictEqual(index.coverage, { first: '2026-10-01', latest: '2026-10-02', days: 2 });
  assert.strictEqual(index.manifest_version, 2);
  assert.strictEqual(index.schema_version, 2);
  assert.strictEqual(index.format, 'parquet');
  assert.strictEqual(index.timezone, 'America/New_York');
  assert.deepStrictEqual(index.sort_order, SORT_ORDER);
  assert.deepStrictEqual(index.sort_order.rail, ['line', 'direction', 'train_id', 'ts']);
  assert.deepStrictEqual(index.feeds.bus.fields.ts, SCHEMA.bus.fields.ts);
  assert.strictEqual(index.feeds.bus.fields.vehicle_ts.unit, 'epoch s');
  assert.strictEqual(index.feeds.rail.fields.event_ts.unit, 'epoch ms');
  assert.ok(!('table' in index.feeds.bus));
  assert.ok(index.known_gaps.every((g) => g.start < g.end && g.feeds.length && g.note));
  assert.throws(
    () => buildIndex(manifest, 0, { days: [{ date: '2026-09-30', files: {} }] }),
    /drop published/,
  );
  const bad = entry('2026-10-01');
  bad.files.bus.format = 'ndjson';
  assert.strictEqual(verifiedDay(bad), false);
});

test('every feed sort order is made of its own non-null or identifying fields and ends in ts', () => {
  for (const kind of KINDS) {
    assert.strictEqual(SORT_ORDER[kind].at(-1), 'ts');
    for (const name of SORT_ORDER[kind]) assert.ok(SCHEMA[kind].fields[name], `${kind}.${name}`);
  }
});

test('field types and nullability are well formed', () => {
  for (const { fields } of Object.values(SCHEMA)) {
    for (const f of Object.values(fields)) {
      assert.ok(['integer', 'number', 'string'].includes(f.type));
      assert.strictEqual(typeof f.nullable, 'boolean');
    }
  }
});

test('field descriptions leave unit to its own key', () => {
  for (const [kind, feed] of Object.entries(SCHEMA)) {
    for (const [name, field] of Object.entries(feed.fields)) {
      assert.ok(!/epoch|\(from /.test(field.description), `${kind}.${name}: ${field.description}`);
    }
  }
});

test('docs/POSITIONS.md known gaps table matches KNOWN_GAPS', () => {
  const md = Fs.readFileSync(Path.join(__dirname, '..', '..', 'docs', 'POSITIONS.md'), 'utf8');
  const table = md
    .split('\n')
    .filter((l) => /^\| 2026-/.test(l))
    .map((l) => l.trim());
  const hhmm = (iso) => iso.slice(11, 16);
  const expected = KNOWN_GAPS.map(
    (g) =>
      `| ${g.start.slice(0, 10)} | ${g.end.slice(0, 10)} | ${g.feeds.join(', ')} | ${hhmm(g.start)} to ${
        hhmm(g.end) === '00:00' ? 'midnight' : hhmm(g.end)
      } | ${g.note} |`,
  );
  assert.deepStrictEqual(table, expected);
});
