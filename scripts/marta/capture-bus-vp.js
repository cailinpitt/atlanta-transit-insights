#!/usr/bin/env node
// Capture a raw MARTA bus VehiclePositions protobuf snapshot to
// data/marta/captures/. Decodes it to print a one-line summary so a bad/empty
// feed is obvious at capture time. Raw bytes are kept verbatim (no re-encode)
// so fixtures reflect exactly what MARTA serves.
const {
  VEHICLE_POSITIONS_URL,
  decodeFeed,
  parseVehiclePosition,
} = require('../../src/marta/bus/api');
const { saveCapture } = require('../../src/marta/captureUtil');
const axios = require('axios');

async function main() {
  const { data } = await axios.get(VEHICLE_POSITIONS_URL, {
    responseType: 'arraybuffer',
    timeout: 30000,
  });
  const buf = Buffer.from(data);
  const feed = decodeFeed(buf);
  const vehicles = (feed.entity || []).map(parseVehiclePosition).filter(Boolean);
  const withSpeed = vehicles.filter((v) => v.speed != null).length;
  const path = saveCapture('bus-vehiclepositions', '.pb', buf);
  console.log(
    `Saved ${buf.length} bytes → ${path}\n` +
      `  feedTimestamp=${feed.header?.timestamp} vehicles=${vehicles.length} withSpeed=${withSpeed}`,
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
