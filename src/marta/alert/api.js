// MARTA official service alerts — GTFS-realtime ServiceAlerts.
//
// Discovery result (plan Phase 6): MARTA publishes official alerts as a standard
// GTFS-rt v2.0 ServiceAlerts protobuf at the same host as the bus feeds —
// NO scraper, NO API key. This collapses the feared "defensive scraper spike"
// into a normal protobuf parse (this mirrors src/metra/api.js's parseAlert).
//
//   https://gtfs-rt.itsmarta.com/TMGTFSRealTimeWebService/alert/alerts.pb
//
// Each entity is a GTFS-rt Alert: informedEntity[] (which routes/stops/trips it
// affects), cause, effect, header/description/url TranslatedStrings, and
// activePeriod[]. The feed is FULL_DATASET — every poll is the complete current
// alert set, so "gone from the feed" = "cleared."
//
// OPEN QUESTION (needs a live alert to confirm — feed was empty at first
// capture): whether `informedEntity.routeId` carries the PUBLIC route number
// (like the bus realtime feed) or the internal GTFS route_id, and what form the
// rail line ids take. `routeId` is surfaced raw here; resolution against static
// GTFS is deferred until a real alert is captured. Run scripts/marta/capture-
// alerts.js across days to catch one.
const axios = require('axios');
const GtfsRt = require('gtfs-realtime-bindings');
const { withRetry } = require('../../shared/retry');

const ALERTS_URL = 'https://gtfs-rt.itsmarta.com/TMGTFSRealTimeWebService/alert/alerts.pb';

const { transit_realtime } = GtfsRt;
const FeedMessage = transit_realtime.FeedMessage;

function longToNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v.toNumber === 'function') return v.toNumber();
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// activePeriod bounds: an absent start/end decodes as the protobuf default 0
// (epoch 1970), which here means "open-ended" (active since forever / no end).
// Coerce 0 → null so callers don't mistake it for a real boundary.
function tsOrNull(v) {
  const n = longToNum(v);
  return n ? n : null;
}

function reverseEnum(enumObj) {
  const out = {};
  for (const [name, val] of Object.entries(enumObj)) out[val] = name;
  return out;
}
const ALERT_CAUSE = reverseEnum(transit_realtime.Alert.Cause);
const ALERT_EFFECT = reverseEnum(transit_realtime.Alert.Effect);
const relName = (map, v) => (v == null ? null : (map[v] ?? String(v)));

// First English translation (fall back to the first translation of any
// language) from a GTFS-rt TranslatedString.
function translatedText(ts) {
  const list = ts?.translation;
  if (!Array.isArray(list) || list.length === 0) return null;
  const en = list.find((t) => !t.language || /^en/i.test(t.language));
  return (en ?? list[0]).text ?? null;
}

function decodeFeed(buffer) {
  return FeedMessage.decode(new Uint8Array(buffer));
}

function parseAlert(entity) {
  const a = entity.alert;
  if (!a) return null;
  return {
    // GTFS-rt provides a stable per-alert id; keep it as the incident key.
    id: entity.id ?? null,
    cause: relName(ALERT_CAUSE, a.cause),
    effect: relName(ALERT_EFFECT, a.effect),
    header: translatedText(a.headerText),
    description: translatedText(a.descriptionText),
    url: translatedText(a.url),
    informedEntities: (a.informedEntity || []).map((e) => ({
      agencyId: e.agencyId ?? null,
      routeId: e.routeId ?? null, // raw — see OPEN QUESTION above
      routeType: Number.isInteger(e.routeType) ? e.routeType : null,
      stopId: e.stopId ?? null,
      tripId: e.trip?.tripId ?? null,
      directionId: e.directionId ?? null,
    })),
    activePeriods: (a.activePeriod || []).map((p) => ({
      start: tsOrNull(p.start),
      end: tsOrNull(p.end),
    })),
  };
}

async function fetchAlerts() {
  const { data } = await withRetry(
    () => axios.get(ALERTS_URL, { responseType: 'arraybuffer', timeout: 15000 }),
    { label: 'MARTA service alerts' },
  );
  const feed = decodeFeed(Buffer.from(data));
  return {
    feedTimestamp: longToNum(feed.header?.timestamp),
    alerts: (feed.entity || []).map(parseAlert).filter(Boolean),
  };
}

module.exports = {
  ALERTS_URL,
  fetchAlerts,
  // Exposed for fixture-based tests (decode from a buffer, no network).
  decodeFeed,
  parseAlert,
};
