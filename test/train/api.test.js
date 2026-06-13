const test = require('node:test');
const assert = require('node:assert');

const { recoverUnpositionedTrain, isInChicagoland } = require('../../src/train/api');

// Minimal injectable station table (the real one is line-tagged the same way).
const STATIONS = [
  { name: 'Howard', lat: 42.01942, lon: -87.67278, lines: ['red', 'p', 'y'] },
  { name: 'Kimball', lat: 41.96788, lon: -87.71337, lines: ['brn'] },
  { name: 'Halsted (Orange)', lat: 41.84678, lon: -87.64809, lines: ['org'] },
];

test('recoverUnpositionedTrain synthesizes a position from the next station', () => {
  const train = {
    line: 'y',
    rn: '595',
    nextStation: 'Howard',
    trDr: '1',
    lat: 0,
    lon: 0,
  };
  const fixed = recoverUnpositionedTrain(train, STATIONS);
  assert.ok(fixed, 'should recover a 0,0 train that knows its next station');
  assert.equal(fixed.approx, true);
  assert.equal(fixed.lat, 42.01942);
  assert.equal(fixed.lon, -87.67278);
  assert.equal(fixed.recoveredFrom, 'Howard');
  // The recovered position is inside the bounding box, so it survives the filter.
  assert.ok(isInChicagoland(fixed.lat, fixed.lon));
  // Original is untouched (pure).
  assert.equal(train.lat, 0);
});

test('recoverUnpositionedTrain matches base names with a parenthetical tag', () => {
  const train = { line: 'org', rn: '801', nextStation: 'Halsted', lat: 0, lon: 0 };
  const fixed = recoverUnpositionedTrain(train, STATIONS);
  assert.ok(fixed);
  assert.equal(fixed.recoveredFrom, 'Halsted (Orange)');
});

test('recoverUnpositionedTrain returns null with no resolvable next station', () => {
  assert.equal(recoverUnpositionedTrain({ line: 'red', rn: '1', lat: 0, lon: 0 }, STATIONS), null);
  assert.equal(
    recoverUnpositionedTrain(
      { line: 'red', rn: '1', nextStation: 'Nowhere', lat: 0, lon: 0 },
      STATIONS,
    ),
    null,
  );
  // Line scoping: Kimball is Brown-only, so a Red train near "Kimball" doesn't match.
  assert.equal(
    recoverUnpositionedTrain(
      { line: 'red', rn: '1', nextStation: 'Kimball', lat: 0, lon: 0 },
      STATIONS,
    ),
    null,
  );
});
