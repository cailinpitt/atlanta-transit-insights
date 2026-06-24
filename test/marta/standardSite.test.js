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
