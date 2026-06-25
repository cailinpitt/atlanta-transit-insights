# MARTA thin-gaps + pulse (low-frequency / blackout detection)

The mainline bus detectors are structurally blind to low-frequency and fully
silent routes:

- **gaps** needs ≥2 buses on the same shape (`group.length < 2 → skip`).
- **ghosts** needs `MISSING_ABS_THRESHOLD = 3` missing trips.
- **bunching** needs ≥2 co-located buses.

So a 30-min-headway route that simply stops running, or a frequent route that
goes completely dark, produces no detection. CTA closed this with two extra
detectors; this is the MARTA port (2026-06-16, from the suppression audit).

## thin-gaps — low-frequency routes (`bin/marta/bus/thin-gaps.js`)

Eligible routes: bus routes whose **current scheduled headway ≥ 20 min**
(`headwayForLine`). For each, ask a binary question: has *any* bus been observed
in `max(2 × headway, 60 min)`? If not — and the route has steady-state service
in both the prior and next hour (ramp-up / wind-down guards) — fire.

- Pure core: `src/marta/bus/thinGaps.js` (verbatim CTA port).
- One post per route per day (24h cooldown); rollup thread to the bus account.
- Records an `observed-thin` row in `disruption_events` (standalone website
  incident) + a `thin-gap` `meta_signal` (roundup correlation).
- Threads a "buses observed on the route again" clear reply when a bus reappears;
  a synthetic (no-reply) clear closes firings older than the 24h reply window.

## pulse — route blackouts (`bin/marta/bus/pulse.js`)

The complement: bus routes whose **current headway < 20 min** (higher-frequency).
Fires when a route that should have **≥2 active buses** shows **zero distinct
vehicles** in a headway-scaled lookback (3× longest-direction headway, clamped to
25–60 min) while the rest of the fleet reports normally.

- Pure core: `src/marta/bus/pulse.js` (verbatim CTA `detectBusBlackouts`; CTA's
  `heldClusters` sub-detector is **deferred**).
- Guards: feed-stale (newest fleet observation > 5 min → upstream outage),
  pipeline-wide-quiet (<5 other active routes), cold-start grace (no obs in 6h),
  lookback-quiet probe (ramp), and wind-down (last 30 min of final service hour).
- 2h re-post cooldown; records `observed` / `pulse-cold`.
- Posting (CTA parity, like rail pulse): one post **per blacked-out route** to
  **`@martaalertinsights`** (a blackout is a service disruption, not an insight,
  so it goes to the alerts account — not the bus insights account). Each post
  carries a **dimmed-route blackout map** (`map/busDisruption.js#renderBusDisruptionMap`:
  the whole route drawn solid-but-dimmed with both terminals labeled from the
  GTFS headsigns) and threads **under any open official MARTA bus alert** for the
  route (`alert/store.js#findUnresolvedAlertForRoundup`).
- Clear reply ("buses observed on the route again") threads under the open
  official alert when one is up, otherwise under the original pulse post, and
  carries a **resolved-event link card** back to the archive.

The 20-min headway boundary partitions the two *at a single instant*. But the
split is evaluated against the **current hour's** headway (`headwayForLine` is an
hourly bucket), and these are separate cron jobs that run minutes-to-hours apart.
A route whose scheduled headway straddles 20 min across the day (e.g. Route 187:
`20` most hours, `19.5` at 10:00, `19` at 16:00) can therefore be claimed by
thin-gaps in one hour and by pulse the next *for the same ongoing silence* — two
standalone incidents on two accounts. So each detector also **defers to an
already-open silence from the other**: before firing route R, pulse skips R if an
un-cleared `observed-thin` disruption exists for it, and thin-gaps skips R if an
un-cleared `observed` (pulse) disruption exists. Because `observed-clear` is
line-keyed and shared, whichever detector posts the clear releases the
suppression for both, guaranteeing **at most one open silence incident per route**
regardless of which side of the boundary it landed on.

## rail pulse — dead track segments (`bin/marta/rail/pulse.js`)

The rail analog of the CTA train pulse: it flags a **stretch of track between
stations that no train has passed through when the schedule says one should
have** — e.g. a stalled or suspended corridor. The mainline rail **gap** detector
(`src/marta/rail/gaps.js`) is blind to this because it needs ≥2 live trains on the
line to measure a hole *between* them; a stalled or fully-dark corridor produces
no pair to compare.

- Pure core: `src/marta/rail/pulse.js` (`detectDeadSegments`, `detectFeedGap`),
  the CTA `src/train/pulse.js` port collapsed to MARTA's four point-to-point lines
  and N/S/E/W feed directions. One representative geometry per line
  (`rail/lines.js`); the detector bins each line by along-track distance and scans
  **once per feed direction**, treating a bin as "cold" when no train going that
  direction has projected into it within `max(2.5× headway, 15 min)` (verbatim CTA
  thresholds; the 1-station "solo" admit path needs 3.5× headway).
- A candidate is admitted via any of three paths: `passLong` (run ≥ 2 mi),
  `passMulti` (≥ 2 stations inside the cold run), or `passSolo` (≥ 1 station +
  ≥ 3 expected-but-missed trains + ≥ 3.5× headway cold). Generic FP guards kept
  from CTA: terminal-zone clip, active-service-range clip + pinned ranges, ramp-up
  (2 h lookback), fast-traversal ("crossed"), feed-gap, cold-start / sparse-
  coverage / sparse-span, terminal-adjacency margin, dispatch-continuity, plus the
  inferred-held reclassification (relabels a cold run as "trains stuck" when a
  train's GPS goes silent stationary mid-segment). CTA's Loop-trunk / Express-
  overlay / round-trip-turnaround machinery is dropped (no MARTA analog).
- Posts to **`@martaalertinsights`** (not the train account) — it's framed as a
  service disruption, threads under any open official MARTA rail alert for the
  line (`alert/store.js#findUnresolvedRailAlertForLine`), and ✅-clears. Renders a
  CTA-style **suspended-segment map**: the affected stretch is drawn solid but
  dimmed (0.4 opacity) between white station-pin markers, the rest of the line
  bright (`map/railIncidents.js#renderRailDisruptionMap`).
- Per-(line, direction) debounce lives in the `pulse_state` table
  (`src/marta/storage.js`): posts after `MIN_CONSECUTIVE_TICKS = 3` ticks of
  ≥ 50% run overlap, clears after `CLEAR_TICKS_TO_RESET = 5` clean ticks;
  `active_post_uri` pins the canonical post. When a whole line goes dark while the
  schedule says it should run, a **synthetic full-line candidate** is flagged.
- Records `observed` / `observed-held` (and `observed-clear`) `disruption_events`
  with the from/to segment in `evidence`; the web export surfaces them standalone.
- Cron: `rail-pulse`, every 2 min (even minutes, offset from the official-alerts
  job) in `cron/marta-crontab.txt`.

## Website surfacing

Unlike a lone gap/bunch/ghost (which only reaches the site folded into a roundup
or official alert), thin-gap and pulse firings surface **standalone** — a silent
route has no co-occurring signal to correlate. `bin/marta/export-web.js`
(`readDisruptions`) reads posted `observed-thin` → `thin-gap`, `observed` /
`observed-held` → `pulse-cold` rows, pairs each with the next `observed-clear` on
the same line, and emits a `['bot']` incident with the firing→clear lifecycle.
Rail dead-segment rows (`kind = 'rail'`) carry the from/to segment in `evidence`,
so their incident description names the stretch (`Gold Line trains not moving
between Lenox and Chamblee`) and `scope.near_stop` carries `"<from> ↔ <to>"`; bus
route-silence rows keep their whole-route phrasing.

## Gap cooldown alignment

Independently, `incidents.gapCooldownAllows` was aligned with CTA: a within-1h gap
re-posts when it clears a **decaying margin** (1.25× when the prior post is fresh
→ 1.1× as it ages) **or** when it's a **sustained severe** gap (≥20 min after the
prior post and still ≥3.0× headway). This replaced a flat 1.25× that suppressed
sustained/aged escalations CTA re-posts.

## Files

- `src/marta/bus/thinGaps.js`, `bin/marta/bus/thin-gaps.js`
- `src/marta/bus/pulse.js`, `bin/marta/bus/pulse.js` — bus blackout core + bin
  (per-route posts to `@martaalertinsights`, blackout map, official-alert threading).
- `src/marta/map/busDisruption.js#renderBusDisruptionMap` — dimmed full-route
  blackout map with labeled terminals.
- `src/marta/alert/store.js#findUnresolvedAlertForRoundup` — bus pulse + roundup
  open-alert threading.
- `src/marta/rail/pulse.js`, `bin/marta/rail/pulse.js` — rail dead-segment core +
  bin (posts to `@martaalertinsights`).
- `src/marta/rail/disruptionPost.js` — rail disruption post/alt/clear text.
- `src/marta/map/railIncidents.js#renderRailDisruptionMap` — suspended-segment map.
- `src/marta/alert/store.js#findUnresolvedRailAlertForLine` — open-alert threading.
- `src/marta/shared/incidents.js` — `disruption_events`, `recordDisruption`,
  `findUnresolvedDisruptions`, `hasObservedClearForPulse`, decaying/sustained
  `gapCooldownAllows`.
- `src/marta/storage.js` — `getLastBusObservationTs`,
  `countDistinctBusObservationTs`, `getDistinctBusRoutesSince`; `pulse_state`
  table + `getPulseState` / `listPulseStateForLine` / `upsertPulseState` /
  `clearPulseState`.
- `src/marta/rail-stations.json` (+ `scripts/marta/build-rail-stations.js`) — now
  carries per-station `lat`/`lon` (the detector projects stations onto the line).
- `bin/marta/export-web.js` — `readDisruptions` / standalone disruption incidents.
- Tests: `test/marta/{thinGaps,pulse,gapCooldownAllows,railPulse}.test.js`.
- Cron: `bus-thin-gaps` (15 min), `bus-pulse` (5 min), `rail-pulse` (2 min) in
  `cron/marta-crontab.txt`.
