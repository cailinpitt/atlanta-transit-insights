// MARTA official alerts — OTP GraphQL source (the PRIMARY alert feed).
//
// Discovery 2026-06-17: the documented GTFS-rt ServiceAlerts protobuf
// (src/marta/alert/api.js, gtfs-rt.itsmarta.com/.../alert/alerts.pb) is
// effectively dead — empty at every capture. The alerts riders actually see on
// itsmarta.com/ride/alerts come from the same undocumented OpenTripPlanner
// (OTP1) GraphQL backend that carries the streetcar (src/marta/streetcar/api.js):
//
//   https://tracker.itsmarta.com/otp/routers/default/index/graphql  → { alerts }
//
// Two kinds of OTP alert, distinguished by the decoded `id`:
//   - "cancellation-alert-<routeInternalId>" — MARTA's per-route, whole-day,
//     forward-looking trip-cancellation notices (prose with specific times).
//     These are NOT republished here: they're a different measurement from the
//     live realtime annulment and would diverge from the bus-cancellation
//     ROLLUP, which counts the structured GTFS-rt TripUpdates CANCELED flags the
//     ghost detector already uses (one cancellation dataset, not two). So this
//     adapter DROPS them — see bin/marta/bus/cancellations.js for that pipeline.
//   - everything else ("alert-<num>") — every other service alert, ANY mode.
//     Rail/general disruptions (e.g. a Green Line single-segment closure) AND
//     bus alerts that aren't trip cancellations: detours, reroutes, route
//     suspensions, service changes. The .pb feed misses these entirely, so OTP
//     is the only source. They flow through the normal significance → republish
//     → resolve lifecycle in bin/marta/alerts.js, mode-tagged from route_type.
//     The drop is keyed strictly on the "cancellation-alert" id — NOT on mode —
//     so the only bus thing we set aside is the cancellation notice itself.
//
// Caveats: rider-app backend, no auth, can change without notice — parse
// defensively, poll politely. cause/severity are usually UNKNOWN; effect is
// often populated (REDUCED_SERVICE etc). OTP gives BOTH route forms —
// shortName (public "49"/"Green") and gtfsId (internal "MARTA:26926") — which is
// what finally resolved the long-open routeId-form question.
const axios = require('axios');
const { withRetry } = require('../../shared/retry');

// Same rider-app OTP endpoint the streetcar observer uses. Re-declared (rather
// than imported from streetcar/api) so the alert path carries no streetcar dep.
const OTP_URL = 'https://tracker.itsmarta.com/otp/routers/default/index/graphql';

const ALERTS_QUERY = `{
  alerts {
    id
    alertHeaderText
    alertDescriptionText
    alertEffect
    alertCause
    alertUrl
    effectiveStartDate
    effectiveEndDate
    route { gtfsId shortName mode }
    entities {
      __typename
      ... on Route { gtfsId shortName mode }
      ... on Stop { gtfsId name }
    }
  }
}`;

// OTP route.mode → GTFS route_type, so the shared significance gate (which keys
// mode off route_type / rail-line-name) classifies an OTP alert the same way it
// classifies a .pb one. SUBWAY = MARTA heavy rail (1); TRAM = streetcar (0);
// BUS = 3. Unknown modes → null (gate falls back to the rail-line-name check).
function modeToRouteType(mode) {
  switch (mode) {
    case 'SUBWAY':
    case 'RAIL':
      return 1;
    case 'TRAM':
      return 0;
    case 'BUS':
      return 3;
    default:
      return null;
  }
}

// OTP enum strings come through as "UNKNOWN_CAUSE" / "UNKNOWN_EFFECT" when MARTA
// sets nothing meaningful; collapse those to null so they read like the .pb
// adapter's absent values (and don't masquerade as a real cause/effect).
function enumOrNull(v) {
  if (!v || v === 'UNKNOWN_CAUSE' || v === 'UNKNOWN_EFFECT') return null;
  return v;
}

// effectiveStartDate/EndDate are epoch SECONDS (OTP). 0/absent → null bound.
function secOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// True when this OTP alert is one of the per-route cancellation notices handled
// by the TripUpdates-sourced rollup, not the individual republisher. The id is
// base64 of e.g. "Alert:MARTA:cancellation-alert-26926".
function isCancellationAlert(rawId) {
  if (!rawId) return false;
  let decoded;
  try {
    decoded = Buffer.from(rawId, 'base64').toString('utf8');
  } catch (_e) {
    return false;
  }
  return decoded.includes('cancellation-alert');
}

// Normalize one OTP alert node into the SAME shape src/marta/alert/api.js#parseAlert
// emits, so the significance gate / store / bin consume one format. Returns null
// for cancellation alerts (excluded — see file header) and headerless nodes.
function parseOtpAlert(node) {
  if (!node || isCancellationAlert(node.id)) return null;
  const informedEntities = [];
  for (const e of node.entities || []) {
    if (e.__typename === 'Route') {
      informedEntities.push({
        agencyId: null,
        // shortName is the public route number / rail line name we display and
        // that the rail-line-name mode check expects (e.g. "Green").
        routeId: e.shortName ?? e.gtfsId ?? null,
        routeType: modeToRouteType(e.mode),
        stopId: null,
        tripId: null,
        directionId: null,
      });
    } else if (e.__typename === 'Stop') {
      informedEntities.push({
        agencyId: null,
        routeId: null,
        routeType: null,
        stopId: e.gtfsId ?? null,
        tripId: null,
        directionId: null,
      });
    }
  }
  // Some alerts carry the affected route only on the top-level `route`, not in
  // `entities` — fold it in so relevance/mode classification still sees it.
  if (node.route && !informedEntities.some((e) => e.routeId === node.route.shortName)) {
    informedEntities.push({
      agencyId: null,
      routeId: node.route.shortName ?? node.route.gtfsId ?? null,
      routeType: modeToRouteType(node.route.mode),
      stopId: null,
      tripId: null,
      directionId: null,
    });
  }

  const start = secOrNull(node.effectiveStartDate);
  const end = secOrNull(node.effectiveEndDate);
  return {
    id: node.id ?? null,
    source: 'otp',
    cause: enumOrNull(node.alertCause),
    effect: enumOrNull(node.alertEffect),
    header: node.alertHeaderText ?? null,
    description: node.alertDescriptionText ?? null,
    url: node.alertUrl ?? null,
    informedEntities,
    activePeriods: start || end ? [{ start, end }] : [],
  };
}

// Pure: OTP `{ data: { alerts: [...] } }` → normalized non-cancellation alerts.
function parseOtpAlerts(data) {
  return (data?.alerts || []).map(parseOtpAlert).filter(Boolean);
}

async function fetchOtpAlerts() {
  const { data } = await withRetry(
    () =>
      axios.post(
        OTP_URL,
        { query: ALERTS_QUERY },
        { headers: { 'content-type': 'application/json' }, timeout: 20000 },
      ),
    { label: 'MARTA OTP service alerts' },
  );
  if (data?.errors?.length) {
    throw new Error(`OTP alerts query error: ${JSON.stringify(data.errors).slice(0, 300)}`);
  }
  return { alerts: parseOtpAlerts(data?.data) };
}

module.exports = {
  OTP_URL,
  ALERTS_QUERY,
  fetchOtpAlerts,
  // Exposed for fixture-based tests (no network).
  parseOtpAlerts,
  parseOtpAlert,
  isCancellationAlert,
  modeToRouteType,
};
