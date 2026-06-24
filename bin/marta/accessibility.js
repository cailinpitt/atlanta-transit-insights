#!/usr/bin/env node
require('../../src/shared/env');

const { setup, runBin } = require('../../src/marta/shared/runBin');
const { fetchAlerts } = require('../../src/marta/alert/api');
const { toOutageRows } = require('../../src/marta/accessibility');
const {
  upsertAccessibilityOutages,
  reconcileAccessibilityOutages,
} = require('../../src/marta/storage');

const DRY_RUN =
  process.argv.includes('--dry-run') || process.env.MARTA_ACCESSIBILITY_DRY_RUN === '1';

async function main({ now = Date.now() } = {}) {
  setup();
  const { alerts } = await fetchAlerts();
  const rows = toOutageRows(alerts, undefined, now).filter((r) => r.sourceId);
  const seenIds = new Set(rows.map((r) => r.sourceId));
  console.log(`Fetched ${alerts.length} MARTA alerts, ${rows.length} accessibility outages`);

  if (DRY_RUN) {
    for (const row of rows) console.log(JSON.stringify(row));
    return;
  }

  upsertAccessibilityOutages(rows, now);
  if (alerts.length === 0) {
    console.warn('MARTA returned 0 alerts — skipping accessibility reconciliation this tick');
    return;
  }
  reconcileAccessibilityOutages(seenIds, now);
}

if (require.main === module) {
  runBin(main);
}

module.exports = { main };
