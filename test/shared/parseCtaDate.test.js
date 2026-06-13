const test = require('node:test');
const assert = require('node:assert');
const { parseCtaDate, isCtaDateOnly } = require('../../src/shared/ctaAlerts');

test('parseCtaDate: ISO 8601 format from current feed', () => {
  // 2026-04-26T06:00:00 in CT (CDT, UTC-5) → 2026-04-26T11:00:00Z
  const ts = parseCtaDate('2026-04-26T06:00:00');
  assert.equal(new Date(ts).toISOString(), '2026-04-26T11:00:00.000Z');
});

test('parseCtaDate: legacy compact format YYYYMMDD HH:MM:SS', () => {
  const ts = parseCtaDate('20260426 06:00:00');
  assert.equal(new Date(ts).toISOString(), '2026-04-26T11:00:00.000Z');
});

test('parseCtaDate: standard time (CST, UTC-6) round-trip', () => {
  // January is standard time
  const ts = parseCtaDate('2026-01-15T08:00:00');
  assert.equal(new Date(ts).toISOString(), '2026-01-15T14:00:00.000Z');
});

test('parseCtaDate: returns null on invalid input', () => {
  assert.equal(parseCtaDate(''), null);
  assert.equal(parseCtaDate(null), null);
  assert.equal(parseCtaDate('not a date'), null);
});

test('parseCtaDate: end-of-day midnight handled', () => {
  const ts = parseCtaDate('2026-04-26T23:30:00');
  assert.equal(new Date(ts).toISOString(), '2026-04-27T04:30:00.000Z');
});

test('parseCtaDate: date-only parsed as end-of-day Chicago time', () => {
  // CTA sometimes posts EventEnd as just "2026-05-25" — interpreted as
  // "through this day", which we anchor to 23:59:59 CDT (UTC-5 in May)
  // → 2026-05-26T04:59:59Z.
  const ts = parseCtaDate('2026-05-25');
  assert.equal(new Date(ts).toISOString(), '2026-05-26T04:59:59.000Z');
});

test('isCtaDateOnly: distinguishes date-only feed values', () => {
  assert.equal(isCtaDateOnly('2026-05-25'), true);
  assert.equal(isCtaDateOnly('20260525'), true);
  assert.equal(isCtaDateOnly('2026-05-25T06:00:00'), false);
  assert.equal(isCtaDateOnly('20260525 06:00:00'), false);
  assert.equal(isCtaDateOnly(null), false);
  assert.equal(isCtaDateOnly(''), false);
});
