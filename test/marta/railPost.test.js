const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const { spawnSync } = require('node:child_process');

const TMP_DB = Path.join(Os.tmpdir(), `marta-railpost-test-${process.pid}-${Date.now()}.sqlite`);
process.env.MARTA_HISTORY_DB_PATH = TMP_DB;

const storage = require('../../src/marta/storage');
const incidents = require('../../src/marta/shared/incidents');
const {
  buildGapPostText,
  buildGapAltText,
  buildBunchingPostText,
  buildBunchingAltText,
} = require('../../src/marta/rail/post');

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

const NOW = 1_781_000_000_000;

test('rail gap post text and alt text describe line, direction, and headway', () => {
  const gap = {
    line: 'RED',
    direction: 'N',
    gapFt: 40_000,
    gapMin: 15.2,
    expectedMin: 5,
    ratio: 3.04,
  };
  const text = buildGapPostText(gap, ['2nd RED Line gap reported today']);
  assert.match(text, /^🚇 RED Line - Nbound/);
  assert.match(text, /~7\.58 mi/);
  assert.match(text, /~15 min gap/);
  assert.match(text, /📊 2nd RED Line gap reported today/);
  assert.match(buildGapAltText(gap), /RED Line nbound/);
});

test('rail bunching post text and alt text include train count and labels', () => {
  const bunch = {
    line: 'BLUE',
    direction: 'E',
    spanFt: 1500,
    trains: [
      { trainId: 'a', distFt: 10_000 },
      { trainId: 'b', distFt: 11_000 },
    ],
  };
  const text = buildBunchingPostText(bunch);
  assert.match(text, /^🚇 BLUE Line - Ebound/);
  assert.match(text, /2 trains within 0\.28 mi/);
  assert.match(text, /#b \(1️⃣\), #a \(2️⃣\)/);
  assert.match(buildBunchingAltText(bunch), /2 trains bunched/);
});

test('rail bunching cap/cooldown treats tighter same-count clusters as worse', () => {
  const route = 'RED';
  incidents.recordBunching(
    {
      kind: 'rail',
      route,
      direction: 'N',
      vehicleCount: 2,
      severityFt: 2000,
      posted: true,
    },
    NOW,
  );
  assert.equal(
    incidents.bunchingCooldownAllows(
      { kind: 'rail', route, candidate: { vehicleCount: 2, severityFt: 2500 } },
      NOW,
    ),
    false,
  );
  assert.equal(
    incidents.bunchingCooldownAllows(
      { kind: 'rail', route, candidate: { vehicleCount: 2, severityFt: 1500 } },
      NOW,
    ),
    true,
  );
});

test('rail bins --check resolve imports', () => {
  for (const rel of ['bin/marta/rail/gaps.js', 'bin/marta/rail/bunching.js']) {
    const bin = Path.join(__dirname, '..', '..', rel);
    const res = spawnSync(process.execPath, [bin, '--check'], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${rel}: ${res.stderr}`);
    assert.match(res.stdout, /OK: imports resolved/);
  }
});
