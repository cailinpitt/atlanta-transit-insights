#!/usr/bin/env node
// Dedicated MARTA bus *position* observer — records VehiclePositions to the
// history DB so every bus detector (speedmap/gaps/bunching/ghosts) sees a dense,
// consistent stream. One GTFS-rt fetch covers the whole system. Positions are
// cheap (~160 rows/fetch), so this runs at 30s density like the CTA observers
// (cron every minute, 2 ticks 30s apart). TripUpdates are captured separately
// (observe-bus-tripupdates.js) because they're ~100x heavier and no detector
// reads them yet. rolloff trims the 7-day window each run.
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '..', '.env') });
const { getVehiclePositions } = require('../../src/marta/bus/api');
const { rolloffOldObservations } = require('../../src/marta/storage');
const { runTicks } = require('../../src/marta/observeUtil');

const TICKS = Number(process.env.MARTA_OBSERVE_BUS_TICKS || 2);
const INTERVAL_MS = Number(process.env.MARTA_OBSERVE_BUS_INTERVAL_MS || 30_000);

async function tick() {
  const vp = await getVehiclePositions(); // records by default
  console.log(`observe-buses: ${vp.vehicles.length} vehicles @ ${new Date().toISOString()}`);
}

async function main() {
  rolloffOldObservations();
  await runTicks(tick, { ticks: TICKS, intervalMs: INTERVAL_MS });
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.stack || e);
    process.exit(1);
  });
}

module.exports = { tick, main };
