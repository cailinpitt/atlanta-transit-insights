const test = require('node:test');
const assert = require('node:assert/strict');
const Path = require('node:path');
const Fs = require('node:fs');
const Os = require('node:os');
const {
  extractCanceledTrips,
  summarizeByRoute,
  buildCancellationDigest,
} = require('../../src/marta/bus/cancellations');
const { graphemeLength } = require('../../src/shared/post');

test('extractCanceledTrips dedups by (trip_id, service_date) and ignores non-CANCELED', () => {
  const rows = [
    { tripId: 't1', route: '49', startDate: '20260617', tripRelationship: 'CANCELED' },
    { tripId: 't1', route: '49', startDate: '20260617', tripRelationship: 'CANCELED' }, // dup snapshot
    { tripId: 't2', route: '49', startDate: '20260617', tripRelationship: 'CANCELED' },
    { tripId: 't3', route: '84', startDate: '20260617', tripRelationship: 'CANCELED' },
    { tripId: 't9', route: '84', startDate: '20260617', tripRelationship: 'SCHEDULED' },
    { tripId: 't1', route: '49', startDate: '20260618', tripRelationship: 'CANCELED' }, // new day = new trip
  ];
  const canceled = extractCanceledTrips(rows);
  assert.equal(canceled.length, 4);
});

test('summarizeByRoute counts per route, sorted by count then numeric route', () => {
  const sum = summarizeByRoute([
    { tripId: 'a', route: '84' },
    { tripId: 'b', route: '49' },
    { tripId: 'c', route: '49' },
    { tripId: 'd', route: '12' },
  ]);
  assert.equal(sum.totalTrips, 4);
  assert.equal(sum.routeCount, 3);
  assert.deepEqual(sum.perRoute[0], { route: '49', count: 2 });
  // ties broken numerically: 12 before 84
  assert.deepEqual(
    sum.perRoute.slice(1).map((r) => r.route),
    ['12', '84'],
  );
});

test('buildCancellationDigest is null when empty and fits 300 graphemes when huge', () => {
  assert.equal(buildCancellationDigest(summarizeByRoute([])), null);
  const many = [];
  for (let i = 0; i < 60; i++) many.push({ tripId: `t${i}`, route: String(100 + i) });
  const text = buildCancellationDigest(summarizeByRoute(many));
  assert.ok(graphemeLength(text) <= 300, `digest too long: ${graphemeLength(text)}`);
  assert.match(text, /more routes/);
  assert.match(text, /60 trips across 60 routes/);
});

// --- Bin lifecycle against a temp DB, Bluesky faked via the bin's io ---

const BIN = Path.resolve(__dirname, '../../bin/marta/bus/cancellations.js');
const STORE = Path.resolve(__dirname, '../../src/marta/bus/cancellationStore.js');
const STORAGE = Path.resolve(__dirname, '../../src/marta/storage.js');
const INCIDENTS = Path.resolve(__dirname, '../../src/marta/shared/incidents.js');
const RUNBIN = Path.resolve(__dirname, '../../src/marta/shared/runBin.js');
const MODS = [STORAGE, INCIDENTS, STORE, RUNBIN, BIN];

function loadBinWithTempDb() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'marta-bus-cancel-'));
  process.env.MARTA_HISTORY_DB_PATH = Path.join(dir, 'marta.sqlite');
  delete process.env.MARTA_ALERTS_DRY_RUN;
  for (const m of MODS) delete require.cache[m];
  const bin = require(BIN);
  const storage = require(STORAGE);

  const posts = [];
  Object.assign(bin.io, {
    loginAlerts: async () => ({ fake: true }),
    postText: async (_agent, text) => {
      const uri = `at://did/app.bsky.feed.post/rk${posts.length + 1}`;
      posts.push({ text, uri });
      return { uri, cid: `cid${posts.length}`, url: `https://bsky.app/${uri}` };
    },
  });

  // Seed bus_trip_status directly (the bin reads it via getRecentBusTripStatuses).
  const db = storage.getDb();
  const seed = (rows, ts) => {
    const stmt = db.prepare(
      'INSERT INTO bus_trip_status (ts, trip_id, route, trip_relationship, start_date) VALUES (?,?,?,?,?)',
    );
    for (const r of rows) stmt.run(ts, r.tripId, r.route, r.rel || 'CANCELED', r.day || '20260617');
  };
  return { bin, posts, seed };
}

test('bin posts ONE digest of new cancellations and dedups across runs', async () => {
  const { bin, posts, seed } = loadBinWithTempDb();
  // Near real now: setup() rolls off bus_trip_status on the real 7-day clock.
  const now = Date.now();

  // Two snapshots of the same canceled trips → one digest, deduped counts.
  seed(
    [
      { tripId: 'a', route: '49' },
      { tripId: 'b', route: '84' },
    ],
    now - 60_000,
  );
  seed(
    [
      { tripId: 'a', route: '49' },
      { tripId: 'b', route: '84' },
    ],
    now - 30_000,
  );
  await bin.main({ now });
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /2 trips across 2 routes/);

  // Re-run with no new data → silent (already reported).
  await bin.main({ now: now + 1000 });
  assert.equal(posts.length, 1);

  // A NEW cancellation appears → only it is reported.
  seed([{ tripId: 'c', route: '12' }], now + 2000);
  await bin.main({ now: now + 3000 });
  assert.equal(posts.length, 2);
  assert.match(posts[1].text, /1 trip across 1 route/);
  assert.match(posts[1].text, /Route 12/);
});

test('bin stays silent when there are no cancellations', async () => {
  const { bin, posts } = loadBinWithTempDb();
  await bin.main({ now: 1_781_000_000_000 });
  assert.equal(posts.length, 0);
});
