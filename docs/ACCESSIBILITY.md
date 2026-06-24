# MARTA accessibility archive

Capture-only archive for MARTA elevator, escalator, entrance, and accessibility
notices. These alerts are deliberately not posted to Bluesky; the timeline gate
still treats them as minor, while this pipeline preserves the current status and
recent history for the website's `accessibility.json`.

## Source

`bin/marta/accessibility.js` reuses the same merged official-alert fetch as the
republisher: `src/marta/alert/api.js#fetchAlerts`, with OTP GraphQL primary and
the documented GTFS-rt protobuf secondary. No extra login or posting is involved.

The gate in `src/marta/accessibility.js` keeps an alert when:

- `effect === "ACCESSIBILITY_ISSUE"`, or
- the header/description mentions elevator, escalator, accessibility, or
  entrance text.

This is intentionally separate from `src/marta/alert/significance.js`; loosening
the Bluesky significance gate would make routine unit outages noisy.

## Parsing

MARTA's feed carries station and unit details in prose, not structured fields.
The parser scans the combined header and description, longest-matches against
`src/marta/rail-stations.json`, and emits:

- `stationName` and `stationSlug` when the station resolves to the rail roster.
- `stationName` with `stationSlug: null` when prose names a station we cannot
  resolve. The website can still show the outage, just without a station link.
- `unitType`: `elevator`, `escalator`, `entrance`, or `other`.
- `unitLabel`: the clause near the unit keyword when present, such as "to the
  Red/Gold Line platform".

Resolved station slugs use the same slug rules as the website station roster.

## Storage

Rows live in `accessibility_outages` in the shared MARTA SQLite database
initialized by `src/marta/storage.js`.

`upsertAccessibilityOutages(rows, now)` creates or refreshes active rows keyed by
the upstream alert id. `reconcileAccessibilityOutages(seenIds, now)` marks active
rows restored after `ACCESSIBILITY_CLEAR_TICKS` consecutive missing feed ticks,
backdating `restored_ts` to the first missing tick. A reappearing source id
reopens the same row and clears `restored_ts`.

Retention is 180 days for restored outages. Active outages are never rolled off.

## Export

`bin/marta/export-accessibility.js` writes schema-versioned
`accessibility.json`:

```json
{
  "schema_version": 1,
  "generated_at": 1781920688280,
  "data_start_ts": 1781458745342,
  "window_days": 180,
  "outages": []
}
```

`bin/marta/push-web-data.sh` exports and uploads it beside `alerts.json`,
`daily-counts.json`, and `alerts.csv`, then triggers the same site rebuild when
the data changes.
