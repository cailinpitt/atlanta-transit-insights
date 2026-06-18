// Descriptive display name for an official MARTA service alert.
//
// MARTA's own `alertHeaderText` is generic — "Rail Service Alert for Green
// Line", "Rail Service Alert for Red/Gold lines" — so a rider scanning a list
// of events can't tell what each one is about without opening it. The real
// information lives in the description prose ("Green line is only servicing from
// Bankhead to Ashby…") and the structured `effect`.
//
// This pure helper synthesizes a short, scannable name from the fields we
// already have: the affected routes (the SUBJECT) + the nature of the
// disruption (a NATURE phrase derived from `effect` and keyword scan over the
// header + description). It deliberately does NOT include the affected station
// segment — that surfaces as a separate "Bankhead → Ashby" subtitle in the UI
// (from scope.from_station/to_station), the same treatment train bot events get.
//
// Used by both the Bluesky post text (significance.js) and the website export
// (export-web.js) so the two never diverge. The raw MARTA header is preserved
// verbatim in the alert's `description` block ("Per MARTA"); this only replaces
// the generic *title*. Re-derivable at render time — nothing is stored.
//
// "Present data, not commentary": the NATURE phrase is a neutral category drawn
// from the alert's own structured effect / wording, not a judgment.
const { canonicalRoute, isStreetcarRoute } = require('../routeKeys');

// Ordered keyword → nature phrase. Scanned over header + description; the FIRST
// match wins, so list more specific / more severe phrasings earlier. These beat
// the structured `effect` map below because the prose is usually more precise
// than MARTA's coarse effect enum (which is frequently UNKNOWN for rail).
const NATURE_PATTERNS = [
  [/\bsingle[-\s]?track(ing|ed)?\b/i, 'single-tracking'],
  [
    /\b(no\s+(train|bus|rail)?\s*service|service\s+suspend|suspend(ed|ing|s)?|not\s+running|will\s+not\s+(operate|run))\b/i,
    'service suspended',
  ],
  [
    /\b(only\s+servic\w*|only\s+runn\w*|partial\s+service|limited\s+service|servic\w*\s+only)/i,
    'partial service',
  ],
  [
    /\b(shuttle|bus\s+bridge|bus(es)?\s+(substitut|replac)|replacement\s+bus)\b/i,
    'shuttle service',
  ],
  [/\b(detour|reroute|re-route|bypass)\w*/i, 'detour'],
  [/\bstation\s+clos\w*|\bclosed?\b/i, 'station closure'],
  [/\bskip(ping|ped|s)?\s+(stations?|stops?)\b/i, 'skipping stations'],
  [/\b(significant\s+)?delay\w*/i, 'delays'],
  [/\b(service\s+change|modified\s+service|schedule\s+adjust)\w*/i, 'service change'],
  // Catch MARTA's frequent "service disruption" wording before the generic
  // "service alert" fallback so it reads a touch more specifically.
  [/\bdisrupt\w*/i, 'service disruption'],
];

// Structured GTFS-rt effect → nature phrase, used when no keyword matched.
const EFFECT_NATURE = {
  NO_SERVICE: 'service suspended',
  REDUCED_SERVICE: 'reduced service',
  SIGNIFICANT_DELAYS: 'delays',
  DETOUR: 'detour',
  MODIFIED_SERVICE: 'service change',
};

function titleCase(s) {
  const str = String(s || '').trim();
  return str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : str;
}

// Bus "station closure" reads wrong (buses don't serve rail stations); for the
// bus mode collapse the closure phrasing to the more neutral "service change".
function natureForMode(nature, mode) {
  if (mode === 'bus' && nature === 'station closure') return 'service change';
  return nature;
}

// The disruption phrase: keyword scan first (most precise), then the structured
// effect, then a generic fallback.
function alertNature({ header, description, effect, mode }) {
  const text = [header, description].filter(Boolean).join(' \n ');
  for (const [re, phrase] of NATURE_PATTERNS) {
    if (re.test(text)) return natureForMode(phrase, mode);
  }
  if (effect && EFFECT_NATURE[effect]) return natureForMode(EFFECT_NATURE[effect], mode);
  return 'service alert';
}

// The SUBJECT label: which line(s) / route(s) the alert is about.
//   rail      → "Green Line", "Red/Gold Line"
//   streetcar → "Streetcar"
//   bus       → "Route 110", "Routes 110, 49"
//   no routes → "MARTA" (agency-wide notice)
function alertSubject({ mode, routes }) {
  const list = (routes || []).map((r) => String(r).trim()).filter(Boolean);
  if (mode === 'streetcar') return 'Streetcar';
  if (list.length === 0) return 'MARTA';
  if (mode === 'rail') {
    const lines = list.filter((r) => !isStreetcarRoute(r)).map((r) => titleCase(canonicalRoute(r)));
    const uniq = [...new Set(lines)];
    if (uniq.length === 0) return 'MARTA';
    return `${uniq.join('/')} Line`;
  }
  // bus (and any other route-scoped mode): the public route numbers as-is.
  const uniq = [...new Set(list)];
  return uniq.length === 1 ? `Route ${uniq[0]}` : `Routes ${uniq.join(', ')}`;
}

// Build the scannable display name for an official MARTA alert.
//
// @param {object} alert
// @param {string|null} alert.header      Raw MARTA alertHeaderText.
// @param {string|null} alert.description Raw MARTA alertDescriptionText.
// @param {string}      alert.mode        'rail' | 'streetcar' | 'bus' | 'general'.
// @param {string[]}    alert.routes      Affected route/line keys (empty = agency-wide).
// @param {string|null} alert.effect      GTFS-rt effect enum, or null.
// @returns {string} e.g. "Green Line partial service", "Route 110 detour".
function buildAlertDisplayName({ header, description, mode, routes, effect } = {}) {
  const subject = alertSubject({ mode, routes });
  const nature = alertNature({ header, description, effect, mode });
  // Fallback: when we could pin down NEITHER a specific route subject ("MARTA")
  // NOR a recognizable disruption nature ("service alert"), the synthesized name
  // is vaguer than MARTA's own header — so prefer the raw header if it has any
  // text. A real route subject (e.g. "Green Line") is always kept, since "Green
  // Line service alert" already reads at least as well as MARTA's generic header.
  if (subject === 'MARTA' && nature === 'service alert' && header?.trim()) {
    return header.trim();
  }
  return `${subject} ${nature}`;
}

module.exports = {
  buildAlertDisplayName,
  alertSubject,
  alertNature,
};
