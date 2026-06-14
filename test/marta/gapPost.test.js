const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const { spawnSync } = require('node:child_process');

const TMP_DB = Path.join(Os.tmpdir(), `marta-gappost-test-${process.pid}-${Date.now()}.sqlite`);
process.env.MARTA_HISTORY_DB_PATH = TMP_DB;

const storage = require('../../src/marta/storage');
const incidents = require('../../src/marta/shared/incidents');
const {
  buildPostText,
  buildAltText,
  buildVideoPostText,
  buildVideoAltText,
} = require('../../src/marta/bus/gapPost');

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
const gap = {
  shapeId: 'S1',
  route: '20',
  gapFt: 17600,
  gapMin: 20,
  expectedMin: 8,
  ratio: 2.5,
  leading: { vehicleId: '1001', distFt: 22000, lat: 33.78, lon: -84.39 },
  trailing: { vehicleId: '1002', distFt: 4400, lat: 33.76, lon: -84.39 },
  flankBefore: { stopName: 'Peachtree St NE @ 10th St' },
  flankAfter: { stopName: 'Peachtree St NE @ 14th St' },
};
const ctx = {
  routeTitle: 'Route 20 (Peachtree St)',
  direction: 'Doraville',
  nearStopName: 'Peachtree St NE @ 12th St',
};

test('buildPostText renders route, direction, stretch, headway, and buses', () => {
  const text = buildPostText(gap, ctx, [], { leadingDev: 5, trailingDev: -2 });
  assert.match(text, /^🕳️ Route 20 \(Peachtree St\) — Doraville/);
  assert.match(text, /No buses between Peachtree St NE @ 10th St and Peachtree St NE @ 14th St/);
  assert.match(text, /~20 min gap, scheduled around every 8 min this hour/);
  assert.match(text, /Last seen: #1001 \(5 min late\)/);
  assert.match(text, /Next up: #1002 \(2 min early\)/);
});

test('buildPostText appends callouts', () => {
  const text = buildPostText(gap, ctx, ['2nd Route 20 gap reported today']);
  assert.match(text, /📊 2nd Route 20 gap reported today/);
});

test('buildAltText describes the map', () => {
  const alt = buildAltText(gap, ctx);
  assert.match(alt, /Map of Route 20 \(Peachtree St\) doraville/);
  assert.match(alt, /20 min gap/);
});

test('video reply text and alt text describe recent bus gap movement', () => {
  assert.match(buildVideoPostText({ elapsedSec: 360 }, gap), /6 min of recent movement/);
  assert.match(buildVideoPostText({ elapsedSec: 360 }, gap), /20 min bus gap/);
  assert.match(buildVideoAltText(gap, ctx), /Timelapse map of Route 20 \(Peachtree St\)/);
});

test('daily cap blocks a 4th equal-ratio gap but lets a worse one through', () => {
  const route = '99';
  for (let i = 0; i < 3; i++) {
    incidents.recordGap(
      {
        kind: 'bus',
        route,
        direction: 'S1',
        gapFt: 10000,
        gapMin: 20,
        expectedMin: 8,
        ratio: 2.5,
        nearStop: null,
        posted: true,
      },
      NOW,
    );
  }
  assert.equal(
    incidents.gapCapAllows({ kind: 'bus', route, candidate: { ratio: 2.5 }, cap: 3 }, NOW),
    false,
  );
  assert.equal(
    incidents.gapCapAllows({ kind: 'bus', route, candidate: { ratio: 3.0 }, cap: 3 }, NOW),
    true,
  );
});

test('cooldown override requires a material ratio increase', () => {
  const route = '88';
  incidents.recordGap(
    {
      kind: 'bus',
      route,
      direction: 'S1',
      gapFt: 10000,
      gapMin: 20,
      expectedMin: 8,
      ratio: 2.5,
      nearStop: null,
      posted: true,
    },
    NOW,
  );
  assert.equal(
    incidents.gapCooldownAllows({ kind: 'bus', route, candidate: { ratio: 2.9 } }, NOW),
    false,
  );
  assert.equal(
    incidents.gapCooldownAllows({ kind: 'bus', route, candidate: { ratio: 3.2 } }, NOW),
    true,
  );
});

test('callouts count the Nth posted gap today', () => {
  const route = '77';
  incidents.recordGap(
    {
      kind: 'bus',
      route,
      direction: 'S1',
      gapFt: 10000,
      gapMin: 20,
      expectedMin: 8,
      ratio: 2.5,
      nearStop: null,
      posted: true,
    },
    NOW,
  );
  const callouts = incidents.gapCallouts(
    { kind: 'bus', route, routeLabel: 'Route 77', ratio: 3.0 },
    NOW,
  );
  assert.ok(callouts.some((c) => /2nd Route 77 gap reported today/.test(c)));
});

test('bin --check resolves all imports', () => {
  const bin = Path.join(__dirname, '..', '..', 'bin', 'marta', 'bus', 'gaps.js');
  const res = spawnSync(process.execPath, [bin, '--check'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /OK: imports resolved/);
});
