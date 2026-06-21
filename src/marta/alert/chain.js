// Chaining of MARTA's churned official-alert entities into ONE logical incident.
//
// MARTA's OTP backend (src/marta/alert/otp.js) publishes every update as a NEW
// alert entity with a fresh id ("alert-<num>"), so a single real disruption
// arrives as a sequence of distinct alert_posts:
//   "Streetcar delays" → "Update: resumed normal schedule"
//   "Gold Line delays" → "Update: delays continuing" → "Update: delay clearing"
// CTA never hits this (it edits one entity in place, appended as alert_versions),
// so there's no CTA analog to port — this is MARTA-native glue.
//
// These pure predicates decide when two consecutive same-mode/route alerts are
// the SAME incident. Reused by both the producer (bin/marta/alerts.js — to reply
// in one Bluesky thread) and the web export (bin/marta/export-web.js
// consolidateAlertChains — to merge the website incidents), so the two never
// disagree.
const { routeMatchKey } = require('../routeKeys');

// Two consecutive same-line alerts are one incident when the later one starts
// within this window of the earlier one's end (an open/unresolved earlier alert
// is treated as open-ended — anything later on the same line overlaps it). 45
// min comfortably catches MARTA's update chains (the observed gaps are 2-4 min)
// without merging a genuinely separate disruption hours later.
const CHAIN_WINDOW_MS = 45 * 60 * 1000;

// True when two canonical route lists name an overlapping line/route. Empty
// lists are agency-wide notices: two empty lists overlap (same agency-wide
// mode), but an agency-wide notice does NOT absorb a route-scoped one, or every
// "service resumed" would swallow unrelated single-line alerts.
function routesOverlap(a, b) {
  const A = (a || []).map(routeMatchKey).filter(Boolean);
  const B = (b || []).map(routeMatchKey).filter(Boolean);
  if (A.length === 0 && B.length === 0) return true;
  if (A.length === 0 || B.length === 0) return false;
  return A.some((x) => B.includes(x));
}

// The effective "still going as of" time of an alert: when it resolved, else
// when we last saw it in the feed, else its onset. Using last_seen (not +∞) for
// an unresolved alert means a genuinely-active alert (last_seen refreshed every
// tick) chains with a near-term follow-up, but a stuck/stale "active" row whose
// feed sightings stopped long ago will NOT absorb unrelated later alerts.
function alertEndTs(a) {
  if (a.resolved_ts != null) return a.resolved_ts;
  if (a.last_seen_ts != null) return a.last_seen_ts;
  return a.first_seen_ts;
}

// True when `next` is a continuation of `prev` (same mode, overlapping routes,
// onset within CHAIN_WINDOW_MS of prev's effective end). Each arg is a plain
// object with `{ mode, routes, first_seen_ts, resolved_ts, last_seen_ts }`. The
// caller sorts a candidate set by first_seen ascending and links consecutive
// pairs, so chaining is transitive (A→B→C groups even when A and C are far apart).
function alertsChainable(prev, next, windowMs = CHAIN_WINDOW_MS) {
  if (!prev || !next) return false;
  if (prev.mode !== next.mode) return false;
  if (!routesOverlap(prev.routes, next.routes)) return false;
  return next.first_seen_ts - alertEndTs(prev) <= windowMs;
}

// Wording that says a disruption is over / clearing. Used to recognize MARTA's
// "all clear" follow-up entities so they close the thread silently instead of
// triggering a second "✅ resolved" reply, and so the producer's resolution
// sweep doesn't post "✅ resolved: Marta Streetcars resumed normal schedule".
const ALL_CLEAR_RE =
  /\b(resum\w+|cleared|clearing|back\s+to\s+normal|normal\s+(service|schedule|operation)|operating\s+normally|all\s+clear|no\s+longer|(has\s+been|is)\s+resolved)\b/i;

function isAllClearText(...texts) {
  const t = texts.filter(Boolean).join(' ');
  return t ? ALL_CLEAR_RE.test(t) : false;
}

module.exports = {
  CHAIN_WINDOW_MS,
  routesOverlap,
  alertEndTs,
  alertsChainable,
  isAllClearText,
};
