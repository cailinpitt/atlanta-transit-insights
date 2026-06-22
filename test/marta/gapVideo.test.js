const test = require('node:test');
const assert = require('node:assert/strict');

const { midpointStop, gapReadout, ARRIVED_FT } = require('../../src/marta/bus/video');

const gap = {
  leading: { vehicleId: '1001', distFt: 22000 },
  trailing: { vehicleId: '1002', distFt: 4400 },
  gapMin: 20,
};

test('midpointStop picks the stop nearest the gap center', () => {
  // Gap center = (22000 + 4400) / 2 = 13200 ft.
  const stops = [
    { stopName: 'Near trailing', distFt: 5000 },
    { stopName: 'Mid', distFt: 13000 },
    { stopName: 'Near leading', distFt: 21000 },
  ];
  assert.equal(midpointStop(gap, stops)?.stopName, 'Mid');
});

test('midpointStop returns null when no stops carry a distance', () => {
  assert.equal(midpointStop(gap, []), null);
  assert.equal(midpointStop(gap, [{ stopName: 'X' }]), null);
});

test('gapReadout leads with the full gap and counts down to the wait stop', () => {
  // Far out: minutes to the stop at ~880 ft/min.
  assert.equal(gapReadout(20, 'Mid St', 1760), '~20-min gap · next bus ~2 min to Mid St');
});

test('gapReadout flips to "reaching" inside the arrival window', () => {
  assert.match(gapReadout(20, 'Mid St', ARRIVED_FT - 1), /reaching Mid St/);
});

test('gapReadout reports the bus leaving once past the stop', () => {
  assert.match(gapReadout(20, 'Mid St', -(ARRIVED_FT + 100)), /left Mid St/);
});

test('gapReadout omits the stop name when none is known', () => {
  assert.equal(gapReadout(15, null, 2000), '~15-min gap · next bus ~2 min');
});
