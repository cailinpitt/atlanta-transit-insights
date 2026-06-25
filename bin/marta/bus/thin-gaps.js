#!/usr/bin/env node
// MARTA thin-service gap detector — port of cta-insights bin/bus/thin-gaps.js.
//
// The mainline gap/ghost/bunching detectors are structurally blind to
// low-frequency routes (gaps needs ≥2 buses on a shape; ghosts needs
// MISSING_ABS_THRESHOLD=3). A 30-min-headway route that simply stops running
// therefore goes unreported. This asks a binary question per eligible route:
// has *any* bus been observed in max(2 × scheduled headway, 60 min)? If not,
// and the route has steady-state service in the adjacent hours, fire. Posts a
// rollup thread to the bus account, records a standalone `observed-thin`
// disruption so the web export surfaces it, feeds the roundup a `thin-gap`
// meta-signal, and threads a clear reply when buses reappear.
require('../../../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));

const { loadGtfs } = require('../../../src/marta/gtfs');
const { detectThinGaps } = require('../../../src/marta/bus/thinGaps');
const {
  loadScheduleIndex,
  headwayForLine,
  activeForLine,
} = require('../../../src/marta/bus/schedule');
const storage = require('../../../src/marta/storage');
const incidents = require('../../../src/marta/shared/incidents');
const { acquireCooldown, isOnCooldown } = require('../../../src/marta/shared/state');
const { loginBus, postText, resolveReplyRef } = require('../../../src/marta/shared/bluesky');
const {
  sweepProgressUpdates,
  thinGapUpdate,
} = require('../../../src/marta/shared/incidentUpdates');
const { buildRollupThread } = require('../../../src/shared/post');
const { setup, runBin } = require('../../../src/marta/shared/runBin');

const GTFS_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'marta', 'gtfs');

// One thin-gap post per route per day — a chronically-down route shouldn't
// dominate the feed.
const DAILY_CAP_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Only consider genuinely low-frequency routes, so thin-gaps doesn't overlap
// the high-frequency detectors (and, later, pulse). 20 min comfortably clears
// the mainline gap floor (ABSOLUTE_MIN_MIN=15).
const THIN_GAP_MIN_HEADWAY_MIN = 20;

// Recency gate: the route must have been observed in realtime recently. This
// excludes two false-positive classes at once:
//   1. scheduled-but-untracked routes that NEVER appear in the vehicle feed
//      (MARTA's static GTFS carries express routes with no live tracking), and
//   2. stale multi-hour silences — a route last seen 13h ago isn't a "gap, past
//      hour," and the disruption ts is backdated to last-seen, so it would render
//      as an absurd 13h-old gap.
// 3h comfortably exceeds the detection window (max(2× headway, 60 min) ≈ 60–90
// min for eligible routes), so a genuinely fresh gap still fires. (pulse gets the
// equivalent for free via its 6h cold-start grace; thin-gaps needs it explicitly.)
const TRACKED_RECENT_MS = 3 * 60 * 60 * 1000;

// observe-buses runs every minute, so 30 min should show ~20+ distinct
// snapshots. Below this the ingestion pipeline is broken — bail rather than
// fan one upstream outage into a flood of per-route false positives.
const HEALTH_CHECK_WINDOW_MS = 30 * 60 * 1000;
const MIN_HEALTHY_SNAPSHOTS = 2;

// Bluesky reply window: beyond 24h the original thread is too cold for a
// "buses observed again" reply to read naturally.
const CLEAR_LOOKBACK_MS = 24 * 60 * 60 * 1000;
// Outer bound for the synthetic (no-reply) clear pass. Observations roll off at
// 7d so we can't prove recovery past that anyway.
const SYNTHETIC_CLEAR_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
// Cross-detector suppression window — mirror of pulse's. A route already
// reported silent by pulse shouldn't ALSO open a thin-gap (see eligibility).
const CROSS_DETECTOR_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

function routeMeta(gtfs) {
  const names = new Map();
  const routes = [];
  for (const r of gtfs.routes || []) {
    if (String(r.route_type) !== '3') continue; // bus
    const short = String(r.route_short_name || '').trim();
    if (!short) continue;
    routes.push(short);
    if (r.route_long_name) names.set(short, r.route_long_name);
  }
  return { routes: [...new Set(routes)], names };
}

function routeTitle(names, route) {
  const long = names.get(route);
  return long ? `Route ${route} (${long})` : `Route ${route}`;
}

function buildClearText(names, route) {
  return `🚌✅ ${routeTitle(names, route)}: buses observed on the route again — earlier thin-service gap has cleared.`;
}

function formatLine(names, e) {
  const headway = Math.round(e.headwayMin);
  const windowMin = Math.round(e.windowMin);
  return `🚌 ${routeTitle(names, e.route)} · no buses observed in past ~${windowMin} min (scheduled every ~${headway} min)`;
}

function buildPostThread(names, events) {
  return buildRollupThread(
    '🕳️ Thin-service gaps, past hour',
    events.map((e) => formatLine(names, e)),
  );
}

// Resolve open firings (within the 24h reply window) whose routes have buses
// again: record an observed-clear and thread a public reply.
async function handleClears(names, now, getAgent, dryRun) {
  const open = incidents.findUnresolvedDisruptions(
    { kind: 'bus', source: 'observed-thin', sinceMs: CLEAR_LOOKBACK_MS },
    now,
  );
  for (const row of open) {
    const obs = storage.getRecentBusObservations(row.line, row.ts + 1);
    if (!obs || obs.length === 0) continue;
    const firstObsTs = obs.reduce((m, o) => (o.ts < m ? o.ts : m), obs[0].ts);
    const text = buildClearText(names, row.line);
    if (dryRun) {
      console.log(`--- DRY RUN thin-gap clear ${row.line} ---\n${text}`);
      continue;
    }
    const agent = await getAgent();
    const replyRef = await resolveReplyRef(agent, row.postUri);
    if (!replyRef) {
      console.warn(
        `thin-gaps: could not resolve reply ref for ${row.postUri} (route ${row.line}), skipping clear`,
      );
      continue;
    }
    const result = await postText(agent, text, replyRef);
    console.log(`Posted thin-gap clear ${row.line}: ${result.url}`);
    incidents.recordDisruption(
      { kind: 'bus', line: row.line, source: 'observed-clear', posted: true, postUri: result.uri },
      firstObsTs,
    );
  }
}

// Sweep firings older than the reply window: record a synthetic observed-clear
// (no Bluesky reply) so the public dashboard stops showing them as active.
async function handleStaleClears(now, dryRun) {
  const stale = incidents.findUnresolvedDisruptions(
    {
      kind: 'bus',
      source: 'observed-thin',
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
        `--- DRY RUN thin-gap synthetic clear ${row.line} @ ${new Date(firstObsTs).toISOString()} ---`,
      );
      continue;
    }
    incidents.recordDisruption(
      { kind: 'bus', line: row.line, source: 'observed-clear', posted: false, postUri: null },
      firstObsTs,
    );
    console.log(
      `thin-gaps: synthesized clear for ${row.line} (first re-observation ${new Date(firstObsTs).toISOString()})`,
    );
  }
}

async function main() {
  setup();
  const gtfs = loadGtfs(GTFS_DIR);
  const idx = loadScheduleIndex();
  const { routes: busRoutes, names } = routeMeta(gtfs);
  const now = Date.now();
  const dryRun = !!(argv['dry-run'] || process.env.THIN_GAPS_DRY_RUN);

  // Health gate: if the observe loop has stalled, bail.
  const recentSnapshots = storage.countDistinctBusObservationTs(now - HEALTH_CHECK_WINDOW_MS);
  if (recentSnapshots < MIN_HEALTHY_SNAPSHOTS) {
    console.warn(
      `thin-gaps: only ${recentSnapshots} distinct snapshots in past ${HEALTH_CHECK_WINDOW_MS / 60000} min — observation pipeline looks unhealthy, skipping`,
    );
    return;
  }

  let agentPromise = null;
  const getAgent = () => {
    if (!agentPromise) agentPromise = loginBus();
    return agentPromise;
  };

  // Clear pass first so a recovered-then-rebroke route gets tidied up.
  await handleClears(names, now, getAgent, dryRun);
  await handleStaleClears(now, dryRun);

  // Hourly progress reply for thin-gaps still open after the clear pass — they're
  // genuinely still silent (any sighting would have cleared them above), so the
  // update is an honest "still no buses, ~Nh in, ~M trips missed".
  await sweepProgressUpdates({
    kind: 'bus',
    source: 'observed-thin',
    now,
    getAgent,
    dryRun,
    buildUpdate: ({ row, evidence }) => {
      const elapsedMin = (now - row.ts) / 60000;
      const headwayMin = evidence?.headwayMin ?? headwayForLine(idx, row.line, new Date(now));
      return thinGapUpdate({ routeTitle: routeTitle(names, row.line), headwayMin, elapsedMin });
    },
  });

  // Eligible = low-frequency routes that were observed in realtime recently.
  // Untracked GTFS-only routes and stale multi-hour silences are skipped.
  const nowDate = new Date(now);
  const recentlyTracked = storage.getDistinctBusRoutesSince(now - TRACKED_RECENT_MS);
  // Cross-detector suppression (mirror of pulse): the thin/pulse split is the
  // current-hour headway, so a route whose headway straddles 20 min across the
  // day can be claimed by both detectors for the SAME ongoing silence. Defer to
  // an already-open pulse blackout so a route has at most one open silence
  // incident. observed-clear is line-keyed and shared, releasing both.
  const openPulses = incidents.openSilenceLines(
    { kind: 'bus', source: 'observed', sinceMs: CROSS_DETECTOR_LOOKBACK_MS },
    now,
  );
  const eligible = busRoutes.filter((r) => {
    if (!recentlyTracked.has(String(r))) return false;
    if (openPulses.has(String(r))) return false;
    const h = headwayForLine(idx, r, nowDate);
    return h != null && h >= THIN_GAP_MIN_HEADWAY_MIN;
  });

  const priorHour = new Date(now - HOUR_MS);
  const nextHour = new Date(now + HOUR_MS);
  const drops = [];
  const allEvents = detectThinGaps({
    routes: eligible,
    getObservations: (route, since) => storage.getRecentBusObservations(route, since),
    getHeadway: (route) => headwayForLine(idx, route, nowDate),
    getActiveTrips: (route) => activeForLine(idx, route, nowDate),
    getPriorHourActiveTrips: (route) => activeForLine(idx, route, priorHour),
    getNextHourActiveTrips: (route) => activeForLine(idx, route, nextHour),
    now,
    onDrop: (d) => drops.push(d),
  });

  // One post per route per day.
  const events = allEvents.filter((e) => !isOnCooldown(`thin-gap:${e.route}`, now));
  const cooledDown = allEvents.length - events.length;
  if (cooledDown > 0) console.log(`thin-gaps: ${cooledDown} event(s) suppressed by daily cap`);

  if (events.length === 0) {
    console.log(`No thin-service gaps meet the threshold (drops: ${drops.length})`);
    return;
  }
  for (const e of events) {
    console.log(
      `  Route ${e.route}: no observations in past ${e.windowMin} min (scheduled headway ~${e.headwayMin.toFixed(1)} min, ${e.missedTrips} trips missed)`,
    );
  }

  const posts = buildPostThread(names, events);
  if (!posts || posts.length === 0) {
    console.log('No lines fit under the post limit, skipping');
    return;
  }
  if (dryRun) {
    for (let i = 0; i < posts.length; i++) {
      console.log(`\n--- DRY RUN post ${i + 1}/${posts.length} ---\n${posts[i].text}`);
    }
    return;
  }

  // Acquire cooldowns up front; drop any that lost the race so the post body
  // stays truthful.
  const committed = [];
  for (const e of events) {
    if (acquireCooldown(`thin-gap:${e.route}`, now, DAILY_CAP_KEY_TTL_MS)) committed.push(e);
    else console.log(`thin-gaps: lost cooldown race on route ${e.route}, skipping`);
  }
  if (committed.length === 0) {
    console.log('thin-gaps: all events lost cooldown race, nothing to post');
    return;
  }
  const finalPosts = committed.length === events.length ? posts : buildPostThread(names, committed);

  for (const e of committed) {
    incidents.recordMetaSignal({
      kind: 'bus',
      line: e.route,
      direction: null,
      source: 'thin-gap',
      severity: e.severity,
      detail: { headwayMin: e.headwayMin, windowMin: e.windowMin, missedTrips: e.missedTrips },
      posted: true,
    });
  }

  const agent = await getAgent();
  let replyRef = null;
  let eventCursor = 0;
  for (let i = 0; i < finalPosts.length; i++) {
    const result = await postText(agent, finalPosts[i].text, replyRef);
    console.log(`Posted ${i + 1}/${finalPosts.length}: ${result.url}`);
    const slice = committed.slice(eventCursor, eventCursor + finalPosts[i].lineCount);
    for (const e of slice) {
      // Backdate to the last moment a bus was actually seen, not the cron tick.
      const lastSeenTs = storage.getLastBusObservationTs(e.route);
      incidents.recordDisruption(
        {
          kind: 'bus',
          line: e.route,
          source: 'observed-thin',
          posted: true,
          postUri: result.uri,
          evidence: {
            headwayMin: e.headwayMin,
            windowMin: e.windowMin,
            missedTrips: e.missedTrips,
          },
        },
        lastSeenTs ?? now,
      );
    }
    eventCursor += finalPosts[i].lineCount;
    if (i < finalPosts.length - 1) replyRef = await resolveReplyRef(agent, result.uri);
  }
}

module.exports = { formatLine, buildPostThread, buildClearText, routeMeta };

runBin(main);
