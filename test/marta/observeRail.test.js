const test = require('node:test');
const assert = require('node:assert/strict');
const { tick } = require('../../scripts/marta/observe-rail');

const quiet = (t) => {
  for (const m of ['log', 'warn', 'error']) t.mock.method(console, m, () => {});
};

test('rail failure still fetches the streetcar', async (t) => {
  quiet(t);
  let streetcarCalls = 0;
  const ok = await tick(0, {
    fetchRail: async () => {
      throw new Error('rail down');
    },
    fetchStreetcar: async () => {
      streetcarCalls++;
      return { vehicles: [{}, {}] };
    },
  });
  assert.equal(ok, false);
  assert.equal(streetcarCalls, 1);
});

test('streetcar failure does not affect rail', async (t) => {
  quiet(t);
  let railCalls = 0;
  const ok = await tick(0, {
    fetchRail: async () => {
      railCalls++;
      return { trains: [], arrivals: [] };
    },
    fetchStreetcar: async () => {
      throw new Error('streetcar down');
    },
  });
  assert.equal(ok, true);
  assert.equal(railCalls, 1);
});
