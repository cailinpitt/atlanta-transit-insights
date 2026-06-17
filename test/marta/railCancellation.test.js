const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyRailCancellation } = require('../../src/marta/alert/cancellation');

// Anchor on a fixed ET date so the parsed wall-clock departure resolves
// deterministically. 2026-06-17 12:00 ET ≈ 1750176000000 ms (DST, UTC-4).
const ANCHOR = Date.UTC(2026, 5, 17, 16, 0, 0); // noon ET

test('classifies the linked Blue Line example (cancellation + trailing delay aside)', () => {
  const c = classifyRailCancellation({
    headline: 'Rail Service Alert for Blue Line',
    description:
      'Update: Due to a previous issue on a Blue line train, the 3:59 p.m. Blue line departure from Indian Creek is cancelled. Delays continuing on the Blue line.',
    line: 'blue',
    anchorTs: ANCHOR,
  });
  assert.ok(c, 'should classify');
  assert.equal(c.origin, 'Indian Creek');
  assert.equal(c.depLabel, '3:59 PM');
  assert.equal(c.line, 'Blue');
  assert.equal(c.title, '3:59 PM Blue Line departure from Indian Creek cancelled');
  // 3:59 PM ET on the anchor day.
  const d = new Date(c.scheduledDepMs);
  assert.equal(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(d),
    '3:59 PM',
  );
});

test('classifies a pure cancellation with no origin', () => {
  const c = classifyRailCancellation({
    headline: 'Rail Service Alert for Red Line',
    description: 'The 7:15 a.m. Red line departure is cancelled.',
    line: 'red',
    anchorTs: ANCHOR,
  });
  assert.ok(c);
  assert.equal(c.origin, null);
  assert.equal(c.title, '7:15 AM Red Line departure cancelled');
});

test('rejects a vague reduced-service alert (no specific departure)', () => {
  const c = classifyRailCancellation({
    headline: 'Rail Service Alert for Green Line',
    description:
      'Green line is only servicing from Bankhead to Ashby, on the EB platform. Customers must board on the EB platform at Ashby for service to Bankhead.',
    line: 'green',
    anchorTs: ANCHOR,
  });
  assert.equal(c, null);
});

test('rejects a single-tracking alert with no cancelled departure', () => {
  const c = classifyRailCancellation({
    headline: 'Rail Service Alert for Gold Line',
    description:
      'Gold line single-tracking between Lindbergh and Buckhead due to a signal problem.',
    line: 'gold',
    anchorTs: ANCHOR,
  });
  assert.equal(c, null);
});

test('a delay aside with its own time does not steal the cancellation sentence', () => {
  // The cancellation sentence carries the cancelled departure; the delay
  // sentence has a different time and must not be picked.
  const c = classifyRailCancellation({
    headline: 'Rail Service Alert for Blue Line',
    description:
      'The 3:59 p.m. Blue line departure from Indian Creek is cancelled. Trains delayed until 4:30 p.m.',
    line: 'blue',
    anchorTs: ANCHOR,
  });
  assert.ok(c);
  assert.equal(c.depLabel, '3:59 PM');
});

test('returns null for empty text', () => {
  assert.equal(classifyRailCancellation({ headline: '', description: '', line: 'blue' }), null);
});
