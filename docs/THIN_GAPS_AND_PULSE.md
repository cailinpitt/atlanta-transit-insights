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
- 2h re-post cooldown; records `observed` / `pulse-cold`; same clear-reply
  lifecycle as thin-gaps.

The 20-min headway boundary partitions the two cleanly so a route is never both a
thin-gap and a pulse candidate.

## Website surfacing

Unlike a lone gap/bunch/ghost (which only reaches the site folded into a roundup
or official alert), thin-gap and pulse firings surface **standalone** — a silent
route has no co-occurring signal to correlate. `bin/marta/export-web.js`
(`readDisruptions`) reads posted `observed-thin` → `thin-gap` and `observed` →
`pulse-cold` rows, pairs each with the next `observed-clear` on the same line, and
emits a `['bot']` incident with the firing→clear lifecycle.

## Gap cooldown alignment

Independently, `incidents.gapCooldownAllows` was aligned with CTA: a within-1h gap
re-posts when it clears a **decaying margin** (1.25× when the prior post is fresh
→ 1.1× as it ages) **or** when it's a **sustained severe** gap (≥20 min after the
prior post and still ≥3.0× headway). This replaced a flat 1.25× that suppressed
sustained/aged escalations CTA re-posts.

## Files

- `src/marta/bus/thinGaps.js`, `bin/marta/bus/thin-gaps.js`
- `src/marta/bus/pulse.js`, `bin/marta/bus/pulse.js`
- `src/marta/shared/incidents.js` — `disruption_events`, `recordDisruption`,
  `findUnresolvedDisruptions`, decaying/sustained `gapCooldownAllows`.
- `src/marta/storage.js` — `getLastBusObservationTs`,
  `countDistinctBusObservationTs`, `getDistinctBusRoutesSince`.
- `bin/marta/export-web.js` — `readDisruptions` / standalone disruption incidents.
- Tests: `test/marta/{thinGaps,pulse,gapCooldownAllows}.test.js`.
- Cron: `bus-thin-gaps` (15 min), `bus-pulse` (5 min) in `cron/marta-crontab.txt`.
