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
const { runTicks } = require('../../src/marta/observeUtil');

const TICKS = Number(process.env.MARTA_OBSERVE_RAIL_TICKS || 2);
const INTERVAL_MS = Number(process.env.MARTA_OBSERVE_RAIL_INTERVAL_MS || 30_000);

// Rail and streetcar fail independently so one outage never drops the other or
// a later tick. Returns whether the rail fetch succeeded.
async function tick(
  _i,
  { fetchRail = fetchTrainData, fetchStreetcar = fetchStreetcarVehicles } = {},
) {
  let rail = null;
  try {
    rail = await fetchRail(); // records by default
  } catch (e) {
    console.error(`observe-rail: rail fetch failed: ${e.message}`);
  }
  let streetcarCount = 0;
  try {
    const sc = await fetchStreetcar(); // records by default
    streetcarCount = sc.vehicles.length;
  } catch (e) {
    console.warn(`observe-rail: streetcar fetch failed: ${e.message}`);
  }
  const railSummary = rail
    ? `${rail.trains.length} trains, ${rail.arrivals.length} arrivals`
    : 'rail failed';
  console.log(
    `observe-rail: ${railSummary}, ${streetcarCount} streetcars @ ${new Date().toISOString()}`,
  );
  return rail != null;
}

async function main() {
  // The 7-day rolloff is driven by observe-buses (every minute) to avoid two
  // observers running the same DELETE sweep concurrently each minute.
  let railFailed = false;
  await runTicks(
    async (i) => {
      if (!(await tick(i))) railFailed = true;
    },
    { ticks: TICKS, intervalMs: INTERVAL_MS },
  );
  if (railFailed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.stack || e);
    process.exit(1);
  });
}

module.exports = { tick, main };
