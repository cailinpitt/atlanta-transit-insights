const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const { spawnSync } = require('node:child_process');

const TMP_DB = Path.join(Os.tmpdir(), `marta-pulse-test-${process.pid}-${Date.now()}.sqlite`);
process.env.MARTA_HISTORY_DB_PATH = TMP_DB;

const { detectBusBlackouts } = require('../../src/marta/bus/pulse');
const storage = require('../../src/marta/storage');
const incidents = require('../../src/marta/shared/incidents');
const { buildExport } = require('../../bin/marta/export-web');

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

const NOW = 1_700_000_000_000;

function build({
  routes = ['1', '2', '3', '4', '5', '6', '7'],
  observationsByRoute = new Map(),
  expectedActiveByRoute = {},
  globalDistinctTs = 5,
  now = NOW,
  opts = {},
} = {}) {
  for (const r of routes) {
    if (!observationsByRoute.has(String(r))) observationsByRoute.set(String(r), []);
  }
  return {
    routes,
    routeNames: Object.fromEntries(routes.map((r) => [r, `Route ${r}`])),
    observationsByRoute,
    loadPattern: () => ({}),
    getKnownPidsForRoute: () => ['shape-x'],
    expectedRouteActive: (route) => expectedActiveByRoute[route] ?? 6,
    expectedHeadway: () => 8,
    globalDistinctTs,
    now,
    opts,
  };
}

function healthyRoute(map, route, now) {
  const arr = [];
  for (let i = 0; i < 4; i++) arr.push({ ts: now - i * 60_000, vid: `${route}-${i}` });
  map.set(String(route), arr);
}

test('warming-up when global distinct ts is below the floor', async () => {
  const result = await detectBusBlackouts(build({ globalDistinctTs: 1 }));
  assert.equal(result.skipped, 'warming-up');
});

test('pipeline-wide-quiet when too few other routes are active', async () => {
  const map = new Map();
  healthyRoute(map, '1', NOW);
  healthyRoute(map, '2', NOW);
  const result = await detectBusBlackouts(build({ observationsByRoute: map }));
  assert.equal(result.skipped, 'pipeline-wide-quiet');
});

test('flags a single fully-blacked-out route while others are healthy', async () => {
  const map = new Map();
  for (const r of ['2', '3', '4', '5', '6', '7']) healthyRoute(map, r, NOW);
  map.set('1', []);
  const result = await detectBusBlackouts(build({ observationsByRoute: map }));
  assert.equal(result.skipped, null);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].route, '1');
});

test('a route with expectedActive < 2 is not flagged even when silent', async () => {
  const map = new Map();
  for (const r of ['2', '3', '4', '5', '6', '7']) healthyRoute(map, r, NOW);
  map.set('1', []);
  const result = await detectBusBlackouts(
    build({ observationsByRoute: map, expectedActiveByRoute: { 1: 0.5 } }),
  );
  assert.equal(
    result.candidates.find((c) => c.route === '1'),
    undefined,
  );
});

test('a route with vehicles in the window is not flagged', async () => {
  const map = new Map();
  for (const r of ['2', '3', '4', '5', '6', '7']) healthyRoute(map, r, NOW);
  healthyRoute(map, '1', NOW); // route 1 has buses too
  const result = await detectBusBlackouts(build({ observationsByRoute: map }));
  assert.equal(result.candidates.length, 0);
});

test("observed (pulse) firing surfaces as a standalone 'pulse-cold' bot incident", () => {
  const ts = NOW;
  incidents.recordDisruption(
    {
      kind: 'bus',
      line: '110',
      source: 'observed',
      posted: true,
      postUri: 'at://did:plc:test/app.bsky.feed.post/pulse110',
      evidence: { lookbackMin: 30, expectedActive: 4 },
    },
    ts,
  );
  let out = buildExport(storage.getDb(), ts + 1000);
  const inc = out.incidents.find((i) => i.detections?.some((d) => d.source === 'pulse-cold'));
  assert.ok(inc, 'pulse-cold incident present');
  assert.deepEqual(inc.sources, ['bot']);
  assert.equal(inc.lifecycle.active, true);

  incidents.recordDisruption(
    { kind: 'bus', line: '110', source: 'observed-clear', posted: true, postUri: 'y' },
    ts + 30 * 60_000,
  );
  out = buildExport(storage.getDb(), ts + 31 * 60_000);
  const resolved = out.incidents.find((i) => i.detections?.some((d) => d.source === 'pulse-cold'));
  assert.equal(resolved.lifecycle.active, false);
});

test('openSilenceLines powers cross-detector suppression and releases on a shared clear', () => {
  const ts = NOW + 9 * 60 * 60_000; // distinct window from the route-110 case above
  const sinceMs = 7 * 24 * 60 * 60_000;
  // An open thin-gap on 900 and an open pulse on 901.
  incidents.recordDisruption(
    { kind: 'bus', line: '900', source: 'observed-thin', posted: true, postUri: 'thin900' },
    ts,
  );
  incidents.recordDisruption(
    { kind: 'bus', line: '901', source: 'observed', posted: true, postUri: 'pulse901' },
    ts,
  );

  // Each detector sees only the OTHER's open silence under its own source key —
  // so pulse would skip 900 and thin-gaps would skip 901.
  const openThin = incidents.openSilenceLines(
    { kind: 'bus', source: 'observed-thin', sinceMs },
    ts + 1000,
  );
  const openPulse = incidents.openSilenceLines(
    { kind: 'bus', source: 'observed', sinceMs },
    ts + 1000,
  );
  assert.ok(openThin.has('900'), 'open thin-gap on 900 surfaces');
  assert.ok(!openThin.has('901'), 'a pulse firing is not an open thin-gap');
  assert.ok(openPulse.has('901'), 'open pulse on 901 surfaces');
  assert.ok(!openPulse.has('900'), 'a thin-gap firing is not an open pulse');

  // A line-keyed observed-clear (posted by either detector) releases the
  // suppression — 900 drops out once buses are observed again.
  incidents.recordDisruption(
    { kind: 'bus', line: '900', source: 'observed-clear', posted: true, postUri: 'clear900' },
    ts + 60_000,
  );
  const afterClear = incidents.openSilenceLines(
    { kind: 'bus', source: 'observed-thin', sinceMs },
    ts + 120_000,
  );
  assert.ok(!afterClear.has('900'), 'cleared thin-gap no longer suppresses');
});

test('bin --check resolves all imports', () => {
  const bin = Path.join(__dirname, '..', '..', 'bin', 'marta', 'bus', 'pulse.js');
  const res = spawnSync(process.execPath, [bin, '--check'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /imports resolved/);
});
