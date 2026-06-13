#!/usr/bin/env node
// Densifies Metra capture by polling the GTFS-realtime positions + tripUpdates
// feeds every 30s. Cron's minimum granularity is 1 minute, so this script runs
// two ticks 30s apart per cron firing — same pattern as scripts/observeTrains.js.
// getMetraPositions / getMetraTripUpdates record to the DB internally; this
// script's only job is to call them on a steady cadence so the delay and
// inferred-cancellation detectors (Phase 2/3) have dense, recent data and aren't
// reliant on a detector cron being the only writer.
//
// Metra uses a separate API token from CTA, so this is not on the CTA
// 100k/day budget. One call each per tick for positions + tripUpdates.

require('../src/shared/env');

const { setup, runBin } = require('../src/shared/runBin');
const { getMetraPositions, getMetraTripUpdates } = require('../src/metra/api');

const TICK_INTERVAL_MS = 30 * 1000;
const TICKS_PER_RUN = 2;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultTick() {
  // Positions and tripUpdates are independent feeds — fetch both, but don't let
  // one failing abort the other (a single feed hiccup shouldn't drop the tick).
  try {
    const positions = await getMetraPositions();
    console.log(`observe-metra: recorded ${positions.length} positions`);
  } catch (e) {
    console.warn(`observe-metra: getMetraPositions failed: ${e.message}`);
  }
  try {
    const updates = await getMetraTripUpdates();
    console.log(`observe-metra: recorded ${updates.length} trip updates`);
  } catch (e) {
    console.warn(`observe-metra: getMetraTripUpdates failed: ${e.message}`);
  }
}

// Exposed for testing — deps injected so the test can assert call count and
// inter-tick spacing without sleeping for real (mirrors observeTrains.js).
async function runTicks({
  tick = defaultTick,
  sleep = defaultSleep,
  ticksPerRun = TICKS_PER_RUN,
  intervalMs = TICK_INTERVAL_MS,
} = {}) {
  for (let i = 0; i < ticksPerRun; i++) {
    if (i > 0) await sleep(intervalMs);
    await tick();
  }
}

async function main() {
  setup();
  await runTicks();
}

if (require.main === module) {
  runBin(main);
}

module.exports = { runTicks, TICK_INTERVAL_MS, TICKS_PER_RUN };
