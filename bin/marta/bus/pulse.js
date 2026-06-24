#!/usr/bin/env node
// MARTA bus pulse — route-blackout detector. Port of cta-insights bin/bus/pulse.js
// (blackout path only; CTA's held-cluster sub-detector is deferred).
//
// Complements thin-gaps: thin-gaps owns low-frequency routes (headway ≥ 20 min);
// pulse owns the higher-frequency network, firing when a route that should have
// ≥2 buses on the road shows ZERO distinct vehicles in a headway-scaled lookback
// while the rest of the fleet reports normally.
//
// Posting (parity with cta-insights bin/bus/pulse.js): one post PER blacked-out
// route to the alerts account (a route blackout is a disruption alert, not an
// insight), each carrying a dimmed-route blackout map; threads under an open
// official MARTA alert for the route when one exists; records a standalone
// `observed` disruption (web export surfaces it); feeds the roundup a
// `pulse-cold` meta-signal; and threads a clear reply — with a resolved-event
// link card — when buses reappear.
require('../../../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));

const { loadGtfs } = require('../../../src/marta/gtfs');
const { loadShapes } = require('../../../src/marta/bus/shapes');
const { detectBusBlackouts } = require('../../../src/marta/bus/pulse');
const {
  loadScheduleIndex,
  headwayForLine,
  activeForLine,
} = require('../../../src/marta/bus/schedule');
const storage = require('../../../src/marta/storage');
const incidents = require('../../../src/marta/shared/incidents');
const { acquireCooldown } = require('../../../src/marta/shared/state');
const {
  loginAlerts,
  postText,
  postWithImage,
  postWithExternal,
  resolveReplyRef,
} = require('../../../src/marta/shared/bluesky');
const { resolvedEventLink, rkeyFromAtUri } = require('../../../src/marta/shared/eventLink');
const { eventAssociatedRefs } = require('../../../src/marta/shared/standardSite');
const { findUnresolvedAlertForRoundup } = require('../../../src/marta/alert/store');
const { renderBusDisruptionMap } = require('../../../src/marta/map/busDisruption');
const { setup, runBin } = require('../../../src/marta/shared/runBin');

const GTFS_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'marta', 'gtfs');

const LOOKBACK_CEIL_MS = 60 * 60 * 1000;
const COLD_START_GRACE_MS = 6 * 60 * 60 * 1000;
// Don't re-post an ongoing blackout each tick; the clear pass resolves it when
// buses return.
const PULSE_COOLDOWN_MS = 2 * 60 * 60 * 1000;
// Headway boundary with thin-gaps: routes at/above this are thin-gaps' job.
const THIN_GAP_MIN_HEADWAY_MIN = 20;
const CLEAR_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SYNTHETIC_CLEAR_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

function routeMeta(gtfs) {
  const names = new Map();
  const shapesByRoute = new Map();
  const routes = new Set();
  for (const trip of gtfs.tripsById.values()) {
    const r = gtfs.routesById.get(trip.route_id);
    if (!r || String(r.route_type) !== '3') continue;
    const short = String(r.route_short_name || '').trim();
    if (!short) continue;
    routes.add(short);
    if (r.route_long_name) names.set(short, r.route_long_name);
    if (trip.shape_id) {
      if (!shapesByRoute.has(short)) shapesByRoute.set(short, new Set());
      shapesByRoute.get(short).add(trip.shape_id);
    }
  }
  return { routes: [...routes], names, shapesByRoute };
}

function routeTitle(names, route) {
  const long = names.get(route);
  return long ? `Route ${route} (${long})` : `Route ${route}`;
}

// One post per blacked-out route (CTA parity), mirroring buildBusPostText.
function buildPostText(names, c, { headwayMin = null, alertOpen = false } = {}) {
  const header = `🚌⚠️ ${routeTitle(names, c.route)}: service appears suspended`;
  const headwayClause =
    headwayMin != null ? ` — currently scheduled every ${Math.round(headwayMin)} min` : '';
  const evidence = `📡 No buses observed on the route in the last ~${c.lookbackMin} min${headwayClause}.`;
  const footer = alertOpen
    ? 'Inferred from live bus positions. (See MARTA alert in this thread.)'
    : 'Inferred from live bus positions; no relevant MARTA alert at this time.';
  return `${header}\n\n${evidence}\n\n${footer}`;
}

function buildClearText(names, route, { alertOpen = false } = {}) {
  if (alertOpen) {
    return `🚌 ${routeTitle(names, route)}: bot's earlier pulse observation cleared — buses moving on the route again. MARTA's alert at the top of this thread is still active.`;
  }
  return `🚌✅ ${routeTitle(names, route)}: buses are back on the road — earlier service blackout has cleared.`;
}

function buildClearCardTitle(names, route) {
  return `${routeTitle(names, route)}: buses observed again`;
}

// Resolve the two terminal names for the shape we render: the shape runs
// start→destination, so the owning trip's headsign is the END terminal and the
// opposite-direction headsign the START terminal.
function terminalNamesForShape(gtfs, shapeId) {
  let owner = null;
  for (const t of gtfs.tripsById.values()) {
    if (String(t.shape_id) === String(shapeId)) {
      owner = t;
      break;
    }
  }
  if (!owner) return {};
  let startName = null;
  for (const t of gtfs.tripsById.values()) {
    if (
      String(t.route_id) === String(owner.route_id) &&
      t.direction_id !== owner.direction_id &&
      t.trip_headsign
    ) {
      startName = t.trip_headsign;
      break;
    }
  }
  return { fromName: startName, toName: owner.trip_headsign || null };
}

// Dimmed-route blackout map (best-effort; falls back to text on any failure).
async function buildBlackoutImage({ gtfs, shapes, shapesByRoute, names, route }) {
  const ids = [...(shapesByRoute.get(String(route)) || [])];
  let best = null;
  let bestId = null;
  for (const id of ids) {
    const s = shapes.get(id);
    if (s && (!best || (s.lengthFt || 0) > (best.lengthFt || 0))) {
      best = s;
      bestId = id;
    }
  }
  if (!best) return { image: null, alt: null };
  const { fromName, toName } = terminalNamesForShape(gtfs, bestId);
  const title = `⚠ ${routeTitle(names, route)}: service appears suspended`;
  try {
    const image = await renderBusDisruptionMap(best, { title, fromName, toName });
    if (!image) return { image: null, alt: null };
    const termClause =
      fromName && toName ? ` Terminals ${fromName} and ${toName} are labeled.` : '';
    const alt = `Map of ${routeTitle(names, route)} dimmed end-to-end to indicate the route appears to have no buses in service.${termClause}`;
    return { image, alt };
  } catch (e) {
    console.warn(`pulse: blackout map failed for ${route}: ${e.message}`);
    return { image: null, alt: null };
  }
}

async function handleClears(names, now, getAgent, dryRun) {
  const open = incidents.findUnresolvedDisruptions(
    { kind: 'bus', source: 'observed', sinceMs: CLEAR_LOOKBACK_MS },
    now,
  );
  for (const row of open) {
    const obs = storage.getRecentBusObservations(row.line, row.ts + 1);
    if (!obs || obs.length === 0) continue;
    const firstObsTs = obs.reduce((m, o) => (o.ts < m ? o.ts : m), obs[0].ts);
    const alertUri = findUnresolvedAlertForRoundup({ kind: 'bus', line: row.line });
    const text = buildClearText(names, row.line, { alertOpen: !!alertUri });
    if (dryRun) {
      console.log(`--- DRY RUN pulse clear ${row.line} ---\n${text}`);
      continue;
    }
    const agent = await getAgent();
    // Thread the ✅ under the open official alert when one is up; otherwise under
    // the original pulse post.
    const replyRef =
      (alertUri ? await resolveReplyRef(agent, alertUri) : null) ||
      (await resolveReplyRef(agent, row.postUri));
    if (!replyRef) {
      console.warn(
        `pulse: could not resolve reply ref for ${row.postUri} (route ${row.line}), skipping clear`,
      );
      continue;
    }
    // Attach a link card to the resolved event page (parity with cta-insights +
    // MARTA rail pulse), so the clear reply links back to the archive.
    const link = resolvedEventLink(row.postUri, buildClearCardTitle(names, row.line));
    // Mint the event's standard.site document + attach associatedRefs so the
    // clear card renders enhanced immediately, not after the page-side rebuild.
    const rkey = rkeyFromAtUri(row.postUri);
    const associatedRefs =
      link && rkey
        ? await eventAssociatedRefs(agent, { rkey, title: link.title, publishedAt: Date.now() })
        : null;
    const result = link
      ? await postWithExternal(agent, text, link, replyRef, associatedRefs)
      : await postText(agent, text, replyRef);
    console.log(`Posted pulse clear ${row.line}: ${result.url}`);
    incidents.recordDisruption(
      { kind: 'bus', line: row.line, source: 'observed-clear', posted: true, postUri: result.uri },
      firstObsTs,
    );
  }
}

async function handleStaleClears(now, dryRun) {
  const stale = incidents.findUnresolvedDisruptions(
    {
      kind: 'bus',
      source: 'observed',
      sinceMs: SYNTHETIC_CLEAR_LOOKBACK_MS,
      untilMs: CLEAR_LOOKBACK_MS,
    },
    now,
  );
  for (const row of stale) {
    const obs = storage.getRecentBusObservations(row.line, row.ts + 1);
    if (!obs || obs.length === 0) continue;
    const firstObsTs = obs.reduce((m, o) => (o.ts < m ? o.ts : m), obs[0].ts);
    if (dryRun) {
      console.log(
        `--- DRY RUN pulse synthetic clear ${row.line} @ ${new Date(firstObsTs).toISOString()} ---`,
      );
      continue;
    }
    incidents.recordDisruption(
      { kind: 'bus', line: row.line, source: 'observed-clear', posted: false, postUri: null },
      firstObsTs,
    );
    console.log(
      `pulse: synthesized clear for ${row.line} (first re-observation ${new Date(firstObsTs).toISOString()})`,
    );
  }
}

function minuteOfHourET(now) {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(now)),
  );
}

async function main() {
  setup();
  const gtfs = loadGtfs(GTFS_DIR);
  const idx = loadScheduleIndex();
  const { routes: busRoutes, names, shapesByRoute } = routeMeta(gtfs);
  const now = Date.now();
  const nowDate = new Date(now);
  const dryRun = !!(argv['dry-run'] || process.env.PULSE_DRY_RUN);

  let agentPromise = null;
  const getAgent = () => {
    if (!agentPromise) agentPromise = loginAlerts();
    return agentPromise;
  };

  await handleClears(names, now, getAgent, dryRun);
  await handleStaleClears(now, dryRun);

  // pulse owns higher-frequency routes; thin-gaps owns headway ≥ 20 min.
  const eligible = busRoutes.filter((r) => {
    const h = headwayForLine(idx, r, nowDate);
    return h != null && h < THIN_GAP_MIN_HEADWAY_MIN;
  });

  // Observations in the lookback ceiling, grouped by route → { ts, vid }.
  const sinceTs = now - LOOKBACK_CEIL_MS;
  const observationsByRoute = new Map();
  for (const o of storage.getRecentBusObservationsAll(sinceTs)) {
    const route = String(o.route);
    if (!observationsByRoute.has(route)) observationsByRoute.set(route, []);
    observationsByRoute.get(route).push({ ts: o.ts, vid: o.vehicleId });
  }
  const globalDistinctTs = storage.countDistinctBusObservationTs(sinceTs);
  const recentlyActiveRoutes = storage.getDistinctBusRoutesSince(now - COLD_START_GRACE_MS);

  const { skipped, candidates } = await detectBusBlackouts({
    routes: eligible,
    routeNames: Object.fromEntries(names),
    observationsByRoute,
    loadPattern: () => ({}), // MARTA scales the lookback off the schedule index, not pattern geometry
    getKnownPidsForRoute: (route) => [...(shapesByRoute.get(String(route)) || [])],
    expectedRouteActive: (route, when) => activeForLine(idx, route, new Date(when)),
    expectedHeadway: (route, _pattern, when) => headwayForLine(idx, route, new Date(when)),
    globalDistinctTs,
    recentlyActiveRoutes,
    now,
    opts: { minuteOfHour: minuteOfHourET(now) },
  });

  if (skipped) {
    console.log(`pulse: skipped (${skipped})`);
    return;
  }
  if (candidates.length === 0) {
    console.log('pulse: no route blackouts detected');
    return;
  }

  // One post per route per cooldown window.
  const fresh = candidates.filter((c) =>
    acquireCooldown(`pulse:${c.route}`, now, PULSE_COOLDOWN_MS),
  );
  if (fresh.length < candidates.length) {
    console.log(`pulse: ${candidates.length - fresh.length} candidate(s) on cooldown`);
  }
  if (fresh.length === 0) {
    console.log('pulse: all candidates on cooldown, nothing to post');
    return;
  }
  for (const c of fresh) {
    console.log(
      `  Route ${c.route}: no buses in past ${c.lookbackMin} min (expected ~${c.expectedActive.toFixed(1)} active)`,
    );
  }

  if (dryRun) {
    for (const c of fresh) {
      const headwayMin = headwayForLine(idx, c.route, nowDate);
      const text = buildPostText(names, c, { headwayMin });
      console.log(`\n--- DRY RUN pulse post ${c.route} ---\n${text}`);
    }
    return;
  }

  const shapes = loadShapes(GTFS_DIR);
  const agent = await getAgent();
  for (const c of fresh) {
    incidents.recordMetaSignal({
      kind: 'bus',
      line: c.route,
      direction: null,
      source: 'pulse-cold',
      severity: 1,
      detail: { lookbackMin: c.lookbackMin, expectedActive: c.expectedActive },
      posted: true,
    });

    const alertUri = findUnresolvedAlertForRoundup({ kind: 'bus', line: c.route });
    const headwayMin = headwayForLine(idx, c.route, nowDate);
    const text = buildPostText(names, c, { headwayMin, alertOpen: !!alertUri });
    const { image, alt } = await buildBlackoutImage({
      gtfs,
      shapes,
      shapesByRoute,
      names,
      route: c.route,
    });
    // Thread under the open official alert for the route when one exists.
    const replyRef = alertUri ? await resolveReplyRef(agent, alertUri) : null;

    const result = image
      ? await postWithImage(agent, text, image, alt, replyRef)
      : await postText(agent, text, replyRef);
    console.log(`Posted pulse ${c.route}: ${result.url}`);

    const lastSeenTs = storage.getLastBusObservationTs(c.route);
    incidents.recordDisruption(
      {
        kind: 'bus',
        line: c.route,
        source: 'observed',
        posted: true,
        postUri: result.uri,
        evidence: { lookbackMin: c.lookbackMin, expectedActive: c.expectedActive },
      },
      lastSeenTs ?? now,
    );
  }
}

module.exports = { buildPostText, buildClearText, routeMeta };

runBin(main);
