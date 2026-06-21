const test = require('node:test');
const assert = require('node:assert/strict');
const Path = require('node:path');
const Fs = require('node:fs');
const Os = require('node:os');

// End-to-end orchestration of bin/marta/alerts.js against a temp DB with the
// feed / login / Bluesky boundaries faked via the bin's injectable `io`. Covers
// the post → refresh → feed-drop resolution lifecycle, the empty-feed flicker
// guard, and the still-in-feed-but-filtered silent close.

const BIN = Path.resolve(__dirname, '../../bin/marta/alerts.js');
const STORE = Path.resolve(__dirname, '../../src/marta/alert/store.js');
const STORAGE = Path.resolve(__dirname, '../../src/marta/storage.js');
const INCIDENTS = Path.resolve(__dirname, '../../src/marta/shared/incidents.js');
const RUNBIN = Path.resolve(__dirname, '../../src/marta/shared/runBin.js');
const MODS = [STORAGE, INCIDENTS, STORE, RUNBIN, BIN];

const railAlert = (over = {}) => ({
  id: 'r1',
  cause: 'MAINTENANCE',
  effect: 'NO_SERVICE',
  header: 'Red Line: No service between Airport and Five Points',
  description: 'Red Line trains are not running due to track maintenance.',
  informedEntities: [{ routeType: 1, routeId: 'RED' }],
  activePeriods: [{ start: 1_781_400_000, end: null }],
  ...over,
});
// Minor-only: elevator outage — should never post.
const elevatorAlert = {
  id: 'e1',
  effect: 'UNKNOWN_EFFECT',
  header: 'Elevator out of service at Five Points',
  description: 'The elevator is temporarily out of service.',
  informedEntities: [{ routeType: 1, routeId: 'RED', stopId: '100' }],
  activePeriods: [],
};

function loadBinWithTempDb() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'marta-alerts-flow-'));
  process.env.MARTA_HISTORY_DB_PATH = Path.join(dir, 'marta.sqlite');
  delete process.env.MARTA_ALERTS_DRY_RUN;
  for (const m of MODS) delete require.cache[m];
  const bin = require(BIN);
  const store = require(STORE);
  const storage = require(STORAGE);

  const posts = [];
  let feed = [];
  Object.assign(bin.io, {
    fetchAlerts: async () => ({ feedTimestamp: 1_781_400_000, alerts: feed }),
    loginAlerts: async () => ({ fake: true }),
    postText: async (_agent, text, replyRef) => {
      const uri = `at://did/app.bsky.feed.post/rk${posts.length + 1}`;
      posts.push({ text, replyRef: replyRef || null, uri });
      return { uri, cid: `cid${posts.length}`, url: `https://bsky.app/${uri}` };
    },
    postWithExternal: async (_agent, text, link, replyRef) => {
      const uri = `at://did/app.bsky.feed.post/rk${posts.length + 1}`;
      posts.push({ text, link, replyRef: replyRef || null, uri });
      return { uri, cid: `cid${posts.length}`, url: `https://bsky.app/${uri}` };
    },
    resolveReplyRef: async (_agent, uri) => ({ root: { uri }, parent: { uri } }),
  });

  return {
    bin,
    store,
    posts,
    setFeed: (f) => {
      feed = f;
    },
    cleanup: () => {
      try {
        storage.closeDb();
      } catch (_e) {
        /* ignore */
      }
      for (const m of MODS) delete require.cache[m];
      delete process.env.MARTA_HISTORY_DB_PATH;
      try {
        Fs.rmSync(dir, { recursive: true, force: true });
      } catch (_e) {
        /* ignore */
      }
    },
  };
}

test('significant alert posts once; minor-only alert is filtered out', async () => {
  const { bin, store, posts, setFeed, cleanup } = loadBinWithTempDb();
  try {
    setFeed([railAlert(), elevatorAlert]);
    await bin.main({ now: 1000 });

    assert.equal(posts.length, 1, 'only the rail suspension posts');
    assert.match(posts[0].text, /Red Line/);
    assert.equal(posts[0].replyRef, null);

    const row = store.getAlertPost('r1');
    assert.equal(row.mode, 'rail');
    assert.equal(row.routes, 'RED');
    assert.equal(row.post_uri, posts[0].uri);
    assert.equal(row.resolved_ts, null);
    assert.equal(store.getAlertPost('e1'), null, 'minor alert never recorded');
  } finally {
    cleanup();
  }
});

test('re-seen alert does not double-post and refreshes last_seen', async () => {
  const { bin, store, posts, setFeed, cleanup } = loadBinWithTempDb();
  try {
    setFeed([railAlert()]);
    await bin.main({ now: 1000 });
    await bin.main({ now: 2000 });

    assert.equal(posts.length, 1, 'no duplicate post on the second tick');
    const row = store.getAlertPost('r1');
    assert.equal(row.last_seen_ts, 2000);
    assert.equal(row.first_seen_ts, 1000);
  } finally {
    cleanup();
  }
});

test('feed-drop posts a threaded resolution after the clear-tick threshold', async () => {
  const { bin, store, posts, setFeed, cleanup } = loadBinWithTempDb();
  try {
    setFeed([railAlert()]);
    await bin.main({ now: 1000 });
    assert.equal(posts.length, 1);

    // Alert gone, but the feed is non-empty (another alert present) so the sweep
    // runs. Advance clear ticks; no resolution until the threshold.
    const other = railAlert({ id: 'x', header: 'Gold Line single-tracking', routes: 'GOLD' });
    other.informedEntities = [{ routeType: 1, routeId: 'GOLD' }];
    setFeed([other]);
    await bin.main({ now: 2000 });
    await bin.main({ now: 3000 });
    assert.equal(store.getAlertPost('r1').clear_ticks, 2);
    assert.equal(posts.filter((p) => p.replyRef).length, 0, 'no resolution yet');

    await bin.main({ now: 4000 }); // third missing tick → resolve
    const resolutions = posts.filter((p) => p.replyRef);
    assert.equal(resolutions.length, 1);
    assert.match(resolutions[0].text, /resolved/i);
    assert.match(resolutions[0].text, /https:\/\/atlantatransitalerts\.app\/event\/rk1\/resolved/);
    assert.equal(resolutions[0].link.url, 'https://atlantatransitalerts.app/event/rk1/resolved');
    assert.deepEqual(resolutions[0].replyRef, {
      root: { uri: posts[0].uri },
      parent: { uri: posts[0].uri },
    });

    const row = store.getAlertPost('r1');
    assert.equal(row.resolved_ts, 2000, 'backdated to the first missing tick');
    assert.equal(row.resolved_reply_uri, resolutions[0].uri);
  } finally {
    cleanup();
  }
});

test('a rail cancellation is silently closed on feed-drop (no "resolved" reply)', async () => {
  const { bin, store, posts, setFeed, cleanup } = loadBinWithTempDb();
  try {
    const cancel = railAlert({
      id: 'c1',
      effect: 'REDUCED_SERVICE',
      header: 'Rail Service Alert for Blue Line',
      description:
        'Update: Due to a previous issue on a Blue line train, the 3:59 p.m. Blue line departure from Indian Creek is cancelled. Delays continuing on the Blue line.',
    });
    cancel.informedEntities = [{ routeType: 1, routeId: 'BLUE' }];
    setFeed([cancel]);
    await bin.main({ now: 1000 });
    assert.equal(posts.length, 1, 'cancellation posts once');

    // Drops from feed; another alert keeps the feed non-empty so the sweep runs.
    const other = railAlert({ id: 'x', header: 'Gold Line single-tracking' });
    other.informedEntities = [{ routeType: 1, routeId: 'GOLD' }];
    setFeed([other]);
    await bin.main({ now: 2000 });
    await bin.main({ now: 3000 });
    await bin.main({ now: 4000 }); // threshold tick → would resolve, but it's a cancellation

    assert.equal(
      posts.filter((p) => p.replyRef).length,
      0,
      'no resolution reply for a cancellation',
    );
    const row = store.getAlertPost('c1');
    assert.ok(row.resolved_ts != null, 'silently closed');
    assert.equal(row.resolved_reply_uri, null);
  } finally {
    cleanup();
  }
});

test('a continuation alert replies in one thread; the chain closes silently', async () => {
  const { bin, store, posts, setFeed, cleanup } = loadBinWithTempDb();
  try {
    const T0 = 1_000_000;
    const delays = {
      id: 'sc-delay',
      source: 'otp',
      effect: null,
      header: 'Streetcar delays',
      description: 'Heavy traffic delays in Streetcar service.',
      informedEntities: [{ routeType: 0, routeId: 'ATLSC' }],
      activePeriods: [],
    };
    setFeed([delays]);
    await bin.main({ now: T0 });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].replyRef, null, 'first alert opens a new thread');
    const rootUri = posts[0].uri;

    // MARTA's "all clear" follow-up arrives as a NEW alert_id ~3 min later.
    const clear = {
      id: 'sc-clear',
      source: 'otp',
      effect: null,
      header: 'Streetcar service alert',
      description: 'Update: Streetcars resumed normal schedule.',
      informedEntities: [{ routeType: 0, routeId: 'ATLSC' }],
      activePeriods: [],
    };
    setFeed([delays, clear]);
    await bin.main({ now: T0 + 3 * 60_000 });
    assert.equal(posts.length, 2);
    // Posted as a reply under the first thread's root, not a new top-level post.
    assert.deepEqual(posts[1].replyRef, { root: { uri: rootUri }, parent: { uri: rootUri } });
    assert.equal(store.getAlertPost('sc-clear').thread_root_uri, rootUri);

    // Both drop from the feed. Keep an unrelated alert present so the sweep runs.
    const other = {
      id: 'gold',
      source: 'otp',
      effect: 'NO_SERVICE',
      header: 'Gold Line single-tracking',
      description: 'Single tracking on the Gold line.',
      informedEntities: [{ routeType: 1, routeId: 'GOLD' }],
      activePeriods: [],
    };
    setFeed([other]);
    const t = T0 + 3 * 60_000;
    await bin.main({ now: t + 60_000 });
    await bin.main({ now: t + 120_000 });
    await bin.main({ now: t + 180_000 }); // third missing tick → resolution sweep

    // Neither streetcar member posts a public "✅ resolved" reply: the delay has a
    // later chain member, and the clear is all-clear text. Both close silently.
    const resolutionReplies = posts.filter((p) => p.replyRef && /resolved/i.test(p.text));
    assert.equal(resolutionReplies.length, 0, 'no redundant resolution reply on the chain');
    assert.notEqual(store.getAlertPost('sc-delay').resolved_ts, null);
    assert.notEqual(store.getAlertPost('sc-clear').resolved_ts, null);
  } finally {
    cleanup();
  }
});

test('empty feed skips the resolution sweep (flicker guard)', async () => {
  const { bin, store, posts, setFeed, cleanup } = loadBinWithTempDb();
  try {
    setFeed([railAlert()]);
    await bin.main({ now: 1000 });

    setFeed([]); // MARTA momentarily returns nothing
    await bin.main({ now: 2000 });

    assert.equal(store.getAlertPost('r1').clear_ticks, 0, 'no clear tick on empty feed');
    assert.equal(posts.filter((p) => p.replyRef).length, 0, 'no resolution');
    assert.equal(store.listUnresolvedAlerts().length, 1, 'still unresolved');
  } finally {
    cleanup();
  }
});

test('alert still in feed but no longer significant is closed silently', async () => {
  const { bin, store, posts, setFeed, cleanup } = loadBinWithTempDb();
  try {
    setFeed([railAlert()]);
    await bin.main({ now: 1000 });
    assert.equal(posts.length, 1);

    // Same id, but now its text only trips minor patterns → filtered. Another
    // alert keeps the feed non-empty so the sweep runs.
    const downgraded = railAlert({
      effect: 'UNKNOWN_EFFECT',
      header: 'Red Line elevator update',
      description: 'Elevator maintenance ongoing at Five Points.',
    });
    const other = railAlert({ id: 'x', header: 'Gold Line single-tracking' });
    other.informedEntities = [{ routeType: 1, routeId: 'GOLD' }];
    setFeed([downgraded, other]);
    await bin.main({ now: 2000 });

    assert.equal(posts.filter((p) => p.replyRef).length, 0, 'no "resolved" reply');
    const row = store.getAlertPost('r1');
    assert.ok(row.resolved_ts != null, 'silently closed');
    assert.equal(row.resolved_reply_uri, null);
  } finally {
    cleanup();
  }
});
