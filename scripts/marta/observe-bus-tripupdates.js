#!/usr/bin/env node
// MARTA bus TripUpdates observer — kept SEPARATE from observe-buses.js. The
// default DB write is compact: one row per trip status, including trip-level
// CANCELED signals used to enrich ghost-bus detection. Full stop-level rows are
// only retained when MARTA_STORE_TRIP_UPDATE_STOPS=1 because they are large.
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
