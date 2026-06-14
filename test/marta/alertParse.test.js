const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const { decodeFeed, parseAlert } = require('../../src/marta/alert/api');

const FIX = Path.join(__dirname, 'fixtures');
const decode = (f) => decodeFeed(Fs.readFileSync(Path.join(FIX, f)));

test('empty alerts feed (real capture) parses to zero alerts', () => {
  // The live MARTA ServiceAlerts feed is a valid GTFS-rt FeedMessage even with
  // no active alerts; FULL_DATASET means empty = "nothing wrong right now".
  const feed = decode('service-alerts-empty.pb');
  assert.equal(feed.header.gtfsRealtimeVersion, '2.0');
  assert.equal(feed.entity.length, 0);
  assert.deepEqual(feed.entity.map(parseAlert).filter(Boolean), []);
});

// NOTE: synthetic fixture — MARTA's live feed was empty at discovery. Replace
// with a trimmed real capture once one is caught (see build-alert-fixtures.js).
test('ServiceAlerts entities normalize (synthetic fixture)', () => {
  const alerts = decode('service-alerts-synthetic.pb').entity.map(parseAlert).filter(Boolean);
  assert.equal(alerts.length, 2);

  const rail = alerts.find((a) => a.id === 'marta-synthetic-rail-1');
  assert.equal(rail.cause, 'MAINTENANCE');
  assert.equal(rail.effect, 'NO_SERVICE');
  assert.match(rail.header, /Red Line/);
  assert.ok(rail.description.length > 0);
  assert.equal(rail.url, 'https://itsmarta.com/alerts');
  assert.equal(rail.informedEntities[0].routeId, 'RED');
  assert.equal(rail.informedEntities[0].routeType, 1);
  assert.equal(rail.activePeriods[0].start, 1_781_400_000);
  assert.equal(rail.activePeriods[0].end, 1_781_400_000 + 3600);

  const bus = alerts.find((a) => a.id === 'marta-synthetic-bus-1');
  assert.equal(bus.effect, 'DETOUR');
  assert.equal(bus.informedEntities[0].routeId, '20');
  assert.equal(bus.informedEntities[0].stopId, '500350');
  // Open-ended active period (no end) decodes as null, not 0.
  assert.equal(bus.activePeriods[0].end, null);
});
