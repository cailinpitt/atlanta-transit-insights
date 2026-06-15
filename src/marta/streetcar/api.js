// MARTA Atlanta Streetcar realtime adapter.
//
// The streetcar is absent from every *documented* MARTA feed — the GTFS-rt bus
// VehiclePositions feed carries no ATLSC route or streetcar fleet, and the rail
// `traindata` REST feed is heavy-rail only. But the public rider app
// (itsmarta.com/ride, live map tracker.itsmarta.com) is backed by an
// OpenTripPlanner (OTP1) GraphQL endpoint that DOES expose the streetcar with
// realtime vehicle positions. Source verified 2026-06-15.
//
//   Endpoint (public, no auth / API key, introspection enabled):
//     https://tracker.itsmarta.com/otp/routers/default/index/graphql
//   Streetcar route: MARTA:26982 — shortName "SC", "Atlanta Streetcar", mode TRAM.
//   Vehicle positions live under route.patterns[].vehiclePositions[].
//
// Caveats: this is the rider app's backend, NOT a published developer feed, so
// it can change without notice — parse defensively and poll politely. `speed`
// and `heading` come back null, so (like heavy rail) speed must be reconstructed
// from position deltas between polls, not read off the feed.
//
// Parsers are pure and exported so fixtures validate without network.
const axios = require('axios');
const { withRetry } = require('../../shared/retry');

const OTP_URL = 'https://tracker.itsmarta.com/otp/routers/default/index/graphql';

// GTFS route id for the Atlanta Streetcar in MARTA's OTP feed.
const STREETCAR_ROUTE_ID = 'MARTA:26982';
// Line key we store streetcar rows under — the streetcar analog of a rail LINE
// (RED/GOLD/BLUE/GREEN). Kept distinct so it never collides with heavy rail.
const STREETCAR_LINE = 'SC';

// One round-trip: every pattern's live vehicle positions for the streetcar route.
const VEHICLES_QUERY = `{
  route(id: "${STREETCAR_ROUTE_ID}") {
    patterns {
      directionId
      vehiclePositions {
        vehicleId
        label
        lat
        lon
        speed
        heading
        lastUpdate
        trip { gtfsId }
      }
    }
  }
}`;

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// OTP `lastUpdate` is an ISO-8601 string with offset, e.g.
// "2026-06-15T19:08:53-04:00". Date.parse honors the offset → epoch ms.
function parseLastUpdate(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// Flatten the route→patterns→vehiclePositions response into one record per live
// vehicle. `polledAt` (our fetch time) is the authoritative clock for position
// deltas; `eventTs` is the feed's own per-vehicle stamp. Shape mirrors a rail
// train record so the same position-delta speedmap machinery can consume it.
function parseStreetcarVehicles(data, polledAt = Date.now()) {
  const patterns = data?.route?.patterns || [];
  const out = [];
  for (const pattern of patterns) {
    const direction = pattern?.directionId != null ? String(pattern.directionId) : null;
    for (const vp of pattern?.vehiclePositions || []) {
      if (vp?.vehicleId == null) continue;
      out.push({
        vehicleId: String(vp.vehicleId),
        label: vp.label != null ? String(vp.label) : null,
        line: STREETCAR_LINE,
        direction,
        tripId: vp.trip?.gtfsId ?? null,
        lat: toNum(vp.lat),
        lon: toNum(vp.lon),
        // null in practice (OTP doesn't get them from the streetcar feed), but
        // carried through in case the feed starts populating them.
        speed: toNum(vp.speed),
        heading: toNum(vp.heading),
        eventTs: parseLastUpdate(vp.lastUpdate),
        polledAt,
      });
    }
  }
  return out;
}

// Record to the MARTA history DB by default; { record: false } for diagnostic
// fetches. storage is required lazily so the pure-parser path stays DB-free.
async function fetchStreetcarVehicles({ record = true } = {}) {
  const polledAt = Date.now();
  const { data } = await withRetry(
    () =>
      axios.post(
        OTP_URL,
        { query: VEHICLES_QUERY },
        { headers: { 'content-type': 'application/json' }, timeout: 20000 },
      ),
    { label: 'MARTA streetcar OTP vehicles' },
  );
  if (data?.errors?.length) {
    throw new Error(`OTP streetcar query error: ${JSON.stringify(data.errors).slice(0, 300)}`);
  }
  const vehicles = parseStreetcarVehicles(data?.data, polledAt);
  if (record) require('../storage').recordStreetcarObservations(vehicles, polledAt);
  return { polledAt, vehicles };
}

module.exports = {
  OTP_URL,
  STREETCAR_ROUTE_ID,
  STREETCAR_LINE,
  VEHICLES_QUERY,
  fetchStreetcarVehicles,
  parseStreetcarVehicles,
  parseLastUpdate,
};
