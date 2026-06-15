#!/usr/bin/env node
// Dedicated MARTA rail observer — polls the rail traindata feed and records
// tracked-train positions + station arrivals to the history DB. Rail speed is
// reconstructed from position deltas between snapshots (Path A), so this runs
// multiple ticks per firing to capture closely-spaced positions; run cron every
// minute. Requires MARTA_TRAIN_KEY.
//
// The Atlanta Streetcar rides along here too: it's the rail's slow cousin
// (Path-A positions, speed from deltas), so we poll its OTP feed on the same
// 30s tick and store it in streetcar_observations. The streetcar fetch is
// best-effort — its endpoint is an undocumented rider-app backend, so a hiccup
// there must never break heavy-rail ingestion.
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '..', '.env') });
const { fetchTrainData } = require('../../src/marta/rail/api');
const { fetchStreetcarVehicles } = require('../../src/marta/streetcar/api');
const { rolloffOldObservations } = require('../../src/marta/storage');
const { runTicks } = require('../../src/marta/observeUtil');

const TICKS = Number(process.env.MARTA_OBSERVE_RAIL_TICKS || 2);
const INTERVAL_MS = Number(process.env.MARTA_OBSERVE_RAIL_INTERVAL_MS || 30_000);

async function tick() {
  const parsed = await fetchTrainData(); // records by default
  let streetcarCount = 0;
  try {
    const sc = await fetchStreetcarVehicles(); // records by default
    streetcarCount = sc.vehicles.length;
  } catch (e) {
    console.warn(`observe-rail: streetcar fetch failed: ${e.message}`);
  }
  console.log(
    `observe-rail: ${parsed.trains.length} trains, ${parsed.arrivals.length} arrivals, ` +
      `${streetcarCount} streetcars @ ${new Date().toISOString()}`,
  );
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
