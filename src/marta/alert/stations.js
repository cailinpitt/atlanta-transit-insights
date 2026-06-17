// Station extraction for MARTA official rail alerts. MARTA's rail-alert prose
// names the affected stations in free text ("Green line is only servicing from
// Bankhead to Ashby ... board on the EB platform at Ashby"), but the GTFS-rt /
// OTP payload carries no structured stop list for rail. This module pulls the
// canonical station names back out of the headline + description so the web
// export can tie an alert to the right /station/:slug pages — the same role
// the CTA system's shared/ctaAlerts station extractor plays for Chicago.
//
// MARTA adaptation vs CTA: the roster names carry a " Station" suffix
// ("BANKHEAD Station") that the prose drops ("Bankhead"), and the prose is
// mixed-case while the roster is SCREAMING. normalizeStationKey() folds both
// away (lowercase + strip a trailing "station" word) so "Bankhead" resolves to
// "BANKHEAD Station". Resolution is scoped to the alert's line(s) so a
// same-named station on another line can't bleed in.
const RAIL_STATIONS = require('../rail-stations.json');

// "between X and Y" / "from X to Y" segment endpoints. The capture stops at
// punctuation or a follow-on clause keyword so "from Bankhead to Ashby, on the
// EB platform" yields "Bankhead" / "Ashby", not "Ashby, on the EB platform".
// No MARTA rail station name contains a space-delimited "in"/"on"/"and", so
// these terminators can't truncate a real name mid-string.
const BETWEEN_PATTERNS = [
  /\bbetween\s+([A-Za-z0-9][A-Za-z0-9./&\- ]+?)\s+and\s+([A-Za-z0-9][A-Za-z0-9./&\- ]+?)(?:[.,;]| stations?\b| in\b| on\b| due\b| while\b| for\b)/i,
  /\bfrom\s+([A-Za-z0-9][A-Za-z0-9./&\- ]+?)\s+to\s+([A-Za-z0-9][A-Za-z0-9./&\- ]+?)(?:[.,;]| stations?\b| in\b| on\b| due\b| while\b| for\b)/i,
];

// Verbs that mark where service is degraded. The endpoint nearest one of these
// anchors wins when a description carries several "between" clauses.
const DISRUPTION_ANCHORS =
  /\b(suspend|shuttl|halt|closed|single.track|no service|not running|only servicing)/i;

// Match a station candidate appearing in an *impact* context — "at X" /
// "near X". Capture runs until punctuation or a follow-on clause word. Junk
// captures ("at 5 PM", "at the EB platform") are harmless: resolveStationOnLine
// drops anything that isn't a real station on the alert's line(s).
const IMPACT_CONTEXT_RE =
  /\b(?:at|near)\s+([A-Za-z0-9][A-Za-z0-9./&\-()' ]+?)(?=\s*[.,;!]|\s+(?:due|because|while|after|following|crews|station|stations|stop|stops|toward|with|for|on|platform)\b|$)/gi;

function extractBetweenStations(text) {
  if (!text) return null;
  const matches = [];
  for (const re of BETWEEN_PATTERNS) {
    const reGlobal = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m = reGlobal.exec(text);
    while (m !== null) {
      matches.push({ from: m[1].trim(), to: m[2].trim(), index: m.index });
      m = reGlobal.exec(text);
    }
  }
  if (matches.length === 0) return null;
  const anchor = DISRUPTION_ANCHORS.exec(text);
  if (anchor) {
    matches.sort((a, b) => Math.abs(a.index - anchor.index) - Math.abs(b.index - anchor.index));
  }
  return { from: matches[0].from, to: matches[0].to };
}

// Fold a free-text station mention to a comparable key: lowercase, collapse
// whitespace around slashes, unify hyphen/space as a separator, and drop a
// trailing "station" word so prose ("Bankhead") matches the roster's suffixed
// name ("BANKHEAD Station").
function normalizeStationKey(s) {
  return String(s)
    .toLowerCase()
    .replace(/\s*\/\s*/g, '/')
    .replace(/[\s-]+/g, ' ')
    .replace(/\s*\bstation\b\s*$/, '')
    .trim();
}

// Resolve a free-text station mention to its canonical roster name, scoped to
// the alert's line(s). Returns the canonical name or null.
function resolveStationOnLines(candidate, lines, stations = RAIL_STATIONS) {
  if (!candidate || !lines || lines.length === 0) return null;
  const target = normalizeStationKey(candidate);
  if (!target) return null;
  const wanted = new Set(lines);
  for (const s of stations) {
    if (!(s.lines || []).some((l) => wanted.has(l))) continue;
    if (normalizeStationKey(s.name) === target) return s.name;
  }
  return null;
}

// Pull the canonical names of the stations a rail alert's text says are
// impacted. Combines impact-context matches ("at X", "near X") with the
// segment endpoints ("between X and Y", "from X to Y"). `lines` is the alert's
// affected rail line keys, used to disambiguate same-named stations across
// lines. Returns a deduplicated array; empty when nothing resolves.
//
// @param {string} text
// @param {string[]} lines
// @returns {string[]}
function extractMentionedStations(text, lines, stations = RAIL_STATIONS) {
  if (!text || !lines || lines.length === 0) return [];
  const seen = new Set();
  const out = [];
  const add = (canonical) => {
    if (!canonical || seen.has(canonical)) return;
    seen.add(canonical);
    out.push(canonical);
  };

  IMPACT_CONTEXT_RE.lastIndex = 0;
  let m = IMPACT_CONTEXT_RE.exec(text);
  while (m !== null) {
    add(resolveStationOnLines(m[1], lines, stations));
    m = IMPACT_CONTEXT_RE.exec(text);
  }

  const between = extractBetweenStations(text);
  if (between) {
    add(resolveStationOnLines(between.from, lines, stations));
    add(resolveStationOnLines(between.to, lines, stations));
  }
  return out;
}

// Top-level entry point used at alert ingest. Given a rail alert's headline,
// description, and affected line keys, returns the structured station fields
// the store persists and the web export emits in `scope`:
//   - affectedFromStation / affectedToStation: the "between X and Y" segment
//     endpoints (canonical names), or null.
//   - mentionedStations: every station the prose names, including those
//     endpoints (canonical, deduped).
// Returns all-null/empty when no station resolves.
//
// @param {{ headline?: string|null, description?: string|null, lines: string[] }} input
function extractAlertStations({ headline, description, lines }) {
  const railLines = (lines || []).filter(Boolean);
  if (railLines.length === 0) {
    return { affectedFromStation: null, affectedToStation: null, mentionedStations: [] };
  }
  const text = [headline, description].filter(Boolean).join(' ');
  const between = extractBetweenStations(text);
  const affectedFromStation = between ? resolveStationOnLines(between.from, railLines) : null;
  const affectedToStation = between ? resolveStationOnLines(between.to, railLines) : null;
  const mentionedStations = extractMentionedStations(text, railLines);
  return { affectedFromStation, affectedToStation, mentionedStations };
}

module.exports = {
  extractAlertStations,
  extractMentionedStations,
  extractBetweenStations,
  resolveStationOnLines,
  normalizeStationKey,
  RAIL_STATIONS,
};
