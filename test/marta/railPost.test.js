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
  buildBunchingVideoPostText,
  buildBunchingVideoAltText,
  buildGapVideoPostText,
  buildGapVideoAltText,
  buildSpeedmapPostText,
  buildSpeedmapAltText,
  formatGhostLine,
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
    terminus: 'North Springs',
    gapFt: 40_000,
    gapMin: 15.2,
    expectedMin: 5,
    ratio: 3.04,
  };
  const text = buildGapPostText(gap, ['2nd Red Line gap reported today']);
  assert.match(text, /^🚇 Red Line - Northbound to North Springs/);
  assert.match(text, /~7\.58 mi/);
  assert.match(text, /~15 min gap/);
  assert.match(text, /📊 2nd Red Line gap reported today/);
  assert.match(buildGapAltText(gap), /Red Line northbound to North Springs/);
});

test('rail gap post names flanking stations and the two trains', () => {
  const gap = {
    line: 'RED',
    direction: 'N',
    terminus: 'North Springs',
    gapFt: 40_000,
    gapMin: 15.2,
    expectedMin: 5,
    ratio: 3.04,
    leading: { trainId: '303', distFt: 60_000 },
    trailing: { trainId: '408', distFt: 20_000 },
    flankBefore: { name: 'LINDBERGH CENTER Station', distFt: 19_000 },
    flankAfter: { name: 'MEDICAL CENTER Station', distFt: 61_000 },
    midStation: { name: 'BUCKHEAD Station', distFt: 40_000 },
  };
  const text = buildGapPostText(gap);
  assert.match(text, /No trains between Lindbergh Center and Medical Center/);
  assert.doesNotMatch(text, /across ~/);
  assert.match(text, /Last seen: #303 · Next up: #408/);
  assert.match(buildGapAltText(gap), /with no trains between Lindbergh Center and Medical Center/);
});

test('rail gap video reply names the midpoint station and remaining distance', () => {
  const gap = {
    line: 'RED',
    direction: 'N',
    terminus: 'North Springs',
    gapMin: 18,
    trailing: { trainId: '408' },
  };
  const video = {
    elapsedSec: 600,
    gapMin: 18,
    stationName: 'BUCKHEAD Station',
    endDistFt: 7920,
    reached: false,
  };
  const text = buildGapVideoPostText(video, gap);
  assert.match(text, /^~18 min Red Line gap\./);
  assert.match(
    text,
    /the next train \(#408\) had closed to within ~1\.50 mi of Buckhead — the middle of the gap/,
  );
  assert.match(
    buildGapVideoAltText(gap, video),
    /the next train closing on Buckhead, the middle of the gap, over 10 min/,
  );
});

test('rail bunching post text and alt text include train count and labels', () => {
  const bunch = {
    line: 'BLUE',
    direction: 'E',
    terminus: 'Indian Creek',
    spanFt: 1500,
    trains: [
      { trainId: 'a', distFt: 10_000 },
      { trainId: 'b', distFt: 11_000 },
    ],
  };
  const text = buildBunchingPostText(bunch);
  assert.match(text, /^🚇 Blue Line - Eastbound to Indian Creek/);
  assert.match(text, /2 trains within 0\.28 mi/);
  assert.match(text, /#b \(1️⃣\), #a \(2️⃣\)/);
  assert.match(buildBunchingAltText(bunch), /2 trains bunched/);
  assert.match(buildBunchingVideoPostText({ elapsedSec: 300 }, bunch), /5 min of recent movement/);
  assert.match(buildBunchingVideoAltText(bunch), /Timelapse map of the Blue Line/);
});

test('rail bunching post weaves per-train schedule adherence when supplied', () => {
  const bunch = {
    line: 'BLUE',
    direction: 'E',
    spanFt: 1500,
    trains: [
      { trainId: 'a', distFt: 10_000 },
      { trainId: 'b', distFt: 11_000 },
    ],
  };
  const deviations = new Map([
    ['a', 12],
    ['b', -3],
  ]);
  const text = buildBunchingPostText(bunch, [], { deviations });
  assert.match(text, /#b \(1️⃣, 3 min early\), #a \(2️⃣, 12 min late\)/);
});

test('rail gap post weaves leading/trailing adherence when supplied', () => {
  const gap = {
    line: 'RED',
    direction: 'N',
    terminus: 'North Springs',
    gapMin: 15,
    expectedMin: 5,
    leading: { trainId: '303', distFt: 60_000 },
    trailing: { trainId: '408', distFt: 20_000 },
  };
  const text = buildGapPostText(gap, [], { leadingDev: 0.2, trailingDev: 7 });
  assert.match(text, /Last seen: #303 \(on time\) · Next up: #408 \(7 min late\)/);
});

test('rail gap video reply text and alt text describe recent movement', () => {
  const gap = {
    line: 'RED',
    direction: 'N',
    terminus: 'North Springs',
    gapFt: 40_000,
    gapMin: 15.2,
    expectedMin: 5,
    ratio: 3.04,
  };
  assert.match(buildGapVideoPostText({ elapsedSec: 480 }, gap), /8 min of recent movement/);
  assert.match(
    buildGapVideoAltText(gap),
    /Timelapse map of the Red Line northbound to North Springs/,
  );
});

test('rail speedmap post text and alt text describe line, direction, and bands', () => {
  const summary = { avg: 28.25 };
  const start = new Date('2026-06-14T14:00:00Z');
  const end = new Date('2026-06-14T15:00:00Z');
  const text = buildSpeedmapPostText(
    'GOLD',
    'S',
    summary,
    start,
    end,
    ['slowest reported in 14 days'],
    'Airport',
  );
  assert.match(text, /^🚦 Gold Line - Southbound to Airport/);
  assert.match(text, /average speed 28\.3 mph/);
  assert.match(text, /📊 slowest reported in 14 days/);
  assert.match(text, /🟪 35-45 mph/);

  const alt = buildSpeedmapAltText('GOLD', 'S', summary, 'Airport');
  assert.match(alt, /Speedmap of the Gold Line southbound to Airport/);
  assert.match(alt, /Overall average: 28\.3 mph/);
});

test('formatGhostLine summarizes missing trains and effective headway', () => {
  const line = formatGhostLine({
    route: 'GREEN',
    expectedActive: 8,
    observedActive: 3,
    missing: 5,
    headway: 10,
  });
  assert.match(line, /Green Line/);
  assert.match(line, /5 of 8 missing \(63%\)/);
  assert.match(line, /every ~27 min instead of ~10/);
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
  for (const rel of [
    'bin/marta/rail/gaps.js',
    'bin/marta/rail/bunching.js',
    'bin/marta/rail/ghosts.js',
    'bin/marta/rail/speedmap.js',
    'bin/marta/rail/timelapse.js',
  ]) {
    const bin = Path.join(__dirname, '..', '..', rel);
    const res = spawnSync(process.execPath, [bin, '--check'], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${rel}: ${res.stderr}`);
    assert.match(res.stdout, /OK: imports resolved/);
  }
});
