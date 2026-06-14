#!/usr/bin/env node
// Trim the latest raw rail capture into a committed test fixture
// (test/marta/fixtures/rail-traindata.json). Keeps a representative slice: all
// rows for the first few tracked trains per line (so train-grouping and
// position are exercised) plus some scheduled rows (the no-train ghost signal).
const Fs = require('node:fs');
const Path = require('node:path');
const { parseArrivalRow } = require('../../src/marta/rail/api');

const CAPTURE = Path.join(
  __dirname,
  '..',
  '..',
  'data',
  'marta',
  'captures',
  'rail-traindata-latest.json',
);
const OUT = Path.join(__dirname, '..', '..', 'test', 'marta', 'fixtures', 'rail-traindata.json');

const TRAINS_PER_LINE = 2;
const SCHEDULED_KEEP = 8;

function main() {
  const rows = JSON.parse(Fs.readFileSync(CAPTURE, 'utf8'));

  // Pick the first TRAINS_PER_LINE tracked trains per line; keep ALL their rows
  // so each train keeps its full upcoming-station list.
  const keepKeys = new Set();
  const perLine = {};
  for (const r of rows) {
    if (r.IS_REALTIME !== 'true' || !r.TRAIN_ID) continue;
    const key = `${r.LINE}/${r.DIRECTION}/${r.TRAIN_ID}`;
    if (keepKeys.has(key)) continue;
    perLine[r.LINE] = perLine[r.LINE] || 0;
    if (perLine[r.LINE] >= TRAINS_PER_LINE) continue;
    keepKeys.add(key);
    perLine[r.LINE]++;
  }
  const tracked = rows.filter(
    (r) => r.IS_REALTIME === 'true' && keepKeys.has(`${r.LINE}/${r.DIRECTION}/${r.TRAIN_ID}`),
  );
  const scheduled = rows.filter((r) => r.IS_REALTIME === 'false').slice(0, SCHEDULED_KEEP);
  const out = [...tracked, ...scheduled];

  Fs.mkdirSync(Path.dirname(OUT), { recursive: true });
  Fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);

  const parsed = out.map((r) => parseArrivalRow(r));
  console.log(
    `Fixture written → ${OUT}\n` +
      `  rows=${out.length} trackedTrains=${keepKeys.size} scheduledRows=${scheduled.length} ` +
      `realtimeRows=${parsed.filter((a) => a.isRealtime).length}`,
  );
}

main();
