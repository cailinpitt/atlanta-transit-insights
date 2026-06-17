const test = require('node:test');
const assert = require('node:assert/strict');
const { postText } = require('../../src/marta/shared/bluesky');

// Fake agent capturing what would be posted.
function fakeAgent() {
  const calls = [];
  return {
    calls,
    post: async (record) => {
      calls.push(record);
      return { uri: 'at://did/app.bsky.feed.post/x', cid: 'cid' };
    },
  };
}

// Decode a facet's byte range back to the substring it covers (UTF-8).
function facetText(text, facet) {
  const buf = Buffer.from(text, 'utf8');
  return buf.slice(facet.index.byteStart, facet.index.byteEnd).toString('utf8');
}

test('bare itsmarta.com gets a clickable https facet, emoji byte offsets correct', async () => {
  const agent = fakeAgent();
  const text =
    '🚆⚠️ Rail Service Alert for Gold Line\n\n' +
    'The 11:41 a.m. departure was canceled.\n\n' +
    'Per MARTA. Check itsmarta.com for updates.';
  await postText(agent, text);
  const { facets } = agent.calls[0];
  assert.ok(facets, 'expected facets');
  const itsmarta = facets.find((f) => f.features[0].uri === 'https://itsmarta.com');
  assert.ok(itsmarta, 'expected an itsmarta.com link facet');
  assert.equal(facetText(text, itsmarta), 'itsmarta.com');
});

test('archive URL and itsmarta.com both get facets, non-overlapping', async () => {
  const agent = fakeAgent();
  const text =
    '✅ MARTA reports this is resolved:\n\nGold Line delay\n\n' +
    'https://atlantatransitalerts.app/event/123/resolved\n\nSee itsmarta.com';
  await postText(agent, text);
  const { facets } = agent.calls[0];
  const uris = facets.map((f) => f.features[0].uri).sort();
  assert.deepEqual(uris, [
    'https://atlantatransitalerts.app/event/123/resolved',
    'https://itsmarta.com',
  ]);
  // Facets are sorted by position and cover exactly their link text.
  assert.equal(facetText(text, facets[0]), 'https://atlantatransitalerts.app/event/123/resolved');
  assert.equal(facetText(text, facets[1]), 'itsmarta.com');
});

test('no links → no facets field', async () => {
  const agent = fakeAgent();
  await postText(agent, 'Plain text with no links here.');
  assert.equal(agent.calls[0].facets, undefined);
});
