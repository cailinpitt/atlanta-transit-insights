// Metra line metadata. Values are sourced from the GTFS static feed's
// `routes.txt` (route_long_name / route_color / route_text_color) — the
// authoritative source Metra publishes. Kept in code (like CTA's train
// LINE_COLORS in src/train/api.js) because line identity changes rarely;
// scripts/fetch-metra-gtfs.js regenerates the geometry (metraLines.json /
// metraStations.json) from the same feed and can be used to re-verify these.
//
// route_id is Metra's own line key (e.g. `UP-N`, `MD-W`, `BNSF`) and is what the
// GTFS-realtime feeds report. It's already URL-safe once lowercased, so the web
// key is just `route_id.toLowerCase()`.

// All 11 Metra lines, in routes.txt order (alphabetical by route_id).
const ALL_LINES = ['BNSF', 'HC', 'MD-N', 'MD-W', 'ME', 'NCS', 'RI', 'SWS', 'UP-N', 'UP-NW', 'UP-W'];

// Rider-facing line names (GTFS route_long_name).
const LINE_NAMES = {
  BNSF: 'BNSF',
  HC: 'Heritage Corridor',
  'MD-N': 'Milwaukee District North',
  'MD-W': 'Milwaukee District West',
  ME: 'Metra Electric',
  NCS: 'North Central Service',
  RI: 'Rock Island',
  SWS: 'SouthWest Service',
  'UP-N': 'Union Pacific North',
  'UP-NW': 'Union Pacific Northwest',
  'UP-W': 'Union Pacific West',
};

// Official Metra brand colors (GTFS route_color), hex WITHOUT the leading `#`
// to match the convention in src/train/api.js (Mapbox overlays + post text).
const LINE_COLORS = {
  BNSF: '29C233',
  HC: '550E0C',
  'MD-N': 'CC5500',
  'MD-W': 'F1AD0E',
  ME: 'EB5C00',
  NCS: '9785BC',
  RI: 'E02400',
  SWS: '0042A8',
  'UP-N': '008000',
  'UP-NW': 'FFE600',
  'UP-W': 'FE8D81',
};

// Contrast color for text/markers drawn on the brand color (GTFS
// route_text_color). MD-W, UP-NW, UP-W, and BNSF use black; the rest white.
const LINE_TEXT_COLORS = {
  BNSF: '000000',
  HC: 'FFFFFF',
  'MD-N': 'FFFFFF',
  'MD-W': '000000',
  ME: 'FFFFFF',
  NCS: 'FFFFFF',
  RI: 'FFFFFF',
  SWS: 'FFFFFF',
  'UP-N': 'FFFFFF',
  'UP-NW': '000000',
  'UP-W': '000000',
};

// Metra has no per-line emoji the way CTA's L lines map to colored squares, so
// posts use a single commuter-rail glyph. Exposed as a constant so callers
// don't re-spell it.
const MODE_EMOJI = '🚆';

// Friendly label for logs/posts (`UP-N` → `Union Pacific North`). Falls back to
// the raw route_id so a code we don't recognize never silently disappears.
const lineLabel = (line) => LINE_NAMES[line] || line;

// Stable, URL-safe web key for the public dashboard (`UP-N` → `up-n`). The
// frontend's metraLines.js keys off this. Identity-safe to call repeatedly.
const webKey = (line) => (line == null ? line : String(line).toLowerCase());

module.exports = {
  ALL_LINES,
  LINE_NAMES,
  LINE_COLORS,
  LINE_TEXT_COLORS,
  MODE_EMOJI,
  lineLabel,
  webKey,
};
