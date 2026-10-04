# Ghost detection

How the bot decides that buses or trains are "missing" — running below the schedule MARTA publishes — and posts about it.

## What "ghosting" means

A **ghost** is the difference between the service MARTA promises and what's actually on the street or rails. If the schedule says seven buses should be running northbound on a route right now and we only see four, there are three ghost buses.

The bot only posts when the gap is large enough and consistent enough that it almost certainly reflects a real service problem — not a momentary blip in the data feed.

## The plain-English version

For each route or rail line, over the last hour, the bot asks two questions:

1. **How many vehicles *should* be running right now?** Pulled from MARTA's published GTFS schedule.
2. **How many vehicles are we actually seeing?** Pulled from the recorded live observations.

If "actually seeing" is meaningfully smaller than "should be running" — and stays that way across the whole window — the bot posts.

The post looks like this:

> 🚌 Route 110 (Peachtree) NB · 3 of 7 missing (43%) · every ~28 min instead of ~16

That's saying: Peachtree buses going north should come every 16 minutes; they're effectively coming every 28 because three of the seven that should be on the road aren't (16 × 7⁄4).

## The technical version

### Step 1 — the expected-service index (`activeByHour`)

`scripts/marta/build-schedule-index.js` builds `data/marta/schedule-index.json` from GTFS (rebuilt nightly by cron). Alongside the per-shape headways the [gap detector](./GAPS.md) uses, it records, per route+direction and hour-of-day, the **active-trip count** — the mean number of trips simultaneously in progress during that hour. This is the ground truth ghosting compares against.

The active-trip count is an area under the curve. For each scheduled trip we know its departure and arrival; for each hour the trip overlaps we add the fraction of that hour it was in progress:

```
active_in_hour_H += (min(arrival, H_end) - max(departure, H_start)) / 3600
```

A 90-minute trip running 16:30–18:00 contributes 0.5 to hour 16, 1.0 to hour 17, 0 to hour 18. Summed across all scheduled trips this gives the mean number of vehicles that *should* be simultaneously running, hour by hour — the apples-to-apples comparison for a snapshot count of live vehicles. (An earlier-generation `duration / headway` stand-in over-estimates during ramp hours and produces false ghosts at service start; the area-under-curve definition avoids that.)

### Step 2 — observing live service

The observe loop (`scripts/marta/observe-buses.js`, `scripts/marta/observe-rail.js`) records every active vehicle into `state/marta.sqlite` (`src/marta/storage.js`) at ~30s density, kept indefinitely. The ghost detector only looks back one hour.

### Step 3 — detecting ghosts

`bin/marta/bus/ghosts.js` and `bin/marta/rail/ghosts.js` run every 15 minutes over a **60-minute observation window**, calling `src/marta/bus/ghosts.js` / `src/marta/rail/ghosts.js`. `ghostsFromObservations` is the bridge. The core logic:

1. Pull the last hour of observations for each route/direction. Because MARTA buses are GTFS-realtime, `trip_id` gives direction directly — observations group by canonical `direction_id` with **no async pid→pattern resolution** (this is the big simplification over CTA).
2. Group into per-timestamp snapshots and count distinct vehicles in each.
3. Take the median → `observedActive`.
4. Look up `expectedActive` from `activeByHour`, using the **midpoint of the window** for time-of-day (not "now"), so a schedule transition mid-window doesn't mis-bucket.
5. Compute `missing = expectedActive − observedActive`. If it clears the gates, emit an event.

### Step 4 — gates against false positives

False-positive ghost posts are a credibility risk; the gates swallow ambiguous cases rather than over-call (`src/marta/bus/ghosts.js`, ported verbatim from CTA):

| Gate | Threshold | Rationale |
|---|---|---|
| `MISSING_PCT_THRESHOLD` | ≥ 25% | The deficit must be a real share of expected service, not 1 of 8. |
| `MISSING_ABS_THRESHOLD` | ≥ 3 vehicles | Avoids firing on routes with tiny absolute counts. |
| `MIN_SNAPSHOTS` | ≥ 4 | A floor that tolerates a sustained outage but still requires real evidence. |
| `MIN_OBSERVED` | ≥ 2 | "Missing 7 of 9" with observed 0–1 is a genuine outage (the gap detector handles those) or a feed bug. |
| `active < 2` floor | skip | Too sparse for a meaningful ghost call. |
| `MAX_EXPECTED_ACTIVE` | ≤ 30 | Sanity ceiling — > 30 usually means a bad GTFS bucket. |
| Stddev gate | `stddev ≤ observedActive` | Wildly swinging per-snapshot counts are observer instability, not missing vehicles. |
| Ramp-fill gate | tail-25% median ≥ 80% × expected (`RAMP_TAIL_FRACTION`) | If the *end* of the window shows healthy service, the deficit is at the front (service ramping up), not now. |

Rail detection (`src/marta/rail/ghosts.js`) reuses the same bus engine but compares **observed-vs-scheduled head-count at the line level** (`activeForLine`), sidestepping the rail feed's N/S/E/W ↔ GTFS `direction_id` mismatch.

### Step 5 — posting

Surviving events sort by `missing` desc and render into one Bluesky post, one line each. The count + effective-headway phrasing comes from `describeGhost` in **`src/shared/ghostFormat.js`** (shared infra, used as-is by MARTA). The headway shown is *effective* — scheduled headway scaled up by how much service is missing:

```
effective headway = scheduled headway × expectedShown / (expectedShown − missingShown)
```

So "3 of 7 missing" on a 16-min route → 16 × 7/4 = **~28 min**. Two deliberate properties: counts and headway derive from the *same* displayed integers (so the line is internally consistent and reproducible), and the effective headway is floored at the scheduled headway (a route missing buses is never reported as running *better* than schedule). When the deficit explodes (> 3× scheduled), it falls back to "scheduled around every ~X min."

If no events clear the gates, the bot stays silent — the correct answer most hours.

### Trailing-tail override

A whole-window `MISSING_ABS_THRESHOLD = 3` over-rejects mid-incident drops with less evidence accumulated. The override admits at `missing ≥ 2` (`MISSING_ABS_THRESHOLD_TRAILING`) when the deficit is concentrated in the last 25% of the window (`tailMedian < observedActive` and `trailingDeficit ≥ 2`). Steady whole-window under-counts of 2 still drop. Posted and near-miss firings write `meta_signals` rows so `bin/marta/incident-roundup.js` can fold them into the cross-detector roundup.

## A related but distinct case — silent low-frequency routes

The gates above need ≥ 2 expected vehicles and a measurable deficit, so they're structurally blind to a route that runs every 30+ minutes and goes *completely* dark. That case is handled separately by the thin-gap / pulse detectors — see [`THIN_GAPS_AND_PULSE.md`](./THIN_GAPS_AND_PULSE.md).

## Why this approach

MARTA publishes a schedule; live vehicle positions are public. The interesting signal isn't either feed alone — it's the gap between them, sustained over a window long enough to rule out polling noise. Almost everything in the code above is in service of *not* crying wolf.

## Files

- `scripts/marta/build-schedule-index.js` — builds the `activeByHour` index from GTFS.
- `scripts/marta/observe-buses.js`, `scripts/marta/observe-rail.js` — live observation loop.
- `src/marta/storage.js` — observation storage + count helpers.
- `src/marta/bus/ghosts.js`, `src/marta/rail/ghosts.js` — core detection and gates.
- `src/marta/bus/ghostPost.js`, `src/marta/rail/post.js` — post text.
- `src/shared/ghostFormat.js` — `describeGhost`: shared count + effective-headway phrasing.
- `bin/marta/bus/ghosts.js`, `bin/marta/rail/ghosts.js` — 15-minute entry points (cron).
