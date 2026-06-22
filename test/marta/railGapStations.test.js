const test = require('node:test');
const assert = require('node:assert/strict');

const { displayStationName, gapStationContext } = require('../../src/marta/rail/stations');

test('displayStationName strips the SCREAMING " Station" suffix', () => {
  assert.equal(displayStationName('LINDBERGH CENTER Station'), 'Lindbergh Center');
  assert.equal(displayStationName('LENOX Station'), 'Lenox');
  assert.equal(displayStationName(''), '');
});

test('gapStationContext picks the flanks just outside the gap and the center station', () => {
  const stations = [
    { name: 'A', distFt: 1000 },
    { name: 'B', distFt: 5000 }, // just before trailing
    { name: 'C', distFt: 12_000 }, // inside, near center
    { name: 'D', distFt: 25_000 }, // just after leading
    { name: 'E', distFt: 30_000 },
  ];
  // Gap between trailing@6000 and leading@22000 → center 14000.
  const gap = { trailing: { distFt: 6000 }, leading: { distFt: 22_000 } };
  const ctx = gapStationContext(stations, gap);
  assert.equal(ctx.flankBefore.name, 'B');
  assert.equal(ctx.flankAfter.name, 'D');
  assert.equal(ctx.midStation.name, 'C');
});

test('gapStationContext falls back to the nearest station when none sits inside', () => {
  const stations = [
    { name: 'A', distFt: 1000 },
    { name: 'B', distFt: 30_000 },
  ];
  const gap = { trailing: { distFt: 10_000 }, leading: { distFt: 12_000 } };
  const ctx = gapStationContext(stations, gap);
  assert.equal(ctx.flankBefore.name, 'A');
  assert.equal(ctx.flankAfter.name, 'B');
  // Center 11000 → nearest overall is A (10000 away) vs B (19000 away).
  assert.equal(ctx.midStation.name, 'A');
});
