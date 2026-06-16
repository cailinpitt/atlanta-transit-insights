// Decaying-margin + sustained-severity gap cooldown override, ported from
// cta-insights test/shared/gapCooldownAllows.test.js so MARTA stays aligned.
const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');

const TMP_DB = Path.join(Os.tmpdir(), `marta-gapcd-test-${process.pid}-${Date.now()}.sqlite`);
process.env.MARTA_HISTORY_DB_PATH = TMP_DB;

const storage = require('../../src/marta/storage');
const { gapCooldownAllows, recordGap } = require('../../src/marta/shared/incidents');

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

function postedRatio(kind, route, ratio, now = Date.now()) {
  recordGap(
    {
      kind,
      route,
      direction: '5',
      gapFt: 5000,
      gapMin: ratio * 5,
      expectedMin: 5,
      ratio,
      nearStop: 'X',
      posted: true,
    },
    now,
  );
}

test('no prior posts → allows', () => {
  assert.equal(
    gapCooldownAllows({ kind: 'bus', route: 'cd-empty', candidate: { ratio: 3.0 } }),
    true,
  );
});

test('candidate == prior fails (fresh)', () => {
  postedRatio('bus', 'cd-1', 3.0);
  assert.equal(gapCooldownAllows({ kind: 'bus', route: 'cd-1', candidate: { ratio: 3.0 } }), false);
});

test('1.1× prior fails (under fresh 1.25× margin)', () => {
  postedRatio('bus', 'cd-2', 3.0);
  assert.equal(gapCooldownAllows({ kind: 'bus', route: 'cd-2', candidate: { ratio: 3.3 } }), false);
});

test('just under 1.25× still fails', () => {
  postedRatio('bus', 'cd-3', 3.0);
  assert.equal(
    gapCooldownAllows({ kind: 'bus', route: 'cd-3', candidate: { ratio: 3.74 } }),
    false,
  );
});

test('> 1.25× fresh margin passes', () => {
  postedRatio('bus', 'cd-4', 3.0);
  assert.equal(gapCooldownAllows({ kind: 'bus', route: 'cd-4', candidate: { ratio: 3.76 } }), true);
});

test('must beat ALL prior posts in window', () => {
  postedRatio('rail', 'cd-5', 3.0);
  postedRatio('rail', 'cd-5', 5.0);
  assert.equal(
    gapCooldownAllows({ kind: 'rail', route: 'cd-5', candidate: { ratio: 4.5 } }),
    false,
  );
  assert.equal(gapCooldownAllows({ kind: 'rail', route: 'cd-5', candidate: { ratio: 6.5 } }), true);
});

test('decayed margin lets a smaller bump through later in cooldown', () => {
  const fortyFiveMinAgo = Date.now() - 45 * 60 * 1000;
  postedRatio('rail', 'cd-decay', 2.7, fortyFiveMinAgo);
  // 3.31 / 2.70 = 1.226× — fails the fresh 1.25× margin but clears the decayed
  // margin (~1.14×) at t=0.75 through the cooldown window.
  assert.equal(
    gapCooldownAllows({ kind: 'rail', route: 'cd-decay', candidate: { ratio: 3.31 } }),
    true,
  );
});

test('sustained-severity floor fires after 20 min at ≥ 3.0×', () => {
  const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
  postedRatio('rail', 'cd-sustained', 3.64, thirtyMinAgo);
  // 3.06 is LOWER than prior (no escalation) so the margin gate fails, but
  // ≥20 min elapsed AND ≥3.0× → sustained floor allows the follow-up.
  assert.equal(
    gapCooldownAllows({ kind: 'rail', route: 'cd-sustained', candidate: { ratio: 3.06 } }),
    true,
  );
});

test('sustained floor blocked when ratio drops below 3.0', () => {
  const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
  postedRatio('rail', 'cd-belowfloor', 3.5, thirtyMinAgo);
  assert.equal(
    gapCooldownAllows({ kind: 'rail', route: 'cd-belowfloor', candidate: { ratio: 2.8 } }),
    false,
  );
});

test('sustained floor blocked when elapsed < 20 min', () => {
  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  postedRatio('rail', 'cd-tooEarly', 3.5, tenMinAgo);
  assert.equal(
    gapCooldownAllows({ kind: 'rail', route: 'cd-tooEarly', candidate: { ratio: 3.5 } }),
    false,
  );
});

test('outside withinMs window is ignored', () => {
  const longAgo = Date.now() - 2 * 60 * 60 * 1000;
  postedRatio('bus', 'cd-6', 5.0, longAgo);
  assert.equal(
    gapCooldownAllows({
      kind: 'bus',
      route: 'cd-6',
      candidate: { ratio: 1.0 },
      withinMs: 60 * 60 * 1000,
    }),
    true,
  );
});
