// Significance gate + mode classification + post text for MARTA's official
// GTFS-rt ServiceAlerts. The MARTA analog of src/metra/metraAlerts.js (also a
// native GTFS-rt feed parsed by src/marta/alert/api.js) — pure functions; the
// bin wires them to the feed, the store, and Bluesky.
//
// Like the Metra/CTA gates this errs toward silence: a missed alert is
// recoverable, but spamming followers with elevator/ADA/construction notices
// trains them to ignore the feed. The gate is keyword-driven over header +
// description, with the structured `effect` only used as a strong ADMIT signal
// when MARTA sets a meaningful one.
//
// CAVEAT (routeId form unconfirmed): MARTA's feed was empty at discovery, so we
// haven't seen whether informedEntity.routeId is the public bus number / rail
// line name (as the synthetic fixture and the realtime bus feed suggest) or an
// internal GTFS route_id. Relevance is therefore deliberately NOT gated on a
// route roster — MARTA is a single agency, so any alert scoped to it is
// relevant. routeId/routeType are surfaced for display + mode tagging only.
const { graphemeLength } = require('../../shared/post');
const { LINES: RAIL_LINES } = require('../rail/api');

const EMOJI_WARN = '⚠️';
// GTFS route_type: 0 tram/streetcar, 1 subway/metro (MARTA heavy rail), 3 bus.
const MODE_EMOJI = { bus: '🚌', rail: '🚆', streetcar: '🚋', general: EMOJI_WARN };
const RAIL_LINE_SET = new Set(RAIL_LINES.map((l) => l.toUpperCase()));

// Real service problems worth a post.
const MAJOR_PATTERNS = [
  /\bsuspend(ed|ing|s)?\b/i,
  /\bno\s+(train|bus|service|rail)\b/i,
  /\bnot\s+running\b/i,
  /\bwill\s+not\s+(operate|run|stop|serve)\b/i,
  /\bsingle[-\s]?track(ing|ed)?\b/i,
  /\bshuttle\b/i,
  /\bbus(es)?\b.*\b(substitut|bridge|replac|shuttl)/i,
  /\bdetour(ed|ing|s)?\b/i,
  /\b(reroute|re-route|bypass)/i,
  /\bdelay/i,
  /\bdisrupt/i,
  /\bsignal\s+(problem|issue|malfunction|trouble)/i,
  /\bmechanical\b/i,
  /\bdisabled\s+(train|bus|vehicle)\b/i,
  /\bpolice\s+activity\b/i,
  /\b(medical|fire)\s+emergency\b/i,
  /\btrespasser\b/i,
  /\bstruck\b/i,
  /\bservice\s+(disrupt|halt|impact|interrupt|change)/i,
  /\bskip(ping|ped|s)?\s+(stations?|stops?)/i,
  /\bclosed?\b/i,
];

// Alert-shaped notices that aren't a service problem riders need pushed. A
// MAJOR hit overrides a MINOR hit (e.g. "station closed, shuttle bus running"
// still posts), so these only veto when nothing major is present.
const MINOR_PATTERNS = [
  /\bada\b/i,
  /\baccessib/i,
  /\belevator\b/i,
  /\bescalator\b/i,
  /\bparking\b/i,
  /\bbi(cycle|ke)s?\b/i,
  /\b(grand\s+)?opening|opening\s+ceremony\b/i,
  /\bcelebrat|festival|fair\b/i,
  /\bsurvey\b/i,
  /\bnew\s+schedule|schedule\s+(change|update|now|pdf)|timetable\b/i,
  /\bfare\s+(increase|change|capping)/i,
  /\bticket(ing)?\s+(app|machine|office|window|vending)/i,
  /\bbreeze\s+card\b/i,
  /\bhiring|job\s+fair|career\b/i,
  /\bstation\s+(improv|renovat|upgrade)/i,
  /\bplatform\s+(work|improv)/i,
  /\bconstruction\b/i,
];

// Structured effects that always admit when MARTA bothers to set one (the feed
// may default to UNKNOWN_EFFECT like Metra's). Benign/unknown effects fall
// through to the keyword gate.
const STRONG_EFFECTS = new Set([
  'NO_SERVICE',
  'REDUCED_SERVICE',
  'SIGNIFICANT_DELAYS',
  'DETOUR',
  'MODIFIED_SERVICE',
]);

function alertText(alert) {
  return [alert.header, alert.description].filter(Boolean).join(' \n ');
}

// Classify a single informedEntity to a mode from its GTFS route_type, falling
// back to a rail-line-name match on routeId, else null (unknown scope).
//
// route_type 0 (tram/streetcar) is deliberately NOT trusted: protobuf decodes
// an *absent* int field as 0, so 0 is ambiguous between "Atlanta Streetcar" and
// "route_type omitted". We classify streetcar only by an explicit routeId match
// (none known yet — a follow-up once a live alert confirms the routeId form), so
// an ambiguous 0 falls through to the routeId/rail check, then null. Real bus
// alerts carry route_type 3; real heavy-rail carries 1 (or 2).
function entityMode(e) {
  if (e.routeType === 1 || e.routeType === 2) return 'rail';
  if (e.routeType === 3) return 'bus';
  if (e.routeId && RAIL_LINE_SET.has(String(e.routeId).toUpperCase())) return 'rail';
  return null;
}

// Affected routes/lines + the alert's dominant mode + whether it's an agency-wide
// notice. `routes` is the de-duped informed routeId list (empty for agency-wide).
// `mode` is rail > streetcar > bus > general when an alert spans modes (rail
// disruptions are the headline event); 'general' when nothing scopes it.
function alertRelevance(alert) {
  const routes = [];
  const modes = new Set();
  let sawAgency = false;
  let sawAny = false;
  for (const e of alert.informedEntities || []) {
    if (e.routeId != null && !routes.includes(e.routeId)) routes.push(e.routeId);
    const m = entityMode(e);
    if (m) modes.add(m);
    if (e.routeId != null || e.stopId != null || e.tripId != null) sawAny = true;
    if (e.agencyId != null) sawAgency = true;
  }
  const mode = modes.has('rail')
    ? 'rail'
    : modes.has('streetcar')
      ? 'streetcar'
      : modes.has('bus')
        ? 'bus'
        : 'general';
  const agencyWide = !sawAny && sawAgency;
  // Single-agency feed: any scoped entity, or an agency-wide notice, is relevant.
  return { routes, mode, agencyWide, relevant: sawAny || agencyWide };
}

// True when the alert is a real service problem on MARTA (or system-wide). A
// strong structured effect always admits; otherwise keyword-driven with a
// minor-wins veto (a MAJOR hit overrides a MINOR hit).
function isSignificantAlert(alert) {
  if (!alertRelevance(alert).relevant) return false;
  if (alert.effect && STRONG_EFFECTS.has(alert.effect)) return true;
  const text = alertText(alert).toLowerCase();
  if (!text) return false;
  const hasMajor = MAJOR_PATTERNS.some((re) => re.test(text));
  const hasMinor = MINOR_PATTERNS.some((re) => re.test(text));
  if (hasMinor && !hasMajor) return false;
  return hasMajor;
}

// Trim to a sentence boundary at/under maxChars, falling back to a word-boundary
// hard cut with an ellipsis. Mirrors metraAlerts.js#truncateSentence.
function truncateSentence(s, maxChars) {
  if (!s || s.length <= maxChars) return s;
  const slice = s.slice(0, maxChars);
  const lastStop = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
  );
  if (lastStop > maxChars * 0.5) return slice.slice(0, lastStop + 1);
  const lastSpace = slice.lastIndexOf(' ');
  return `${slice.slice(0, lastSpace > 0 ? lastSpace : maxChars)}…`;
}

// Bluesky post text for a republished MARTA alert: mode emoji + header +
// truncated body + provenance. Falls back to a header-only form when the full
// text exceeds Bluesky's 300-grapheme limit.
function buildAlertText(alert, mode = 'general') {
  const head = alert.header || 'Service alert';
  const prefix = `${MODE_EMOJI[mode] || EMOJI_WARN}${EMOJI_WARN}`;
  const parts = [`${prefix} ${head}`];
  if (alert.description) {
    parts.push('');
    parts.push(truncateSentence(alert.description, 200));
  }
  parts.push('');
  parts.push('Per MARTA. Check itsmarta.com for updates.');
  const text = parts.join('\n');
  if (graphemeLength(text) <= 300) return text;
  return `${prefix} ${head}\n\nPer MARTA. itsmarta.com`;
}

// Threaded reply text when an alert drops out of the feed (MARTA-side cleared).
function buildResolutionText(header) {
  const head = header ? truncateSentence(header, 180) : 'Service alert';
  return `✅ MARTA reports this is resolved:\n\n${head}`;
}

// Clean link-card headline for the resolution reply (no leading emoji), pointing
// at the incident's archive page.
module.exports = {
  isSignificantAlert,
  alertRelevance,
  entityMode,
  buildAlertText,
  buildResolutionText,
};
