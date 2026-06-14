#!/usr/bin/env node
// Dedicated MARTA bus observer — polls the GTFS-rt feeds and records vehicle
// positions + trip updates to the history DB, so every bus detector
// (speedmap/gaps/bunching/ghosts) sees a consistent stream independent of when
// it runs. One GTFS-rt fetch covers the whole system (no per-route polling).
// rolloff trims the 7-day window each run.
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '..', '.env') });
const { getVehiclePositions, getTripUpdates } = require('../../src/marta/bus/api');
const { rolloffOldObservations } = require('../../src/marta/storage');
const { runTicks } = require('../../src/marta/observeUtil');

// A cron firing can capture multiple snapshots; default 1 (run cron */5).
const TICKS = Number(process.env.MARTA_OBSERVE_BUS_TICKS || 1);

async function tick() {
  // Both record by default; fetch in parallel.
  const [vp, tu] = await Promise.all([getVehiclePositions(), getTripUpdates()]);
  console.log(
    `observe-buses: ${vp.vehicles.length} vehicles, ${tu.tripUpdates.length} trips @ ${new Date().toISOString()}`,
  );
}

async function main() {
  rolloffOldObservations();
  await runTicks(tick, { ticks: TICKS });
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.stack || e);
    process.exit(1);
  });
}

module.exports = { tick, main };
