#!/usr/bin/env node
// Capture a raw MARTA bus TripUpdates protobuf snapshot to
// data/marta/captures/. Prints a one-line summary so an empty/broken feed is
// caught at capture time.
const { TRIP_UPDATES_URL, decodeFeed, parseTripUpdate } = require('../../src/marta/bus/api');
const { saveCapture } = require('../../src/marta/captureUtil');
const axios = require('axios');

async function main() {
  const { data } = await axios.get(TRIP_UPDATES_URL, {
    responseType: 'arraybuffer',
    timeout: 30000,
  });
  const buf = Buffer.from(data);
  const feed = decodeFeed(buf);
  const updates = (feed.entity || []).map(parseTripUpdate).filter(Boolean);
  const stopUpdates = updates.reduce((n, u) => n + u.stopUpdates.length, 0);
  const path = saveCapture('bus-tripupdates', '.pb', buf);
  console.log(
    `Saved ${buf.length} bytes → ${path}\n` +
      `  feedTimestamp=${feed.header?.timestamp} trips=${updates.length} stopUpdates=${stopUpdates}`,
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
