const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const { decodeFeed, parseAlert } = require('../../src/marta/alert/api');
const {
  isSignificantAlert,
  alertRelevance,
  entityMode,
  buildAlertText,
  buildResolutionText,
} = require('../../src/marta/alert/significance');

const FIX = Path.join(__dirname, 'fixtures');
const synthetic = decodeFeed(Fs.readFileSync(Path.join(FIX, 'service-alerts-synthetic.pb')))
  .entity.map(parseAlert)
  .filter(Boolean);
const railAlert = synthetic.find((a) => a.id === 'marta-synthetic-rail-1');
const busAlert = synthetic.find((a) => a.id === 'marta-synthetic-bus-1');

test('mode classification from route_type and rail line name', () => {
  assert.equal(entityMode({ routeType: 1 }), 'rail');
  assert.equal(entityMode({ routeType: 2 }), 'rail');
  assert.equal(entityMode({ routeType: 3 }), 'bus');
  assert.equal(entityMode({ routeId: 'GREEN' }), 'rail');
  assert.equal(entityMode({ routeId: '20' }), null);
  // route_type 0 is ambiguous (proto default vs. real streetcar) → unknown.
  assert.equal(entityMode({ routeType: 0 }), null);
});

test('relevance: rail alert is rail-mode and relevant', () => {
  const rel = alertRelevance(railAlert);
  assert.equal(rel.relevant, true);
  assert.equal(rel.mode, 'rail');
  assert.deepEqual(rel.routes, ['RED']);
  assert.equal(rel.agencyWide, false);
});

test('relevance: bus detour alert is bus-mode and relevant', () => {
  const rel = alertRelevance(busAlert);
  assert.equal(rel.relevant, true);
  assert.equal(rel.mode, 'bus');
  assert.deepEqual(rel.routes, ['20']);
});

test('agency-wide notice (only agencyId) is relevant', () => {
  const rel = alertRelevance({ informedEntities: [{ agencyId: 'MARTA' }] });
  assert.equal(rel.relevant, true);
  assert.equal(rel.agencyWide, true);
  assert.equal(rel.mode, 'general');
});

test('rail mode wins when an alert spans modes', () => {
  const rel = alertRelevance({
    informedEntities: [
      { routeType: 3, routeId: '20' },
      { routeType: 1, routeId: 'RED' },
    ],
  });
  assert.equal(rel.mode, 'rail');
  assert.deepEqual(rel.routes, ['20', 'RED']);
});

test('strong effect (NO_SERVICE) admits regardless of keywords', () => {
  assert.equal(isSignificantAlert(railAlert), true);
});

test('DETOUR bus alert admits via strong effect', () => {
  assert.equal(isSignificantAlert(busAlert), true);
});

test('minor-only notice is vetoed', () => {
  const elevator = {
    effect: 'UNKNOWN_EFFECT',
    header: 'Elevator out of service',
    description: 'The elevator at Five Points is temporarily out of service.',
    informedEntities: [{ routeType: 1, routeId: 'RED', stopId: '100' }],
  };
  assert.equal(isSignificantAlert(elevator), false);
});

test('major keyword overrides a minor keyword', () => {
  const closedWithShuttle = {
    effect: 'UNKNOWN_EFFECT',
    header: 'Station closed',
    description: 'Construction; station closed, shuttle buses running.',
    informedEntities: [{ routeType: 1, routeId: 'GOLD', stopId: '200' }],
  };
  assert.equal(isSignificantAlert(closedWithShuttle), true);
});

test('irrelevant alert (no scope) is never significant', () => {
  assert.equal(isSignificantAlert({ effect: 'NO_SERVICE', informedEntities: [] }), false);
});

test('post text stays within Bluesky 300-grapheme limit', () => {
  const text = buildAlertText(railAlert, 'rail');
  assert.ok(text.includes(railAlert.header));
  assert.match(text, /Per MARTA/);
  assert.ok([...text].length <= 300);
});

test('overlong alert falls back to a header-only post', () => {
  const long = {
    header: 'Red Line major disruption',
    description: 'x'.repeat(400),
    informedEntities: [{ routeType: 1, routeId: 'RED' }],
  };
  const text = buildAlertText(long, 'rail');
  assert.ok([...text].length <= 300);
  assert.match(text, /itsmarta\.com/);
});

test('resolution reply references the original headline', () => {
  const text = buildResolutionText('Red Line suspended');
  assert.match(text, /✅/);
  assert.match(text, /resolved/i);
  assert.match(text, /Red Line suspended/);
});
