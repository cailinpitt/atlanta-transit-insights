const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const { spawnSync } = require('node:child_process');

// Throwaway DB BEFORE requiring storage-backed modules (path read on first getDb).
const TMP_DB = Path.join(Os.tmpdir(), `marta-bunchpost-test-${process.pid}-${Date.now()}.sqlite`);
process.env.MARTA_HISTORY_DB_PATH = TMP_DB;

const storage = require('../../src/marta/storage');
const incidents = require('../../src/marta/shared/incidents');
const state = require('../../src/marta/shared/state');
const {
  buildPostText,
  buildAltText,
  buildVideoPostText,
  buildVideoAltText,
} = require('../../src/marta/bus/bunchingPost');

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
const bunch = {
  shapeId: 'S1',
  route: '20',
  spanFt: 600,
  vehicles: [
    { vehicleId: '1001', distFt: 3000, lat: 33.77, lon: -84.39 },
    { vehicleId: '1002', distFt: 2700, lat: 33.768, lon: -84.39 },
    { vehicleId: '1003', distFt: 2400, lat: 33.766, lon: -84.39 },
  ],
};
const ctx = {
  routeTitle: 'Route 20 (Peachtree St)',
  direction: 'Doraville',
  nearStopName: 'Peachtree St NE @ 10th St',
};

// --- pure post text/alt -----------------------------------------------------

test('buildPostText renders route, count, span, near-stop, and numbered buses', () => {
  const text = buildPostText(bunch, ctx, []);
  assert.match(text, /^🚌 Route 20 \(Peachtree St\) — Doraville/);
  assert.match(text, /3 buses within 600 ft near Peachtree St NE @ 10th St/);
  assert.match(text, /Buses: /);
  // Lead bus (highest distFt) is numbered 1.
  assert.match(text, /#1001 \(1️⃣\)/);
  assert.match(text, /#1003 \(3️⃣\)/);
});

test('buildPostText appends callouts and a record line', () => {
  const text = buildPostText(bunch, ctx, ['2nd Route 20 bunch reported today'], {
    isAllTimeRecord: true,
    previousRecord: 2,
  });
  assert.match(text, /🥇 New record: most buses ever bunched \(was 2\)/);
  assert.match(text, /📊 2nd Route 20 bunch reported today/);
});

test('buildAltText describes the map', () => {
  const alt = buildAltText(bunch, ctx);
  assert.match(alt, /Map of Route 20 \(Peachtree St\) near Peachtree St NE @ 10th St/);
  assert.match(alt, /3 doraville buses within 600 ft/);
});

test('video reply text and alt text describe recent bus bunch movement', () => {
  assert.match(buildVideoPostText({ elapsedSec: 420 }, bunch), /7 min of recent movement/);
  assert.match(buildVideoPostText({ elapsedSec: 420 }, bunch), /3-bus bunch/);
  assert.match(buildVideoAltText(bunch, ctx), /Timelapse map of Route 20 \(Peachtree St\)/);
});

// --- incident lifecycle: cooldown / cap / callouts --------------------------

test('cooldown acquire is all-or-nothing and clearable', () => {
  assert.equal(state.acquireCooldown(['shape:X'], NOW), true);
  assert.equal(state.isOnCooldown('shape:X', NOW), true);
  assert.equal(state.acquireCooldown(['shape:X'], NOW), false, 'second acquire blocked');
  state.clearCooldown(['shape:X']);
  assert.equal(state.isOnCooldown('shape:X', NOW), false);
});

test('daily cap blocks a 4th equal-severity bunch but lets a bigger one through', () => {
  const route = '99';
  for (let i = 0; i < 3; i++) {
    incidents.recordBunching(
      {
        kind: 'bus',
        route,
        direction: 'S1',
        vehicleCount: 3,
        severityFt: 500,
        nearStop: null,
        posted: true,
      },
      NOW,
    );
  }
  const equal = incidents.bunchingCapAllows(
    { kind: 'bus', route, candidate: { vehicleCount: 3, severityFt: 500 }, cap: 3 },
    NOW,
  );
  assert.equal(equal, false, 'equal severity at cap is blocked');
  const bigger = incidents.bunchingCapAllows(
    { kind: 'bus', route, candidate: { vehicleCount: 4, severityFt: 500 }, cap: 3 },
    NOW,
  );
  assert.equal(bigger, true, 'more buses breaks the cap');
});

test('cooldown override lets a strictly-more-severe bunch through', () => {
  const route = '88';
  incidents.recordBunching(
    {
      kind: 'bus',
      route,
      direction: 'S1',
      vehicleCount: 3,
      severityFt: 500,
      nearStop: null,
      posted: true,
    },
    NOW,
  );
  assert.equal(
    incidents.bunchingCooldownAllows(
      { kind: 'bus', route, candidate: { vehicleCount: 2, severityFt: 400 } },
      NOW,
    ),
    false,
  );
  assert.equal(
    incidents.bunchingCooldownAllows(
      { kind: 'bus', route, candidate: { vehicleCount: 5, severityFt: 700 } },
      NOW,
    ),
    true,
  );
});

test('callouts count the Nth posted bunch today and track the all-time record', () => {
  const route = '77';
  assert.deepEqual(
    incidents.bunchingCallouts(
      { kind: 'bus', route, routeLabel: 'Route 77', vehicleCount: 2, severityFt: 400 },
      NOW,
    ),
    [],
  );
  incidents.recordBunching(
    {
      kind: 'bus',
      route,
      direction: 'S1',
      vehicleCount: 2,
      severityFt: 400,
      nearStop: null,
      posted: true,
    },
    NOW,
  );
  const callouts = incidents.bunchingCallouts(
    { kind: 'bus', route, routeLabel: 'Route 77', vehicleCount: 3, severityFt: 500 },
    NOW,
  );
  assert.ok(callouts.some((c) => /2nd Route 77 bunch reported today/.test(c)));
  assert.equal(incidents.previousMaxBunchingVehicleCount('bus') >= 3, true);
});

// --- import smoke (no env / network) ----------------------------------------

test('bin --check resolves all imports', () => {
  const bin = Path.join(__dirname, '..', '..', 'bin', 'marta', 'bus', 'bunching.js');
  const res = spawnSync(process.execPath, [bin, '--check'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /OK: imports resolved/);
});
