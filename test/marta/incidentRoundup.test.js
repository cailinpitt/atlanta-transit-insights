const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');

const BIN = '../../bin/marta/incident-roundup';

test('scoreSignals matches CTA-style source dedupe and persistence bonus', () => {
  const { scoreSignals } = require(BIN);
  const result = scoreSignals([
    { source: 'gap', severity: 0.7 },
    { source: 'gap', severity: 0.8 },
    { source: 'bunching', severity: 0.8 },
  ]);
  assert.equal(result.bySource.get('gap').count, 2);
  assert.equal(Math.round(result.bySource.get('gap').contribution * 100) / 100, 0.95);
  assert.equal(Math.round(result.total * 100) / 100, 1.75);
});

test('ghostOverrideQualifies counts unexplained shortfall, not announced cancellations', () => {
  const { ghostOverrideQualifies } = require(BIN);
  // 4 of 6 missing but all 4 are MARTA-announced cancellations → does not qualify.
  assert.equal(
    ghostOverrideQualifies({
      source: 'ghost',
      detail: JSON.stringify({ missing: 4, expected: 6, canceledTrips: 4, unexplainedMissing: 0 }),
    }),
    false,
  );
  // 4 of 6 missing with none announced → genuine ghost, qualifies.
  assert.equal(
    ghostOverrideQualifies({
      source: 'ghost',
      detail: JSON.stringify({ missing: 4, expected: 6, canceledTrips: 0, unexplainedMissing: 4 }),
    }),
    true,
  );
  // Legacy/rail signals without cancellation context fall back to raw missing.
  assert.equal(
    ghostOverrideQualifies({
      source: 'ghost',
      detail: JSON.stringify({ missing: 4, expected: 6 }),
    }),
    true,
  );
});

test('buildRoundupText uses MARTA route and rail framing', () => {
  const { buildRoundupText } = require(BIN);
  const bus = buildRoundupText({
    kind: 'bus',
    line: '15',
    name: 'Clifton Road / Candler Road',
    signals: [
      { source: 'ghost', severity: 1, detail: JSON.stringify({ missing: 4, expected: 8 }) },
      { source: 'gap', severity: 0.8, detail: JSON.stringify({ ratio: 3.4 }) },
    ],
  });
  assert.match(bus, /Route 15 \(Clifton Road \/ Candler Road\)/);
  assert.match(bus, /multiple signals/);
  assert.match(bus, /buses missing/);

  const rail = buildRoundupText({
    kind: 'rail',
    line: 'RED',
    signals: [{ source: 'bunching', severity: 1, detail: JSON.stringify({ vehicles: 3 }) }],
  });
  assert.match(rail, /Red Line/);
  assert.match(rail, /trains recently bunched together/);
});

test('sweepResolutions posts threaded resolution from alerts account', async () => {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'marta-roundup-resolve-'));
  process.env.MARTA_HISTORY_DB_PATH = Path.join(dir, 'marta.sqlite');
  delete require.cache[require.resolve('../../src/marta/storage')];
  delete require.cache[require.resolve('../../src/marta/shared/incidents')];
  delete require.cache[require.resolve('../../src/marta/shared/state')];
  delete require.cache[require.resolve(BIN)];
  const storage = require('../../src/marta/storage');
  const incidents = require('../../src/marta/shared/incidents');
  const { sweepResolutions } = require(BIN);

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    headers: new Map(),
    arrayBuffer: async () => new ArrayBuffer(0),
  });

  try {
    const ROUNDUP_URI = 'at://did:plc:martaalerts/app.bsky.feed.post/roundup1';
    incidents.recordRoundupAnchor({
      kind: 'bus',
      line: '15',
      postUri: ROUNDUP_URI,
      postCid: 'cid-roundup',
      ts: 1_000,
    });

    const posts = [];
    const agent = {
      session: { did: 'did:plc:martaalerts' },
      com: {
        atproto: {
          repo: {
            getRecord: async () => ({ data: { uri: ROUNDUP_URI, cid: 'cid-roundup', value: {} } }),
          },
        },
      },
      post: async (req) => {
        const result = {
          uri: 'at://did:plc:martaalerts/app.bsky.feed.post/resolved1',
          cid: 'cid-resolved',
        };
        posts.push({ ...req, ...result });
        return result;
      },
    };

    await sweepResolutions({
      kind: 'bus',
      getName: () => 'Clifton Road / Candler Road',
      agentGetter: async () => agent,
      now: 2_000,
    });
    await sweepResolutions({
      kind: 'bus',
      getName: () => 'Clifton Road / Candler Road',
      agentGetter: async () => agent,
      now: 3_000,
    });
    assert.equal(posts.length, 0);
    await sweepResolutions({
      kind: 'bus',
      getName: () => 'Clifton Road / Candler Road',
      agentGetter: async () => agent,
      now: 4_000,
    });

    assert.equal(posts.length, 1);
    assert.match(posts[0].text, /service signals back to normal/);
    assert.equal(posts[0].reply.root.uri, ROUNDUP_URI);
    assert.equal(
      posts[0].embed.external.uri,
      'https://atlantatransitalerts.app/event/roundup1/resolved',
    );
    const row = incidents
      .getDb()
      .prepare('SELECT resolved_ts, resolution_post_uri FROM roundup_anchors')
      .get();
    assert.equal(row.resolved_ts, 2_000);
    assert.equal(row.resolution_post_uri, 'at://did:plc:martaalerts/app.bsky.feed.post/resolved1');
  } finally {
    global.fetch = originalFetch;
    storage.closeDb();
    delete process.env.MARTA_HISTORY_DB_PATH;
    delete require.cache[require.resolve('../../src/marta/storage')];
    delete require.cache[require.resolve('../../src/marta/shared/incidents')];
    delete require.cache[require.resolve('../../src/marta/shared/state')];
    delete require.cache[require.resolve(BIN)];
    Fs.rmSync(dir, { recursive: true, force: true });
  }
});
