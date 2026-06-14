# MARTA feeds — validated reality

What the MARTA data feeds actually contain, verified against captured fixtures
(`test/marta/fixtures/`) rather than the developer docs. This is the ground
truth the detector port reasons about; update it when a capture surprises us.

Capture tooling:

- `scripts/marta/fetch-static-gtfs.js` — static GTFS → `data/marta/gtfs/`
- `scripts/marta/capture-bus-vp.js` — bus VehiclePositions snapshot
- `scripts/marta/capture-bus-tu.js` — bus TripUpdates snapshot
- `scripts/marta/build-bus-fixtures.js` — trim captures into committed fixtures

Adapters: `src/marta/bus/api.js` (GTFS-rt) and `src/marta/gtfs.js` (static + the join).

## Static GTFS — `itsmarta.com/google_transit_feed/google_transit.zip`

Public, unauthenticated, ~20 MB. **86 routes**: 81 bus (`route_type=3`),
4 rail (`route_type=1`), 1 streetcar (`route_type=0`). ~52k trips, ~7k stops.

Rail lines and brand colors (from `routes.txt`):

| route_id | line  | color   |
|----------|-------|---------|
| 26987    | RED   | CE242B  |
| 26985    | GOLD  | D4A723  |
| 26984    | BLUE  | 0075B2  |
| 26986    | GREEN | 009D4B  |
| 26982    | Atlanta Streetcar | FF00FF |

Stations: 44 parent stations (`location_type=1`), 214 child platforms
(`parent_station` set). Use parent↔child for station/platform pages.

## Bus GTFS-realtime — `gtfs-rt.itsmarta.com/TMGTFSRealTimeWebService/…`

Standard GTFS-rt v2.0 protobuf, public, **no API key**. `FULL_DATASET` each
poll. Two endpoints: `vehicle/vehiclepositions.pb`, `tripupdate/tripupdates.pb`.

### The realtime → static join

The single most important fact: **the realtime feed reports the *public* route
number in `trip.routeId`** (e.g. `"20"`), **not** the internal GTFS `route_id`
(e.g. `26915`). The stable shared key is `trip_id`. Canonical route:

```
realtime entity ──trip_id──▶ trips.txt ──route_id──▶ routes.txt
```

`gtfs.resolveRoute({ tripId, realtimeRouteId })` does this, falling back to
`route_short_name` only when a trip is missing from a stale static feed. The
realtime public number happens to equal `route_short_name`, which the join
asserts as a drift check (`shortNameMatches`).

### VehiclePositions

One entity per active vehicle (~180 observed midday).

| field | notes |
|-------|-------|
| `trip.tripId` | join key |
| `trip.routeId` | **public route number**, not `route_id` |
| `trip.directionId` | **UNRELIABLE** — observed values 0, 5, 9, 11, 14. Ignore it; take `direction_id` from `trips.txt`. |
| `position.lat/lon` | always present |
| `position.bearing` | usually present |
| `position.speed` | **only ~57% of vehicles**, metres/second, quantized to ~5 mph steps (max ~26.8 m/s ≈ 60 mph). Detectors must tolerate `null`. |
| `vehicle.id` / `.label` | fleet id + run number |
| `occupancyStatus` | usually present |

`parseVehiclePosition` deliberately **omits** `directionId` so nothing
downstream is tempted to trust it. It distinguishes on-wire `speed`/`bearing`
from protobufjs prototype defaults via own-property checks.

### TripUpdates

One entity per active trip (~365 observed midday), with predicted **and**
scheduled stop times.

- `trip.{tripId, routeId, startTime, startDate}` — `directionId` present here but
  same caveat as above.
- `stopTimeUpdate[]`: `stopSequence`, `stopId`, `arrival`/`departure`
  `{ time, scheduledTime }`.
- MARTA does **not** populate GTFS-rt `delay`. Schedule adherence is therefore
  `arrival.time − arrival.scheduledTime` (positive = late), exposed as
  `scheduleDeviationSec`.

## Not yet validated

- **Rail REST** (`developerservices.itsmarta.com:18096/…`) — needs
  `MARTA_TRAIN_KEY`; the rail feasibility gate (plan Phase 5).
- **Official alerts** — no documented stable API; source-adapter spike pending
  (plan Phase 6).
