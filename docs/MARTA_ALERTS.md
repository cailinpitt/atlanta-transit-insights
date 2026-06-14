# MARTA official alerts

The MARTA analog of [`ALERTS.md`](./ALERTS.md) (the CTA alerts pipeline), adapted
for MARTA's native GTFS-realtime feed. Covers the official-alert republish path
that posts to the **alerts** Bluesky account (`martaalertinsights`).

Server-side pairing of official alerts with bot-detected issues into
`alerts.json` (plan Phase 6) is **not built yet** — this doc covers the alert
ingestion + republish lifecycle that feeds it.

## Feed

Official alerts are a standard **GTFS-rt v2.0 ServiceAlerts** protobuf — public,
unauthenticated, same host as the bus feeds. No scraper, no API key.

```
https://gtfs-rt.itsmarta.com/TMGTFSRealTimeWebService/alert/alerts.pb
```

`FULL_DATASET` every poll, so "gone from the feed" = "cleared." Adapter:
`src/marta/alert/api.js` (`fetchAlerts` → `{ feedTimestamp, alerts[] }`), parsed
like Metra's. Capture a live one with `scripts/marta/capture-alerts.js`.

## Significance gate — `src/marta/alert/significance.js`

Pure functions; mirrors `src/metra/metraAlerts.js`. Errs toward silence: a missed
alert is recoverable, but elevator/ADA/construction spam trains followers to
ignore the feed.

- **Relevance.** MARTA is a single agency, so any alert scoped to it (a
  route/stop/trip informed entity, or an agency-wide notice) is relevant.
  Relevance is deliberately **not** gated on a route roster — see the routeId
  caveat below.
- **Admit/veto.** A strong structured `effect` (`NO_SERVICE`, `REDUCED_SERVICE`,
  `SIGNIFICANT_DELAYS`, `DETOUR`, `MODIFIED_SERVICE`) always admits. Otherwise
  keyword-driven over header + description, with a minor-wins veto: a MAJOR hit
  (suspended, detour, single-tracking, shuttle, …) overrides a MINOR hit
  (elevator, parking, construction, fare/ticketing, …).
- **Mode.** Each alert is tagged `bus | rail | streetcar | general` from
  `informedEntity.routeType` (1/2 → rail, 3 → bus) or a rail-line-name match on
  `routeId`. Rail wins when an alert spans modes. This `mode` is the agency/mode
  field the website export will key on.

## Lifecycle store — `src/marta/alert/store.js`

Owns `alert_posts` + `alert_versions` on the shared MARTA SQLite file (its own
lazily-created tables, alongside `incidents.js`). The alert analog of the
bot-detection incident store; both are read by the eventual `alerts.json` export.

- `recordAlertSeen` — upsert a sighting. Called twice per new alert (pre-post
  `postUri:null`, then post-post with the URI) so a crash between posting and the
  write is still detectable. Logs an `alert_versions` row when the rider-visible
  text (headline/description) or affected routes change.
- Feed-drop resolution: `incrementAlertClearTicks` advances an absent-from-feed
  counter; after `ALERT_CLEAR_TICKS` (3) consecutive misses the bot posts a
  "resolved" reply and `recordAlertResolved` stamps `resolved_ts` **backdated to
  the first missing tick** (cadence-independent).
- Flicker handling: a short drop-then-reappear reopens the same incident (keeps
  the resolution reply URI to avoid a duplicate clear); a reappearance after
  `ALERT_FLICKER_RESET_MS` (30 min) starts a fresh chapter under the same id.

## Bin — `bin/marta/alerts.js`

One-shot cron job (`MARTA-INSIGHTS` block, every 2 min → ~6-min clear window).
Posts new significant alerts to `martaalertinsights`, refreshes `last_seen` for
ones already posted, and runs the feed-drop resolution sweep. Guards: an empty
feed skips the sweep (flicker), and an alert still in the feed but no longer
significant is closed **silently** (no misleading "resolved" reply).

Boundaries (feed + Bluesky) are injected via `bin.io` for testing — see
`test/marta/alertsFlow.test.js`. Dry run: `MARTA_ALERTS_DRY_RUN=1 node bin/marta/alerts.js`.

## Known limitations / follow-ups

- **`informedEntity.routeId` form is unconfirmed.** The live feed was empty at
  discovery, so we haven't verified whether `routeId` is the public bus number /
  rail line name or the internal GTFS `route_id`. Mode tagging tolerates either;
  resolving routes against static GTFS for display is deferred until a live alert
  is captured.
- **Streetcar mode is best-effort.** GTFS `route_type 0` is the streetcar, but
  protobuf decodes an *absent* int field as 0 too, so a bare `0` is ambiguous and
  not trusted. Streetcar alerts currently fall through to `general` unless a rail
  line name matches; recognizing the streetcar route by id is a follow-up.
- **Resolution replies are text-only.** The archive-page link card (as the CTA
  accounts attach) waits for the website + `data.atlantatransitalerts.app`
  (plan Phase 8/9).
