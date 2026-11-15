const test = require('node:test');
const assert = require('node:assert/strict');
const { runTicks } = require('../../src/marta/observeUtil');

test('runs a single tick by default with no sleep', async () => {
  let calls = 0;
  let slept = 0;
  await runTicks(
    () => {
      calls++;
    },
    {
      sleep: () => {
        slept++;
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(slept, 0, 'no inter-tick sleep for a single tick');
});

test('runs N ticks with a sleep between each (not before the first)', async () => {
  const sleeps = [];
  const indices = [];
  await runTicks((i) => indices.push(i), {
    ticks: 3,
    intervalMs: 30_000,
    now: () => 0,
    sleep: (ms) => {
      sleeps.push(ms);
    },
  });
  assert.deepEqual(indices, [0, 1, 2], 'tick receives its index');
  assert.deepEqual(sleeps, [30_000, 60_000], 'sleeps until each start-to-start slot');
});

test('spaces ticks start-to-start, absorbing tick duration', async () => {
  let clock = 0;
  const starts = [];
  await runTicks(
    () => {
      starts.push(clock);
      clock += 2_500;
    },
    {
      ticks: 4,
      intervalMs: 10_000,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
      },
    },
  );
  assert.deepEqual(starts, [0, 10_000, 20_000, 30_000]);
});

test('runs the next tick immediately when one overruns the interval', async () => {
  let clock = 0;
  const sleeps = [];
  await runTicks(
    (i) => {
      clock += i === 0 ? 15_000 : 1_000;
    },
    {
      ticks: 3,
      intervalMs: 10_000,
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    },
  );
  assert.deepEqual(sleeps, [0, 4_000]);
});

test('awaits each tick before the next', async () => {
  const order = [];
  await runTicks(
    async (i) => {
      order.push(`start${i}`);
      await Promise.resolve();
      order.push(`end${i}`);
    },
    { ticks: 2, sleep: () => Promise.resolve() },
  );
  assert.deepEqual(order, ['start0', 'end0', 'start1', 'end1'], 'ticks do not overlap');
});
