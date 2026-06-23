const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');

const TMP_DB = Path.join(Os.tmpdir(), `marta-relquotes-test-${process.pid}-${Date.now()}.sqlite`);
process.env.MARTA_HISTORY_DB_PATH = TMP_DB;
process.env.QUOTE_RELATED_POSTS = '1';

const storage = require('../../src/marta/storage');
const incidents = require('../../src/marta/shared/incidents');
const alerts = require('../../src/marta/alert/store');
const { sweepRelatedQuotes, alertKind } = require('../../src/marta/shared/relatedQuotes');

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
const ALERTS_DID = 'did:plc:martaalerts';
const ROUNDUP_URI = `at://${ALERTS_DID}/app.bsky.feed.post/roundupRED`;
const GAP_URI = 'at://did:plc:martatrain/app.bsky.feed.post/gapRED';
const BUNCH_URI = 'at://did:plc:martabus/app.bsky.feed.post/bunch20';

// Fake Bluesky agent: getRecord echoes a deterministic cid per rkey, post()
// records calls and returns a synthetic at:// uri/cid so postUrl() is happy.
function makeAgent() {
  const posted = [];
  const known = new Set([ROUNDUP_URI, GAP_URI, BUNCH_URI]);
  let n = 0;
  return {
    posted,
    com: {
      atproto: {
        repo: {
          getRecord: async ({ repo, collection, rkey }) => {
            const uri = `at://${repo}/${collection}/${rkey}`;
            if (!known.has(uri)) throw new Error('not found');
            // Anchors/sources are top-level posts (no reply.root).
            return { data: { cid: `cid-${rkey}`, value: {} } };
          },
        },
      },
    },
    post: async (record) => {
      n += 1;
      const uri = `at://${ALERTS_DID}/app.bsky.feed.post/quote${n}`;
      posted.push({ record, uri, cid: `cid-quote${n}` });
      // The just-authored quote is now resolvable for the linear-thread chaining.
      known.add(uri);
      return { uri, cid: `cid-quote${n}` };
    },
  };
}

test('alertKind maps modes onto detector kinds', () => {
  assert.equal(alertKind('bus'), 'bus');
  assert.equal(alertKind('rail'), 'rail');
  assert.equal(alertKind('streetcar'), 'rail');
  assert.equal(alertKind('general'), null);
});

test('rail roundup anchor quote-attaches a same-line gap observation', async () => {
  incidents.recordRoundupAnchor({
    kind: 'rail',
    line: 'RED',
    postUri: ROUNDUP_URI,
    postCid: 'cid-roundupRED',
    ts: NOW - 5 * 60_000,
    signals: ['gap'],
    bullets: [],
  });
  incidents.recordGap(
    {
      kind: 'rail',
      route: 'RED',
      direction: 'N',
      gapFt: 20000,
      gapMin: 22,
      expectedMin: 8,
      ratio: 2.75,
      nearStop: 'Five Points',
      posted: true,
      postUri: GAP_URI,
    },
    NOW - 3 * 60_000,
  );

  const agent = makeAgent();
  const res = await sweepRelatedQuotes({ kind: 'rail', agent, now: NOW });

  assert.equal(res.posted, 1);
  assert.equal(agent.posted.length, 1);
  const rec = agent.posted[0].record;
  assert.equal(rec.embed.$type, 'app.bsky.embed.record');
  assert.equal(rec.embed.record.uri, GAP_URI);
  // Threaded under the roundup anchor.
  assert.equal(rec.reply.root.uri, ROUNDUP_URI);
  assert.equal(rec.reply.parent.uri, ROUNDUP_URI);
});

test('the same observation is not quoted twice into one thread', async () => {
  const agent = makeAgent();
  const res = await sweepRelatedQuotes({ kind: 'rail', agent, now: NOW });
  assert.equal(res.posted, 0);
  assert.equal(agent.posted.length, 0);
});

test('a bus observation never attaches to a rail thread (route/kind scoped)', async () => {
  incidents.recordBunching(
    {
      kind: 'bus',
      route: '20',
      direction: '0',
      vehicleCount: 3,
      severityFt: 600,
      nearStop: 'Midtown',
      posted: true,
      postUri: BUNCH_URI,
    },
    NOW - 2 * 60_000,
  );
  // No bus anchor exists, so the bus sweep finds nothing to attach to.
  const agent = makeAgent();
  const res = await sweepRelatedQuotes({ kind: 'bus', agent, now: NOW });
  assert.equal(res.posted, 0);
});

test('an official rail alert anchors a same-line ghost observation', async () => {
  const ALERT_URI = `at://${ALERTS_DID}/app.bsky.feed.post/alertGOLD`;
  const GHOST_URI = 'at://did:plc:martatrain/app.bsky.feed.post/ghostGOLD';
  alerts.recordAlertSeen(
    {
      alertId: 'alert-gold-1',
      mode: 'rail',
      routes: 'GOLD',
      headline: 'Gold Line delays',
      description: 'Residual delays single-tracking near Lindbergh.',
      postUri: ALERT_URI,
    },
    NOW - 6 * 60_000,
  );
  incidents.recordGhostEvent({
    kind: 'rail',
    route: 'GOLD',
    direction: 'S',
    observed: 2,
    expected: 5,
    missing: 3,
    postUri: GHOST_URI,
    ts: NOW - 4 * 60_000,
  });

  // Teach the fake agent about these URIs.
  const agent = makeAgent();
  agent.com.atproto.repo.getRecord = async ({ repo, collection, rkey }) => {
    const uri = `at://${repo}/${collection}/${rkey}`;
    if (uri === ALERT_URI || uri === GHOST_URI || uri.includes('/post/quote')) {
      return { data: { cid: `cid-${rkey}`, value: {} } };
    }
    throw new Error('not found');
  };

  const res = await sweepRelatedQuotes({ kind: 'rail', agent, now: NOW });
  assert.equal(res.posted, 1);
  assert.equal(agent.posted[0].record.embed.record.uri, GHOST_URI);
  assert.equal(agent.posted[0].record.reply.root.uri, ALERT_URI);
});

test('disabling via QUOTE_RELATED_POSTS=0 short-circuits the sweep', async () => {
  process.env.QUOTE_RELATED_POSTS = '0';
  const agent = makeAgent();
  const res = await sweepRelatedQuotes({ kind: 'rail', agent, now: NOW });
  process.env.QUOTE_RELATED_POSTS = '1';
  assert.deepEqual(res, { groups: 0, posted: 0 });
  assert.equal(agent.posted.length, 0);
});
