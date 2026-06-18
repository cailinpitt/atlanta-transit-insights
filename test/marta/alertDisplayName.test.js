const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAlertDisplayName,
  alertSubject,
  alertNature,
} = require('../../src/marta/alert/displayName');

test('subject: rail single / multi line, streetcar, bus, agency-wide', () => {
  assert.equal(alertSubject({ mode: 'rail', routes: ['Green'] }), 'Green Line');
  // Multiple rail lines collapse to "X/Y Line"; canonicalized + titlecased.
  assert.equal(alertSubject({ mode: 'rail', routes: ['RED', 'GOLD'] }), 'Red/Gold Line');
  assert.equal(alertSubject({ mode: 'streetcar', routes: ['SC'] }), 'Streetcar');
  assert.equal(alertSubject({ mode: 'bus', routes: ['110'] }), 'Route 110');
  assert.equal(alertSubject({ mode: 'bus', routes: ['110', '49'] }), 'Routes 110, 49');
  // No scoped routes → agency-wide notice.
  assert.equal(alertSubject({ mode: 'general', routes: [] }), 'MARTA');
});

test('nature: prose keywords beat the coarse effect enum', () => {
  // Real MARTA example: effect is UNKNOWN but the prose says "only servicing".
  assert.equal(
    alertNature({
      header: 'Rail Service Alert for Green Line',
      description: 'Green line is only servicing from Bankhead to Ashby.',
      effect: null,
    }),
    'partial service',
  );
  assert.equal(alertNature({ description: 'single-tracking near Ashby' }), 'single-tracking');
  assert.equal(
    alertNature({ description: 'Shuttle buses are bridging the gap' }),
    'shuttle service',
  );
  assert.equal(alertNature({ description: 'Route 110 is on detour' }), 'detour');
  assert.equal(alertNature({ description: 'Expect significant delays' }), 'delays');
});

test('nature: falls back to the structured effect, then to a generic phrase', () => {
  assert.equal(alertNature({ effect: 'REDUCED_SERVICE' }), 'reduced service');
  assert.equal(alertNature({ effect: 'NO_SERVICE' }), 'service suspended');
  assert.equal(alertNature({ effect: 'DETOUR' }), 'detour');
  // Nothing to go on → a generic but honest label.
  assert.equal(
    alertNature({ header: 'Rail Service Alert', description: null, effect: null }),
    'service alert',
  );
});

test('nature: bus closure phrasing softened to service change', () => {
  // "closed" on a bus alert shouldn't read as a rail-station closure.
  assert.equal(
    alertNature({ description: 'A stop is closed for construction', mode: 'bus' }),
    'service change',
  );
  // Rail keeps the closure phrasing.
  assert.equal(alertNature({ description: 'Station closed', mode: 'rail' }), 'station closure');
});

test('buildAlertDisplayName composes subject + nature', () => {
  assert.equal(
    buildAlertDisplayName({
      header: 'Rail Service Alert for Green Line',
      description: 'Green line is only servicing from Bankhead to Ashby.',
      mode: 'rail',
      routes: ['Green'],
      effect: null,
    }),
    'Green Line partial service',
  );
  assert.equal(
    buildAlertDisplayName({
      header: 'Rail Service Alert for Red/Gold lines',
      description: 'Expect delays.',
      mode: 'rail',
      routes: ['Red', 'Gold'],
      effect: 'SIGNIFICANT_DELAYS',
    }),
    'Red/Gold Line delays',
  );
  assert.equal(
    buildAlertDisplayName({
      header: 'Service Alert for Route 110',
      description: 'Route 110 is detouring around road work.',
      mode: 'bus',
      routes: ['110'],
      effect: 'DETOUR',
    }),
    'Route 110 detour',
  );
  assert.equal(
    buildAlertDisplayName({ mode: 'bus', routes: ['49'], effect: 'REDUCED_SERVICE' }),
    'Route 49 reduced service',
  );
});

test('buildAlertDisplayName falls back to the raw header only when nothing parses', () => {
  // No routes AND no recognizable nature → MARTA's own header beats "MARTA
  // service alert".
  assert.equal(
    buildAlertDisplayName({
      header: 'Holiday service schedule',
      description: 'See itsmarta.com for details.',
      mode: 'general',
      routes: [],
      effect: null,
    }),
    'Holiday service schedule',
  );
  // A real route subject is always kept, even when the nature is generic —
  // "Green Line service alert" reads at least as well as the raw header.
  assert.equal(
    buildAlertDisplayName({
      header: 'Rail Service Alert for Green Line',
      description: 'See itsmarta.com for details.',
      mode: 'rail',
      routes: ['Green'],
      effect: null,
    }),
    'Green Line service alert',
  );
  // Nothing parses AND no header to fall back to → still a clean generic name.
  assert.equal(
    buildAlertDisplayName({ header: null, description: null, mode: 'general', routes: [] }),
    'MARTA service alert',
  );
});
