const test = require('node:test');
const assert = require('node:assert/strict');
const { titleCaseStopName } = require('../../src/marta/bus/stops');

test('MARTA uppercase stop names are normalized for posts', () => {
  assert.equal(titleCaseStopName('CLIFTON RD NE @ CANDLER RD'), 'Clifton Rd NE @ Candler Rd');
  assert.equal(titleCaseStopName('MARTA ARTS CENTER STATION'), 'MARTA Arts Center Station');
});
