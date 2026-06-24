#!/usr/bin/env node
require('../../src/shared/env');

// One-shot backfill: re-match stored accessibility outages whose station never
// resolved. The ingest path (bin/marta/accessibility.js) only writes station
// fields while an alert is live; a restored elevator/escalator alert drops out
// of the feed, so rows stored before a station-matching fix keep their null
// station and render as "Unmatched station" on the site forever. This re-runs
// the current parser over each row's stored headline + description and fills in
// any match that now resolves. Idempotent and safe to re-run; pass --dry-run to
// preview without writing.
const { parseStationAndUnit } = require('../../src/marta/accessibility');
const { getAccessibilityOutages, updateAccessibilityStation } = require('../../src/marta/storage');

const DRY_RUN = process.argv.includes('--dry-run');

function textForRow(row) {
  return [row.headline, row.description].filter(Boolean).join(' ');
}

function main() {
  const rows = getAccessibilityOutages(0);
  let updated = 0;
  for (const row of rows) {
    if (row.stationSlug) continue; // already matched — leave it alone
    const parsed = parseStationAndUnit(textForRow(row));
    if (!parsed.stationSlug) continue; // still unresolved by the current parser
    console.log(
      `${row.sourceId}: "${row.stationName ?? '(none)'}" -> ${parsed.stationName} ` +
        `[${parsed.stationLines.join(', ')}] (${parsed.stationSlug})`,
    );
    if (!DRY_RUN) {
      updateAccessibilityStation(row.sourceId, {
        stationName: parsed.stationName,
        stationSlug: parsed.stationSlug,
        lines: parsed.stationLines,
      });
    }
    updated += 1;
  }
  console.log(
    `${DRY_RUN ? '[dry-run] would update' : 'updated'} ${updated} of ${rows.length} ` +
      'accessibility outages',
  );
}

if (require.main === module) {
  main();
}

module.exports = { main };
