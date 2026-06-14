#!/usr/bin/env node
// MARTA bus TripUpdates observer — kept SEPARATE from observe-buses.js because
// each fetch flattens to ~14k rows (every active trip × every upcoming stop),
// ~100x heavier than positions. No detector reads trip updates yet; they're the
// schedule-adherence / predicted-arrival substrate for future work, so this runs
// on a slow cadence (cron */5) rather than at position density. The
// observe-buses rolloff trims this table too.
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '..', '.env') });
const { getTripUpdates } = require('../../src/marta/bus/api');
const { runTicks } = require('../../src/marta/observeUtil');

const TICKS = Number(process.env.MARTA_OBSERVE_TU_TICKS || 1);

async function tick() {
  const tu = await getTripUpdates(); // records by default
  console.log(
    `observe-bus-tripupdates: ${tu.tripUpdates.length} trips @ ${new Date().toISOString()}`,
  );
}

async function main() {
  await runTicks(tick, { ticks: TICKS });
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.stack || e);
    process.exit(1);
  });
}

module.exports = { tick, main };
