# Adherence (schedule on-time-ness)

How the bots know — and say — how early or late a specific bus or train is. Two surfaces draw on it:

1. **Per-vehicle annotations** — every post that names individual vehicles (bunching, gaps, cross-route/line clusters) tags each one with its adherence: `#1234 (1️⃣, 12 min late)`, `Last seen: #305 (on time) · Next up: #408 (3 min late)`.
2. **Rail "running late" rollup** — a periodic digest of rail lines whose trains are materially behind schedule (`@martatraininsights`), silent on an on-time day.

Wording comes from `formatDeviation` (`src/marta/shared/format.js`): `"12 min late"` / `"3 min early"` / `"on time"`, or omitted when we can't place the vehicle confidently.

## Two very different data paths

### Rail — straight from the feed (`src/marta/rail/adherence.js`)

The rail `traindata` feed carries a signed per-train delay (`DELAY` = `"T-21S"` 21 s early, `"T249S"` 249 s late), stored as `rail_observations.delay_sec`. `railDeviationsByTrain` reduces the window to each train's latest delay in minutes; the bins pass that map to the bunching / gap / cross-line post builders. The rollup (`summarizeLineAdherence` → `bin/marta/rail/adherence.js`) rolls the same delays up per line.

### Bus — projected from position (`src/marta/bus/adherence.js`)

MARTA's bus feed reports no delay, so (like CTA) we back it out of geometry: project the bus's live `(lat, lon)` onto its trip's **scheduled stop-path** and read the interpolated scheduled time at that point, then compare to the wall clock. The realtime feed gives the exact GTFS `trip_id` on every vehicle, so the curve is looked up directly in `data/marta/schedule.sqlite` (`sched_stops`, built nightly by `scripts/marta/build-schedule-stops.js`) — no disambiguation needed.

Two guards keep it honest, and crucially drop the **recycled-trip-id** garbage that makes raw arrival-prediction deltas unusable (a morning trip id still emitting at night projects to a morning schedule → a 12-hour "delay"):

- `MAX_OFFROUTE_FT` (600) — too far off the trip's path to credibly be on it.
- `MAX_PLAUSIBLE_DEV_MIN` (45) — absurd lateness is a bad match or a service-day wrap.

On either, `scheduleDeviationMin` returns null and the post just shows the bare vehicle number. On live data ~85% of buses get a usable deviation (median a few minutes late), matching CTA's quality.

`busDeviationsByVid` maps each vehicle's latest observation to its deviation; the bunching / gap / cross-route bins pass that map to the post builders.

## The "running late" rollup (`bin/marta/rail/adherence.js`)

Rail-only. Keeps lines with enough trains to trust (`MIN_TRAINS` 3) that are materially behind — median ≥ `MIN_MEDIAN_SEC` (3 min) **or** ≥ `MIN_LATE_TRAINS` (2) trains 5+ min late — and posts a threaded rollup, 1 h cooldown. Nothing qualifies → nothing posts. There's no bus rollup: per-bus adherence is surfaced inline on the detector posts instead.

## Build + cadence

| Job | Cron | Notes |
|---|---|---|
| `build-schedule-stops` | nightly `30 3` (after GTFS refresh) | rebuilds `schedule.sqlite`; required before bus annotations work |
| `rail-adherence` (rollup) | every 15 min (`11-59/15`) | 1 h cooldown; silent unless a line is materially late |

The per-vehicle annotations ride along on the existing bunching / gap / cross-route jobs — no new cron for those. All of this is descriptive and **Bluesky-only**; it does not flow to the website (`export-web.js` doesn't read it).
