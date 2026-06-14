const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');

// Point storage at a throwaway DB BEFORE requiring it (path read on first getDb).
const TMP_DB = Path.join(Os.tmpdir(), `marta-alertstore-test-${process.pid}-${Date.now()}.sqlite`);
process.env.MARTA_HISTORY_DB_PATH = TMP_DB;

const storage = require('../../src/marta/storage');
// Destructured directly from require so knip counts the test-only members of the
// store's public API (it tracks `const { x } = require(...)`, not member access).
const {
  recordAlertSeen,
  getAlertPost,
  getAlertVersions,
  listUnresolvedAlerts,
  recordAlertResolved,
  incrementAlertClearTicks,
  ALERT_CLEAR_TICKS,
  ALERT_FLICKER_RESET_MS,
} = require('../../src/marta/alert/store');

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

const seed = (over = {}) => ({
  alertId: 'a1',
  mode: 'rail',
  routes: 'RED',
  headline: 'Red Line suspended',
  description: 'No service between stations.',
  cause: 'MAINTENANCE',
  effect: 'NO_SERVICE',
  activeStartTs: 1000,
  activeEndTs: null,
  postUri: null,
  ...over,
});

test('first sighting creates a row and a version', () => {
  recordAlertSeen(seed(), 100);
  const row = getAlertPost('a1');
  assert.equal(row.mode, 'rail');
  assert.equal(row.headline, 'Red Line suspended');
  assert.equal(row.first_seen_ts, 100);
  assert.equal(row.last_seen_ts, 100);
  assert.equal(row.resolved_ts, null);
  const versions = getAlertVersions('a1');
  assert.equal(versions.length, 1);
  assert.equal(versions[0].headline, 'Red Line suspended');
});

test('post-post write preserves post_uri; unchanged text adds no version', () => {
  recordAlertSeen(seed({ postUri: 'at://post/1' }), 200);
  let row = getAlertPost('a1');
  assert.equal(row.post_uri, 'at://post/1');
  // A later null-postUri sighting must NOT wipe the stored URI (COALESCE).
  recordAlertSeen(seed({ postUri: null }), 300);
  row = getAlertPost('a1');
  assert.equal(row.post_uri, 'at://post/1');
  assert.equal(row.last_seen_ts, 300);
  // Same text across all three sightings → still one version row.
  assert.equal(getAlertVersions('a1').length, 1);
});

test('changed description logs a new version', () => {
  recordAlertSeen(seed({ description: 'Service restoring; residual delays.' }), 400);
  const versions = getAlertVersions('a1');
  assert.equal(versions.length, 2);
  assert.equal(versions[1].description, 'Service restoring; residual delays.');
  // COALESCE keeps prior non-null columns when the incoming value is null.
  recordAlertSeen(seed({ description: null, headline: null }), 410);
  const row = getAlertPost('a1');
  assert.equal(row.description, 'Service restoring; residual delays.');
  assert.equal(row.headline, 'Red Line suspended');
});

test('clear-tick resolution backdates resolved_ts to the first missing tick', () => {
  assert.deepEqual(
    listUnresolvedAlerts().map((r) => r.alert_id),
    ['a1'],
  );
  const t1 = incrementAlertClearTicks('a1', 1000);
  assert.equal(t1, 1);
  const t2 = incrementAlertClearTicks('a1', 1060);
  assert.equal(t2, 2);
  assert.equal(ALERT_CLEAR_TICKS, 3);
  // Threshold reached; resolve at a later wall-clock time but expect the
  // backdated first-missing-tick value.
  recordAlertResolved({ alertId: 'a1', replyUri: 'at://reply/1' }, 9999);
  const row = getAlertPost('a1');
  assert.equal(row.resolved_ts, 1000);
  assert.equal(row.resolved_reply_uri, 'at://reply/1');
  assert.equal(listUnresolvedAlerts().length, 0);
});

test('short flicker reopen clears resolved_ts but keeps the resolution reply uri', () => {
  // Re-listed within the flicker window → same incident, not a new chapter.
  recordAlertSeen(seed(), 11000);
  const row = getAlertPost('a1');
  assert.equal(row.resolved_ts, null, 'reopened');
  assert.equal(row.clear_ticks, 0);
  assert.equal(row.resolved_reply_uri, 'at://reply/1', 'kept to avoid duplicate clear reply');
  assert.equal(listUnresolvedAlerts().length, 1);
});

test('new chapter after the flicker window clears the prior resolution reply', () => {
  recordAlertResolved({ alertId: 'a1', replyUri: 'at://reply/2' }, 12000);
  // Re-list well beyond ALERT_FLICKER_RESET_MS → fresh incident under same id.
  const farLater = 12000 + ALERT_FLICKER_RESET_MS + 1;
  recordAlertSeen(seed(), farLater);
  const row = getAlertPost('a1');
  assert.equal(row.resolved_ts, null);
  assert.equal(row.resolved_reply_uri, null);
});
