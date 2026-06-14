#!/usr/bin/env node
// Capture a raw MARTA GTFS-rt ServiceAlerts snapshot to data/marta/captures/.
// No API key. The feed is often empty (no active alerts); run this repeatedly
// across days to catch a real alert for fixture/field-mapping work — especially
// to resolve whether informedEntity.routeId is the public number or internal id.
const axios = require('axios');
const { ALERTS_URL, decodeFeed, parseAlert } = require('../../src/marta/alert/api');
const { saveCapture } = require('../../src/marta/captureUtil');

async function main() {
  const { data } = await axios.get(ALERTS_URL, { responseType: 'arraybuffer', timeout: 30000 });
  const buf = Buffer.from(data);
  const feed = decodeFeed(buf);
  const alerts = (feed.entity || []).map(parseAlert).filter(Boolean);
  const path = saveCapture('service-alerts', '.pb', buf);
  console.log(
    `Saved ${buf.length} bytes → ${path}\n` +
      `  feedTimestamp=${feed.header?.timestamp} alerts=${alerts.length}`,
  );
  if (alerts.length) {
    console.log(
      '  ⚠ NON-EMPTY — good fixture candidate. effects:',
      alerts.map((a) => a.effect).join(', '),
    );
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
