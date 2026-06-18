# MARTA official alerts

How the bot republishes MARTA's official service alerts, built on MARTA's native
GTFS-realtime / OTP feeds. Covers the official-alert republish path that posts to
the **alerts** Bluesky account (`martaalertinsights`). For the bot-*detected*
disruptions that also post from this account, see
[`THIN_GAPS_AND_PULSE.md`](./THIN_GAPS_AND_PULSE.md) (route blackouts) and the
detector docs ([`GAPS.md`](./GAPS.md), [`GHOSTING.md`](./GHOSTING.md)).

Server-side pairing of official alerts with bot-detected issues into
`alerts.json` (plan Phase 6) is **not built yet** — this doc covers the alert
ingestion + republish lifecycle that feeds it.

## Feeds — OTP primary, `.pb` secondary

There are two sources, merged in `src/marta/alert/api.js#fetchAlerts` →
`{ feedTimestamp, alerts[] }`. Each alert is tagged `source: 'otp' | 'gtfsrt'`.

1. **OTP GraphQL (primary)** — `src/marta/alert/otp.js`. The documented GTFS-rt
   ServiceAlerts protobuf below has been **empty at every capture**; the alerts
   riders actually see on `itsmarta.com/ride/alerts` come from the same
   undocumented OpenTripPlanner backend that carries the streetcar:

   ```
   https://tracker.itsmarta.com/otp/routers/default/index/graphql   { alerts { … } }
   ```

   No auth. Gives both route forms — `shortName` (public "49"/"Green") and
   `gtfsId` (internal "MARTA:26926"). OTP alerts come in two kinds, by decoded id:
   - `cancellation-alert-<routeInternalId>` — MARTA's whole-day, forward-looking,
     per-route **trip-cancellation prose**. **Dropped here** and handled instead
     by the bus cancellation rollup (below), which counts the structured
     TripUpdates CANCELED flags so it can't diverge from the ghost detector. The
     drop is keyed strictly on the id, NOT on mode.
   - `alert-<num>` — every other service alert, **any mode**: rail/general
     disruptions AND bus detours, reroutes, suspensions, service changes. These
     flow through the normal republish lifecycle.

2. **GTFS-rt `.pb` (secondary)** — `src/marta/alert/api.js#fetchPbAlerts`,
   `FULL_DATASET` protobuf, parsed like Metra's. Kept and merged in case MARTA
   ever populates it (OTP wins id ties). Either source failing is tolerated.

   ```
   https://gtfs-rt.itsmarta.com/TMGTFSRealTimeWebService/alert/alerts.pb
   ```

"Gone from the (merged) feed" = "cleared." Capture a `.pb` sample with
`scripts/marta/capture-alerts.js`.

## Significance gate — `src/marta/alert/significance.js`

Pure functions. Errs toward silence: a missed alert is recoverable, but
elevator/ADA/construction spam trains followers to ignore the feed.

- **Relevance.** MARTA is a single agency, so any alert scoped to it (a
  route/stop/trip informed entity, or an agency-wide notice) is relevant.
  Relevance is deliberately **not** gated on a route roster — see the routeId
  caveat below.
- **Admit/veto.** A strong structured `effect` (`NO_SERVICE`, `REDUCED_SERVICE`,
  `SIGNIFICANT_DELAYS`, `DETOUR`, `MODIFIED_SERVICE`) always admits. Otherwise the
  gate depends on the source:
  - **OTP** alerts are MARTA's editorially curated rider-facing alerts (the
    cancellation noise is already dropped upstream), so they **admit unless purely
    a MINOR notice** — requiring a MAJOR keyword would drop genuine reduced-service
    alerts whose prose doesn't match (e.g. *"Green line is only servicing from
    Bankhead to Ashby"*).
  - **`.pb`** alerts use the original keyword gate: a MAJOR hit (suspended,
    detour, single-tracking, shuttle, …) required, overriding a MINOR hit
    (elevator, parking, construction, fare/ticketing, …).
- **Mode.** Each alert is tagged `bus | rail | streetcar | general` from
  `informedEntity.routeType` (1/2 → rail, 3 → bus) or a rail-line-name match on
  `routeId`. Rail wins when an alert spans modes. This `mode` is the agency/mode
  field the website export will key on.

## Display name — `src/marta/alert/displayName.js`

MARTA's own `alertHeaderText` is generic (*"Rail Service Alert for Green Line"*,
*"Rail Service Alert for Red/Gold lines"*) — useless for scanning a list. The
real information is in the description prose and the structured `effect`.
`buildAlertDisplayName({ header, description, mode, routes, effect })` is a pure
helper that synthesizes a short, scannable name:

- **Subject** — the affected line(s)/route(s): `Green Line`, `Red/Gold Line`,
  `Streetcar`, `Route 110`, `Routes 110, 49`, or `MARTA` (agency-wide).
- **Nature** — the disruption phrase, keyword-scanned over header + description
  first (most precise: `single-tracking`, `service suspended`, `partial
  service`, `shuttle service`, `detour`, `station closure`, `delays`, …), then
  the structured `effect`, then a generic `service alert`.

Result: *"Green Line partial service"*, *"Route 110 detour"*. It deliberately
**omits the station segment** — that surfaces as a separate `from → to` subtitle
on the website (from `scope.from_station`/`to_station`), not in the name.

**Fallback.** Only when we pin down *neither* a route subject (so subject falls
to `MARTA`) *nor* a recognizable nature (so it falls to `service alert`) does the
synthesized name lose to MARTA's own wording — there it returns the **raw
`alertHeaderText`** instead of the vaguer *"MARTA service alert"*. A real route
subject is always kept (*"Green Line service alert"* beats *"Rail Service Alert
for Green Line"*). With no header to fall back to, it stays *"MARTA service
alert"*.

Used in both places so the bot post and the website never diverge:

- **Bluesky post** (`significance.js#buildAlertText`) leads with the name; MARTA's
  verbatim prose still follows in the body. The resolution reply uses it too.
- **Website export** (`bin/marta/export-web.js`) emits it as `official_alert.headline`
  (and rewrites each `versions[].headline`, since the site's "stable
  first-version headline" drives the title). `description` keeps MARTA's verbatim
  text. Re-derived at export — nothing is stored, so it backfills historical
  alerts on the next run.

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
- Station fields: `affected_from_station`, `affected_to_station`, and
  `mentioned_stations` (JSON array) are filled at ingest for **rail** alerts by
  `src/marta/alert/stations.js`, which resolves the station names in the alert
  prose ("from Bankhead to Ashby") to canonical roster names. The web export
  surfaces them in the official-alert `scope` so an alert ties to its
  `/station/:slug` pages. `ensureSchema()` migrates older DBs (the prod store
  predates these columns); re-run `npm run marta:backfill-alert-stations`
  (`--apply` to write) once after deploy to fill alerts ingested before the
  change.

## Rail station roster — `src/marta/rail-stations.json`

The heavy-rail station roster (`{ name, lines }`) the alert extractor resolves
against. Generated from the static GTFS by
`npm run marta:build-rail-stations`; names match the website's bundled
`trainStations.json` so they slugify to the same `/station/:slug` pages.
Regenerate after a GTFS refresh that changes the rail station set or line
assignments.

## Bin — `bin/marta/alerts.js`

One-shot cron job (`MARTA-INSIGHTS` block, every 2 min → ~6-min clear window).
Posts new significant alerts to `martaalertinsights`, refreshes `last_seen` for
ones already posted, and runs the feed-drop resolution sweep. Guards: an empty
feed skips the sweep (flicker), and an alert still in the feed but no longer
significant is closed **silently** (no misleading "resolved" reply).

Boundaries (feed + Bluesky) are injected via `bin.io` for testing — see
`test/marta/alertsFlow.test.js`. Dry run: `MARTA_ALERTS_DRY_RUN=1 node bin/marta/alerts.js`.

## Bus cancellation rollup — `bin/marta/bus/cancellations.js`

MARTA cancels individual bus trips constantly; republishing each one would flood
the alerts feed. Instead — mirroring the Metra cancellation rollup — cancellations
are posted as **one hourly per-route digest** to `martaalertinsights`,
fire-and-forget (no thread/clear lifecycle). Silent when nothing's new.

- **Source is the structured GTFS-rt TripUpdates `CANCELED` flag**, the *same*
  source the bus ghost detector subtracts (`src/marta/bus/ghosts.js`:
  `unexplainedMissing = missing − canceledTrips`). Using one cancellation dataset
  for both surfaces means the alerts-account total and the insights-account ghost
  context can't contradict each other. We deliberately do **not** count OTP's
  `cancellation-alert` prose — it's a different measurement (whole-day *announced*
  vs. live *annulled*) and verified non-overlapping (2026-06-17).
- Pure helpers in `src/marta/bus/cancellations.js` (extract distinct trips,
  per-route summary, 300-grapheme digest with "+N more routes" overflow). Dedup
  ledger in `src/marta/bus/cancellationStore.js` (`bus_cancellations`, keyed on
  `(trip_id, service_date)`) so each canceled trip is reported exactly once across
  overlapping hourly windows. Dry run: `MARTA_ALERTS_DRY_RUN=1 node bin/marta/bus/cancellations.js`.

## Rail single-departure cancellations — `src/marta/alert/cancellation.js`

MARTA announces individual cancelled rail trains in the prose of an otherwise
generic OTP alert (header `"Rail Service Alert for Blue Line"`, body e.g. *"...the
3:59 p.m. Blue line departure from Indian Creek is cancelled. Delays continuing
on the Blue line."*). These are a **point-in-time fact**, not an open
disruption, so they're modeled as a single-departure cancellation instead of the
ordinary ongoing→resolved lifecycle.

`classifyRailCancellation({ headline, description, line, anchorTs })` is a pure
parser (no feed/DB) that reads the alert prose rather than resolving a GTFS
schedule. It classifies an alert as a
cancellation **only when a specific cancelled departure is named** — a clock time
in the same sentence as cancellation language. It returns the line, the parsed
scheduled-departure ms (the clock time anchored to the alert's service day in
America/New_York), the origin (optional), and a structured `title` like
`"3:59 PM Blue Line departure from Indian Creek cancelled"`. Vague
reduced-service / single-tracking / suspension alerts that name no specific
departure return `null` and keep the ordinary ongoing→resolved model.

Two consumers:

- **`bin/marta/export-web.js`** attaches an incident-level
  `status: { type:'cancellation', state, scheduled_departure_ts, origin, line,
  title }` block. `state` is computed server-side from `now` vs the parsed
  departure: `upcoming` before it, `cancelled` after (terminal). A cancellation
  incident is **excluded from the alert↔bot merge** (mirrors the CTA export's
  planned-Metra guard) so it never absorbs an unrelated same-line gap/bunch/ghost
  on time proximity.
- **`bin/marta/alerts.js`** treats a cancellation as terminal: when it drops from
  the feed it's closed **silently** (no "✅ resolved" reply) — a cancelled train
  doesn't get "resolved."

The website (`atlanta-transit-alerts`) renders the `status` block as a
cancellation pill + structured title instead of an ongoing/resolved pill and
duration timer (`src/lib/cancellation.js`).

## Known limitations / follow-ups

- **`routeId` form: RESOLVED (2026-06-17).** OTP supplies both the public
  `shortName` and the internal `gtfsId`; the adapter surfaces the public form as
  `routeId`. (The long-empty `.pb` feed is what left this open.)
- **Streetcar mode is best-effort.** GTFS `route_type 0` is the streetcar, but
  protobuf decodes an *absent* int field as 0 too, so a bare `0` is ambiguous and
  not trusted. Streetcar alerts currently fall through to `general` unless a rail
  line name matches; recognizing the streetcar route by id is a follow-up.
- **Resolution replies are text-only.** The archive-page link card (as the CTA
  accounts attach) waits for the website + `data.atlantatransitalerts.app`
  (plan Phase 8/9).
