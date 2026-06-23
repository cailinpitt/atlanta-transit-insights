const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDaily } = require('../../bin/marta/export-daily');

// A weekday afternoon in Atlanta (well clear of the UTC day boundary so the
// Atlanta-day bucketing is unambiguous).
const TS = Date.UTC(2026, 5, 17, 19, 0, 0); // 3 PM ET

function incident(mode, routes) {
  return { mode, routes, lifecycle: { first_seen_ts: TS } };
}

test('buildDaily counts rail, bus, and streetcar incidents', () => {
  const out = buildDaily({
    generated_at: TS,
    data_start_ts: TS,
    incidents: [incident('rail', ['red']), incident('bus', ['110']), incident('streetcar', ['sc'])],
  });
  assert.equal(out.days.length, 1);
  const day = out.days[0];
  // Streetcar is counted with rail (the website's legacyKind maps it to train),
  // so a streetcar incident must bump the train count and land in by_line — not
  // vanish from the calendar while still showing in the incident list.
  assert.equal(day.train_count, 2);
  assert.equal(day.bus_count, 1);
  assert.equal(day.by_line.red, 1);
  assert.equal(day.by_line.sc, 1);
  assert.equal(day.by_route['110'], 1);
});

test('buildDaily skips incidents with an unknown mode', () => {
  const out = buildDaily({
    generated_at: TS,
    data_start_ts: TS,
    incidents: [incident('general', [])],
  });
  assert.equal(out.days.length, 0);
});
