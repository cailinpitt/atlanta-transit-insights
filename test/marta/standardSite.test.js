const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// STATE_PATH is resolved at module load, so point it at a temp file first.
const STATE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'std-site-')),
  'standard-site.json',
);
process.env.MARTA_STANDARD_SITE_STATE = STATE_PATH;

const {
  ensurePublication,
  ensureDocument,
  buildAssociatedRefs,
  publicationUri,
  documentUri,
  loadState,
} = require('../../src/marta/shared/standardSite');

const DID = 'did:plc:alertsaccount';

function fakeAgent() {
  const writes = [];
  let n = 0;
  return {
    writes,
    did: DID,
    com: {
      atproto: {
        repo: {
          putRecord: async ({ repo, collection, rkey, record }) => {
            writes.push({ repo, collection, rkey, record });
            return { data: { uri: `at://${repo}/${collection}/${rkey}`, cid: `cid-${++n}` } };
          },
        },
      },
    },
  };
}

test('ensurePublication writes the self record once and is idempotent', async () => {
  const agent = fakeAgent();
  const a = await ensurePublication(agent);
  assert.equal(a.uri, publicationUri(DID));
  assert.equal(agent.writes.length, 1);
  assert.equal(agent.writes[0].rkey, 'self');
  assert.equal(agent.writes[0].record.$type, 'site.standard.publication');
  assert.equal(agent.writes[0].record.url, 'https://atlantatransitalerts.app');

  // Same content => no second network write.
  const b = await ensurePublication(agent);
  assert.equal(agent.writes.length, 1);
  assert.equal(b.cid, a.cid);
});

test('ensureDocument keys by event rkey and sets a matching path', async () => {
  const agent = fakeAgent();
  await ensurePublication(agent);
  const doc = await ensureDocument(agent, {
    rkey: '3moxujfr7mp2v',
    title: 'Red Line single-tracking',
    description: 'Delays between Midtown and Lindbergh.',
    publishedAt: 1700000000000,
  });
  assert.equal(doc.uri, documentUri(DID, '3moxujfr7mp2v'));
  const write = agent.writes.find((w) => w.collection === 'site.standard.document');
  assert.equal(write.rkey, '3moxujfr7mp2v');
  assert.equal(write.record.path, '/event/3moxujfr7mp2v');
  assert.equal(write.record.site, publicationUri(DID));
  assert.equal(write.record.publishedAt, new Date(1700000000000).toISOString());
  assert.equal(write.record.title, 'Red Line single-tracking');

  // Unchanged content => idempotent.
  const before = agent.writes.length;
  await ensureDocument(agent, {
    rkey: '3moxujfr7mp2v',
    title: 'Red Line single-tracking',
    description: 'Delays between Midtown and Lindbergh.',
    publishedAt: 1700000000000,
  });
  assert.equal(agent.writes.length, before);
});

test('ensureDocument is skip-on-existence: changed content does NOT re-put (stable cid)', async () => {
  const agent = fakeAgent();
  await ensurePublication(agent);
  const first = await ensureDocument(agent, { rkey: 'stable1', title: 'Original', publishedAt: 0 });
  const writes = agent.writes.length;
  // A later run with a richer title must NOT re-put — re-putting would change the
  // cid and break associatedRefs already embedded in posted cards.
  const again = await ensureDocument(agent, {
    rkey: 'stable1',
    title: 'A much richer headline',
    description: 'now with detail',
    publishedAt: 123,
  });
  assert.equal(agent.writes.length, writes); // no new network write
  assert.equal(again.cid, first.cid); // cid unchanged
});

test('ensureDocument normalizes a seconds-epoch publishedAt to ms (no 1970)', async () => {
  const agent = fakeAgent();
  await ensurePublication(agent);
  // GTFS-rt onset_ts is in seconds; treated as ms it would land in 1970.
  const seconds = 1782273600; // 2026-06-24T00:00:00Z
  await ensureDocument(agent, { rkey: 'secs-evt', title: 'X', publishedAt: seconds });
  const write = agent.writes.find((w) => w.rkey === 'secs-evt');
  assert.equal(write.record.publishedAt, new Date(seconds * 1000).toISOString());
  assert.equal(write.record.publishedAt.slice(0, 4), '2026');

  // A real ms timestamp passes through unchanged.
  const ms = 1782273600000;
  await ensureDocument(agent, { rkey: 'ms-evt', title: 'X', publishedAt: ms });
  const msWrite = agent.writes.find((w) => w.rkey === 'ms-evt');
  assert.equal(msWrite.record.publishedAt, new Date(ms).toISOString());
});

test('buildAssociatedRefs returns [document, publication] strong refs', async () => {
  const agent = fakeAgent();
  const pub = await ensurePublication(agent);
  const doc = await ensureDocument(agent, {
    rkey: 'abc123',
    title: 'X',
    publishedAt: 0,
  });
  const refs = buildAssociatedRefs(DID, doc);
  assert.deepEqual(refs, [
    { uri: doc.uri, cid: doc.cid },
    { uri: pub.uri, cid: pub.cid },
  ]);
});

test('buildAssociatedRefs is null when publication is unpublished', () => {
  // Fresh state with no publication for a different did.
  const refs = buildAssociatedRefs('did:plc:other', { uri: 'at://x', cid: 'c' });
  assert.equal(refs, null);
});

test('state file records published documents for the manifest exporter', async () => {
  const agent = fakeAgent();
  await ensurePublication(agent);
  await ensureDocument(agent, { rkey: 'evt1', title: 'A', publishedAt: 0 });
  const state = loadState();
  assert.ok(state.publication.cid);
  assert.ok(state.documents.evt1.cid);
});
