const test = require('node:test');
const assert = require('node:assert/strict');
const Fs = require('node:fs');
const Path = require('node:path');
const {
  parseOtpAlerts,
  parseOtpAlert,
  isCancellationAlert,
  modeToRouteType,
} = require('../../src/marta/alert/otp');
const { isSignificantAlert, alertRelevance } = require('../../src/marta/alert/significance');

// A real OTP `{ data: { alerts } }` capture: a batch of per-route bus
// cancellation notices + one genuine rail service alert.
const FIX = Path.join(__dirname, 'fixtures', 'otp-alerts-live.json');
const live = JSON.parse(Fs.readFileSync(FIX, 'utf8')).data;

test('cancellation-alert ids are detected and dropped', () => {
  const cancelId = Buffer.from('Alert:MARTA:cancellation-alert-26926').toString('base64');
  const realId = Buffer.from('Alert:MARTA:alert-2560695472491710').toString('base64');
  assert.equal(isCancellationAlert(cancelId), true);
  assert.equal(isCancellationAlert(realId), false);
  assert.equal(parseOtpAlert({ id: cancelId, alertHeaderText: 'x' }), null);
});

test('OTP mode → GTFS route_type mapping', () => {
  assert.equal(modeToRouteType('SUBWAY'), 1);
  assert.equal(modeToRouteType('BUS'), 3);
  assert.equal(modeToRouteType('TRAM'), 0);
  assert.equal(modeToRouteType('FERRY'), null);
});

test('live fixture: parse drops every cancellation-alert, keeps real alerts', () => {
  const total = live.alerts.length;
  const cancelCount = live.alerts.filter((a) =>
    Buffer.from(a.id, 'base64').toString().includes('cancellation-alert'),
  ).length;
  const parsed = parseOtpAlerts(live);
  assert.equal(parsed.length, total - cancelCount);
  assert.ok(parsed.length >= 1, 'fixture should retain the rail alert');
  for (const a of parsed) assert.equal(a.source, 'otp');
});

test('the rail alert normalizes to the parseAlert shape and is significant', () => {
  const parsed = parseOtpAlerts(live);
  const rail = parsed.find((a) => /rail|green/i.test(a.header || ''));
  assert.ok(rail, 'expected a rail/Green alert in the fixture');
  // routeId is the public line name (not the internal gtfsId), routeType from mode.
  const routeEntity = rail.informedEntities.find((e) => e.routeId);
  assert.equal(routeEntity.routeId, 'Green');
  assert.equal(routeEntity.routeType, 1);
  const rel = alertRelevance(rail);
  assert.equal(rel.mode, 'rail');
  assert.deepEqual(rel.routes, ['Green']);
  // Reduced-service prose with no MAJOR keyword + UNKNOWN_EFFECT still admits,
  // because OTP-sourced alerts are MARTA-curated (only the MINOR veto applies).
  assert.equal(isSignificantAlert(rail), true);
});

test('a non-cancellation BUS alert (detour/reroute) flows through, mode bus', () => {
  // Only "cancellation-alert" ids are dropped — other bus alerts must survive.
  const detour = {
    id: Buffer.from('Alert:MARTA:alert-778812').toString('base64'),
    alertHeaderText: 'Route 110 Detour',
    alertDescriptionText:
      'Due to construction, Route 110 is detoured and will not serve stops between 10th and 14th.',
    alertEffect: 'DETOUR',
    route: { shortName: '110', mode: 'BUS', gtfsId: 'MARTA:26990' },
    entities: [{ __typename: 'Route', shortName: '110', mode: 'BUS', gtfsId: 'MARTA:26990' }],
  };
  const parsed = parseOtpAlert(detour);
  assert.ok(parsed, 'bus detour must not be dropped');
  const rel = alertRelevance(parsed);
  assert.equal(rel.mode, 'bus');
  assert.deepEqual(rel.routes, ['110']);
  assert.equal(isSignificantAlert(parsed), true);
});

test('OTP-sourced minor notice is still vetoed', () => {
  const elevator = {
    id: Buffer.from('Alert:MARTA:alert-999').toString('base64'),
    alertHeaderText: 'Elevator out of service at Five Points',
    alertDescriptionText: 'The elevator is temporarily out of service.',
    alertEffect: 'UNKNOWN_EFFECT',
    route: { shortName: 'Red', mode: 'SUBWAY', gtfsId: 'MARTA:26984' },
    entities: [{ __typename: 'Route', shortName: 'Red', mode: 'SUBWAY', gtfsId: 'MARTA:26984' }],
  };
  const parsed = parseOtpAlert(elevator);
  assert.equal(parsed.source, 'otp');
  assert.equal(isSignificantAlert(parsed), false);
});
