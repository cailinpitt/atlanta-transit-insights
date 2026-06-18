const test = require('node:test');
const assert = require('node:assert/strict');
const { captureCrossBunchingVideo } = require('../../src/marta/map/crossBunchingVideo');

// The full capture hits Mapbox + ffmpeg (exercised via the bin). Here we lock
// the early-exit contract that runs BEFORE any network: too few distinct
// snapshots → null, so the bin skips the reply instead of throwing.
test('returns null with no rows', async () => {
  assert.equal(await captureCrossBunchingVideo([]), null);
});

test('returns null with a single observation', async () => {
  const rows = [{ id: 'a', lat: 33.75, lon: -84.39, ts: 1000, label: '1', groupIndex: 0 }];
  assert.equal(await captureCrossBunchingVideo(rows), null);
});

test('returns null when all rows share one timestamp (one snapshot)', async () => {
  const rows = [
    { id: 'a', lat: 33.75, lon: -84.39, ts: 1000, label: '1', groupIndex: 0 },
    { id: 'b', lat: 33.751, lon: -84.39, ts: 1000, label: '2', groupIndex: 1 },
  ];
  assert.equal(await captureCrossBunchingVideo(rows), null);
});
