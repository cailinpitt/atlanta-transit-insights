#!/usr/bin/env node
// MARTA bus pulse — route-blackout detector. Port of cta-insights bin/bus/pulse.js
// (blackout path only; CTA's held-cluster sub-detector is deferred).
//
// Complements thin-gaps: thin-gaps owns low-frequency routes (headway ≥ 20 min);
// pulse owns the higher-frequency network, firing when a route that should have
// ≥2 buses on the road shows ZERO distinct vehicles in a headway-scaled lookback
// while the rest of the fleet reports normally. Posts a rollup thread to the bus
// account, records a standalone `observed` disruption (web export surfaces it),
// feeds the roundup a `pulse-cold` meta-signal, and threads a clear reply when
// buses reappear.
require('../../../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));

const { loadGtfs } = require('../../../src/marta/gtfs');
const { detectBusBlackouts } = require('../../../src/marta/bus/pulse');
const {
  loadScheduleIndex,
  headwayForLine,
  activeForLine,
} = require('../../../src/marta/bus/schedule');
const storage = require('../../../src/marta/storage');
const incidents = require('../../../src/marta/shared/incidents');
const { acquireCooldown } = require('../../../src/marta/shared/state');
const { loginBus, postText, resolveReplyRef } = require('../../../src/marta/shared/bluesky');
const { buildRollupThread } = require('../../../src/shared/post');
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

function buildClearText(names, route) {
  return `🚌✅ ${routeTitle(names, route)}: buses are back on the road — earlier service blackout has cleared.`;
}

function formatLine(names, c) {
  return `🚌 ${routeTitle(names, c.route)} · no buses observed in past ~${c.lookbackMin} min while the route should be running`;
}

function buildPostThread(names, candidates) {
  return buildRollupThread(
    '🛑 Bus routes off the air, past hour',
    candidates.map((c) => formatLine(names, c)),
  );
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
    const text = buildClearText(names, row.line);
    if (dryRun) {
      console.log(`--- DRY RUN pulse clear ${row.line} ---\n${text}`);
      continue;
    }
    const agent = await getAgent();
    const replyRef = await resolveReplyRef(agent, row.postUri);
    if (!replyRef) {
      console.warn(
        `pulse: could not resolve reply ref for ${row.postUri} (route ${row.line}), skipping clear`,
      );
      continue;
    }
    const result = await postText(agent, text, replyRef);
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
    if (!agentPromise) agentPromise = loginBus();
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

  const posts = buildPostThread(names, fresh);
  if (!posts || posts.length === 0) {
    console.log('pulse: no lines fit under the post limit, skipping');
    return;
  }
  if (dryRun) {
    for (let i = 0; i < posts.length; i++) {
      console.log(`\n--- DRY RUN post ${i + 1}/${posts.length} ---\n${posts[i].text}`);
    }
    return;
  }

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
  }

  const agent = await getAgent();
  let replyRef = null;
  let cursor = 0;
  for (let i = 0; i < posts.length; i++) {
    const result = await postText(agent, posts[i].text, replyRef);
    console.log(`Posted ${i + 1}/${posts.length}: ${result.url}`);
    const slice = fresh.slice(cursor, cursor + posts[i].lineCount);
    for (const c of slice) {
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
    cursor += posts[i].lineCount;
    if (i < posts.length - 1) replyRef = await resolveReplyRef(agent, result.uri);
  }
}

module.exports = { formatLine, buildPostThread, buildClearText, routeMeta };

runBin(main);
