const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const { spawnSync } = require('node:child_process');

const TMP_DB = Path.join(Os.tmpdir(), `marta-thingaps-test-${process.pid}-${Date.now()}.sqlite`);
process.env.MARTA_HISTORY_DB_PATH = TMP_DB;

const { detectThinGaps } = require('../../src/marta/bus/thinGaps');
const storage = require('../../src/marta/storage');
const incidents = require('../../src/marta/shared/incidents');
const { buildExport } = require('../../bin/marta/export-web');

const NOW = 1_800_000_000_000;

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

function mkSched({ headway, active = 1, priorActive = 1, nextActive = 1 }) {
  return {
    getHeadway: () => headway,
    getActiveTrips: () => active,
    getPriorHourActiveTrips: () => priorActive,
    getNextHourActiveTrips: () => nextActive,
  };
}

// --- Pure core (ported from cta-insights test/bus/thinGaps.test.js) ---

test('fires when the window is empty and ≥2 trips are scheduled to fit', () => {
  const events = detectThinGaps({
    routes: ['31'],
    getObservations: () => [],
    now: NOW,
    ...mkSched({ headway: 25 }),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].route, '31');
  assert.equal(events[0].windowMin, 60);
  assert.equal(events[0].missedTrips, 2);
});

test('stays silent when any observation lands in the window', () => {
  const drops = [];
  const events = detectThinGaps({
    routes: ['31'],
    getObservations: () => [{ ts: NOW - 10 * 60_000 }],
    now: NOW,
    onDrop: (d) => drops.push(d),
    ...mkSched({ headway: 25 }),
  });
  assert.equal(events.length, 0);
  assert.equal(drops[0].reason, 'observed');
});

test('skips routes not scheduled this hour', () => {
  const drops = [];
  detectThinGaps({
    routes: ['125'],
    getObservations: () => [],
    now: NOW,
    onDrop: (d) => drops.push(d),
    ...mkSched({ headway: 20, active: 0 }),
  });
  assert.equal(drops[0].reason, 'not_scheduled');
});

test('skips ramp-up (prior hour not active) and wind-down (next hour not active)', () => {
  const rampDrops = [];
  detectThinGaps({
    routes: ['100'],
    getObservations: () => [],
    now: NOW,
    onDrop: (d) => rampDrops.push(d),
    ...mkSched({ headway: 20, priorActive: 0 }),
  });
  assert.equal(rampDrops[0].reason, 'ramp_up');

  const windDrops = [];
  detectThinGaps({
    routes: ['100'],
    getObservations: () => [],
    now: NOW,
    onDrop: (d) => windDrops.push(d),
    ...mkSched({ headway: 20, nextActive: 0 }),
  });
  assert.equal(windDrops[0].reason, 'wind_down');
});

test('window grows past 60 min when 2× headway exceeds the floor', () => {
  const events = detectThinGaps({
    routes: ['rare'],
    getObservations: () => [],
    now: NOW,
    ...mkSched({ headway: 45 }),
  });
  assert.equal(events[0].windowMin, 90);
  assert.equal(events[0].missedTrips, 2);
});

// --- MARTA disruption lifecycle + web export surfacing ---

test('observed-thin firing surfaces as a standalone bot incident, then resolves', () => {
  const ts = NOW;
  incidents.recordDisruption(
    {
      kind: 'bus',
      line: '809',
      source: 'observed-thin',
      posted: true,
      postUri: 'at://did:plc:test/app.bsky.feed.post/thin809',
      evidence: { headwayMin: 30, windowMin: 60, missedTrips: 2 },
    },
    ts,
  );

  let out = buildExport(storage.getDb(), ts + 1000);
  const inc = out.incidents.find((i) => i.detections?.some((d) => d.source === 'thin-gap'));
  assert.ok(inc, 'thin-gap incident present');
  assert.deepEqual(inc.sources, ['bot']);
  assert.equal(inc.mode, 'bus');
  assert.deepEqual(inc.routes, ['809']);
  assert.equal(inc.lifecycle.active, true);

  // Buses observed again → observed-clear resolves it.
  incidents.recordDisruption(
    { kind: 'bus', line: '809', source: 'observed-clear', posted: true, postUri: 'x' },
    ts + 20 * 60_000,
  );
  out = buildExport(storage.getDb(), ts + 21 * 60_000);
  const resolved = out.incidents.find((i) => i.detections?.some((d) => d.source === 'thin-gap'));
  assert.equal(resolved.lifecycle.active, false);
  assert.equal(resolved.lifecycle.resolved_ts, ts + 20 * 60_000);
});

test('findUnresolvedDisruptions returns open firings and skips cleared ones', () => {
  incidents.recordDisruption(
    { kind: 'bus', line: '700', source: 'observed-thin', posted: true, postUri: 'at://p/700' },
    NOW,
  );
  let open = incidents.findUnresolvedDisruptions(
    { kind: 'bus', source: 'observed-thin', sinceMs: 24 * 60 * 60 * 1000 },
    NOW + 1000,
  );
  assert.ok(open.some((r) => r.line === '700'));
  incidents.recordDisruption(
    { kind: 'bus', line: '700', source: 'observed-clear', posted: false, postUri: null },
    NOW + 5 * 60_000,
  );
  open = incidents.findUnresolvedDisruptions(
    { kind: 'bus', source: 'observed-thin', sinceMs: 24 * 60 * 60 * 1000 },
    NOW + 6 * 60_000,
  );
  assert.ok(!open.some((r) => r.line === '700'));
});

test('bin --check resolves all imports', () => {
  const bin = Path.join(__dirname, '..', '..', 'bin', 'marta', 'bus', 'thin-gaps.js');
  const res = spawnSync(process.execPath, [bin, '--check'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /imports resolved/);
});
