#!/usr/bin/env node
// Download + extract the MARTA static GTFS feed (google_transit.zip) into
// data/marta/gtfs/ (gitignored). Caches the zip by mtime so repeated runs in a
// day don't re-download 20 MB. Prints a route-type summary so feed changes
// (e.g. a line added/removed) are visible.
//
// This is the unauthenticated static feed; it covers bus, rail, and streetcar.
// Use scripts/marta/build-bus-fixtures.js to derive committed test fixtures
// from the extracted directory.
const Fs = require('node:fs');
const Path = require('node:path');
const { execFileSync } = require('node:child_process');
const axios = require('axios');
const { loadGtfs, routeMode } = require('../../src/marta/gtfs');

const GTFS_URL = 'https://itsmarta.com/google_transit_feed/google_transit.zip';
const DATA_DIR = Path.join(__dirname, '..', '..', 'data', 'marta');
const ZIP_PATH = Path.join(DATA_DIR, 'google_transit.zip');
const OUT_DIR = Path.join(DATA_DIR, 'gtfs');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function download() {
  if (Fs.existsSync(ZIP_PATH) && Date.now() - Fs.statSync(ZIP_PATH).mtimeMs < ONE_DAY_MS) {
    console.log('Using cached google_transit.zip (< 1 day old)');
    return;
  }
  console.log(`Downloading ${GTFS_URL} ...`);
  const { data } = await axios.get(GTFS_URL, { responseType: 'arraybuffer', timeout: 180000 });
  Fs.mkdirSync(DATA_DIR, { recursive: true });
  Fs.writeFileSync(ZIP_PATH, Buffer.from(data));
  console.log(`  ${(data.byteLength / 1024 / 1024).toFixed(1)} MB`);
}

function extract() {
  Fs.rmSync(OUT_DIR, { recursive: true, force: true });
  Fs.mkdirSync(OUT_DIR, { recursive: true });
  // `unzip` ships on macOS and the CI runners; avoids pulling in a zip dep.
  execFileSync('unzip', ['-o', ZIP_PATH, '-d', OUT_DIR], { stdio: 'ignore' });
}

async function main() {
  await download();
  extract();
  const gtfs = loadGtfs(OUT_DIR);
  const byMode = {};
  for (const r of gtfs.routes) {
    const m = routeMode(r);
    byMode[m] = (byMode[m] || 0) + 1;
  }
  console.log(`Extracted → ${OUT_DIR}`);
  console.log(
    `  routes=${gtfs.routes.length} (${Object.entries(byMode)
      .map(([m, n]) => `${m}:${n}`)
      .join(' ')}) trips=${gtfs.trips.length} stops=${gtfs.stops.length}`,
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
