#!/usr/bin/env node
// MARTA bus bunching: detect → render map → post (insights account), with the
// incident open/cooldown/cap lifecycle. Port of cta-insights bin/bus/bunching.js.
// Reads the latest bus snapshot from the observe loop's DB (no extra feed
// fetch), so it must run alongside the observe-buses cron. Supports --dry-run.
require('../../../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));

const { loadGtfs } = require('../../../src/marta/gtfs');
const { loadShapes, projectObservation } = require('../../../src/marta/bus/shapes');
const {
  bunchesFromObservations,
  findParkedBusVids,
  assignBusNumbers,
  TERMINAL_DIST_FT,
} = require('../../../src/marta/bus/bunching');
const { nearestStop, stopsNearShape } = require('../../../src/marta/bus/stops');
const storage = require('../../../src/marta/storage');
const incidents = require('../../../src/marta/shared/incidents');
const { isOnCooldown } = require('../../../src/marta/shared/state');
const { commitAndPost } = require('../../../src/marta/shared/postDetection');
const {
  loginBus,
  postWithImage,
  postWithVideo,
  postText,
} = require('../../../src/marta/shared/bluesky');
const { renderBunchingMap } = require('../../../src/marta/map/busBunching');
const {
  buildPostText,
  buildAltText,
  buildVideoPostText,
  buildVideoAltText,
} = require('../../../src/marta/bus/bunchingPost');
const { VIDEO_WINDOW_MS, captureBusBunchingHistoryVideo } = require('../../../src/marta/bus/video');
const { terminalZoneFt } = require('../../../src/shared/geo');
const { setup, writeDryRunAsset, runBin } = require('../../../src/marta/shared/runBin');

const GTFS_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'marta', 'gtfs');
const WINDOW_MS = 3 * 60 * 1000; // snapshot window: latest fix + parked detection
const MAP_CONTEXT_FT = 1500; // stop signs to show on each side of the bunch
const BUS_BUNCHING_DAILY_CAP = 3;

function routeTitleFor(gtfs, route) {
  const r = gtfs.routesByShortName.get(String(route));
  const long = r?.route_long_name;
  return long ? `Route ${route} (${long})` : `Route ${route}`;
}

async function main() {
  setup();
  const gtfs = loadGtfs(GTFS_DIR);
  const shapes = loadShapes(GTFS_DIR);

  const now = Date.now();
  const rows = storage.getRecentBusObservationsAll(now - WINDOW_MS);
  if (rows.length === 0) {
    console.log('No recent bus observations in the window — is observe-buses running?');
    return;
  }

  // Latest fix per vehicle for detection; the full window feeds parked detection.
  const latestByVid = new Map();
  for (const o of rows) latestByVid.set(o.vehicleId, o); // rows are ts-ascending
  const latest = [...latestByVid.values()];
  const tripByVid = new Map(latest.map((o) => [o.vehicleId, o.tripId]));
  console.log(`Window: ${rows.length} rows, ${latest.length} distinct vehicles`);

  // Confirmed-parked vehicles (barely moved across the window) — a candidate is
  // dropped if it lacks ≥2 non-parked members, so a knot of stopped buses
  // (layover, terminal queue) doesn't post as a bunch.
  const projectedWindow = [];
  for (const o of rows) {
    const proj = projectObservation(o, { gtfs, shapes });
    if (proj) projectedWindow.push({ vehicleId: o.vehicleId, distFt: proj.distFt });
  }
  const parkedVids = findParkedBusVids(projectedWindow);

  const bunches = bunchesFromObservations(latest, { gtfs, shapes, now });
  if (bunches.length === 0) {
    console.log('No bunching detected');
    return;
  }
  console.log(`Found ${bunches.length} candidate bunch(es):`);
  for (const b of bunches) {
    console.log(
      `  route ${b.route} shape ${b.shapeId} — ${b.vehicles.length} buses, span ${Math.round(b.spanFt)} ft`,
    );
  }

  const activeBunches = [];
  for (const candidate of bunches) {
    const movingCount = candidate.vehicles.filter((v) => !parkedVids.has(v.vehicleId)).length;
    const shape = shapes.get(candidate.shapeId);
    const lengthFt = shape?.lengthFt ?? 0;
    const dists = candidate.vehicles.map((v) => v.distFt);
    const lo = Math.min(...dists);
    const hi = Math.max(...dists);
    const zoneFt = terminalZoneFt(lengthFt);
    const terminal = lo < Math.max(zoneFt, TERMINAL_DIST_FT) || lengthFt - hi < zoneFt;
    if (movingCount >= 2 && !terminal) activeBunches.push(candidate);
  }
  if (!argv['dry-run']) {
    const closed = incidents.reconcileBunchingEvents({
      kind: 'bus',
      current: activeBunches.map((b) => ({ route: b.route, direction: b.shapeId })),
      now,
    });
    if (closed.length > 0) {
      console.log(`Resolved ${closed.length} open bus bunching event(s)`);
    }
  }

  let bunch = null;
  let cooldownOverridden = false;
  for (const candidate of activeBunches) {
    const movingCount = candidate.vehicles.filter((v) => !parkedVids.has(v.vehicleId)).length;
    if (movingCount < 2) {
      console.log(
        `  skip shape ${candidate.shapeId}: only ${movingCount} moving member(s) of ${candidate.vehicles.length}`,
      );
      continue;
    }

    // Terminal-layover guard: a bunch hugging either end of the shape is a
    // start/turnaround queue, not a real pileup. Detection already drops
    // clusters whose lead is < TERMINAL_DIST_FT; this also guards the far end.
    const shape = shapes.get(candidate.shapeId);
    const lengthFt = shape?.lengthFt ?? 0;
    const dists = candidate.vehicles.map((v) => v.distFt);
    const lo = Math.min(...dists);
    const hi = Math.max(...dists);
    const zoneFt = terminalZoneFt(lengthFt);
    if (lo < Math.max(zoneFt, TERMINAL_DIST_FT) || lengthFt - hi < zoneFt) {
      console.log(
        `  skip shape ${candidate.shapeId}: within terminal zone (${Math.round(zoneFt)} ft)`,
      );
      continue;
    }

    if (!argv['dry-run']) {
      const shapeKey = `shape:${candidate.shapeId}`;
      const routeKey = `route:${candidate.route}`;
      const cd = isOnCooldown(shapeKey) || isOnCooldown(routeKey);
      const cooldownAllows = incidents.bunchingCooldownAllows({
        kind: 'bus',
        route: candidate.route,
        candidate: { vehicleCount: candidate.vehicles.length, severityFt: candidate.spanFt },
      });
      if (cd && !cooldownAllows) {
        console.log(`  skip shape ${candidate.shapeId}: on cooldown`);
        recordSkip(candidate);
        continue;
      }
      if (cd && cooldownAllows) {
        console.log(
          `  override cooldown for shape ${candidate.shapeId}: ${candidate.vehicles.length} buses beats prior post`,
        );
        cooldownOverridden = true;
      }
      const capAllows = incidents.bunchingCapAllows({
        kind: 'bus',
        route: candidate.route,
        candidate: { vehicleCount: candidate.vehicles.length, severityFt: candidate.spanFt },
        cap: BUS_BUNCHING_DAILY_CAP,
      });
      if (!capAllows) {
        console.log(
          `  skip shape ${candidate.shapeId}: route ${candidate.route} at daily cap and not more severe`,
        );
        recordSkip(candidate);
        continue;
      }
    }
    bunch = candidate;
    break;
  }

  if (!bunch) {
    console.log('All candidates filtered (parked/terminal/cooldown/cap), nothing to post');
    return;
  }

  const shape = shapes.get(bunch.shapeId);
  const dists = bunch.vehicles.map((v) => v.distFt);
  const lo = Math.min(...dists);
  const hi = Math.max(...dists);
  const midLat = bunch.vehicles.reduce((s, v) => s + v.lat, 0) / bunch.vehicles.length;
  const midLon = bunch.vehicles.reduce((s, v) => s + v.lon, 0) / bunch.vehicles.length;
  const near = nearestStop(gtfs, midLat, midLon);
  const nearStopName = near?.stopName ?? null;
  const routeTitle = routeTitleFor(gtfs, bunch.route);
  const leadTripId = tripByVid.get(
    [...bunch.vehicles].sort((a, b) => b.distFt - a.distFt)[0].vehicleId,
  );
  const direction = gtfs.tripsById.get(leadTripId)?.trip_headsign || null;

  console.log(
    `Posting: route ${bunch.route} shape ${bunch.shapeId} — ${bunch.vehicles.length} buses, ${Math.round(bunch.spanFt)} ft near ${nearStopName}`,
  );

  // Callouts + all-time-record must be computed BEFORE recordBunching writes
  // this event, or they compare the event against itself.
  const callouts = incidents.bunchingCallouts({
    kind: 'bus',
    route: bunch.route,
    routeLabel: `Route ${bunch.route}`,
    vehicleCount: bunch.vehicles.length,
    severityFt: bunch.spanFt,
  });
  if (callouts.length > 0) console.log(`Callouts: ${callouts.join(' · ')}`);
  const previousRecord = incidents.previousMaxBunchingVehicleCount('bus');
  const isAllTimeRecord = bunch.vehicles.length > previousRecord;
  if (isAllTimeRecord)
    console.log(`🥇 new all-time record: ${bunch.vehicles.length} buses (was ${previousRecord})`);

  console.log('Rendering map...');
  const stops = stopsNearShape(gtfs, shape, lo - MAP_CONTEXT_FT, hi + MAP_CONTEXT_FT);
  const labels = assignBusNumbers(bunch.vehicles);
  let image;
  try {
    image = await renderBunchingMap(bunch, shape, stops, {
      labels,
      title: direction ? `${routeTitle} — ${direction}` : routeTitle,
    });
  } catch (e) {
    console.warn(`Map render failed (${e.message}); will post text-only`);
    image = null;
  }

  const ctx = { routeTitle, direction, nearStopName };
  const text = buildPostText(bunch, ctx, callouts, { isAllTimeRecord, previousRecord });
  const alt = buildAltText(bunch, ctx);

  if (argv['dry-run']) {
    const fname = `bunching-${bunch.route}-${bunch.shapeId}-${Date.now()}.jpg`;
    const out = image ? writeDryRunAsset(image, fname) : '(render failed — text only)';
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${out}`);
    return;
  }

  const baseEvent = {
    kind: 'bus',
    route: bunch.route,
    direction: bunch.shapeId,
    vehicleCount: bunch.vehicles.length,
    severityFt: bunch.spanFt,
    nearStop: nearStopName,
  };
  const posted = await commitAndPost({
    cooldownKeys: [`shape:${bunch.shapeId}`, `route:${bunch.route}`],
    forceClearCooldown: cooldownOverridden,
    recordSkip: () => incidents.recordBunching({ ...baseEvent, posted: false }),
    agentLogin: loginBus,
    image,
    text,
    alt,
    recordPosted: (primary) => {
      incidents.recordBunching({ ...baseEvent, posted: true, postUri: primary.uri });
      incidents.recordMetaSignal({
        kind: 'bus',
        line: bunch.route,
        direction: bunch.shapeId,
        source: 'bunching',
        severity: Math.min(1, bunch.vehicles.length / 4),
        detail: { vehicles: bunch.vehicles.length, nearStop: nearStopName },
        posted: true,
      });
    },
    postWithImage,
    postText,
  });
  if (posted?.primary?.uri) {
    try {
      const videoRows = storage.getRecentBusObservationsAll(Date.now() - VIDEO_WINDOW_MS);
      const video = await captureBusBunchingHistoryVideo(bunch, shape, videoRows, {
        gtfs,
        shapes,
        stops,
      });
      if (!video) {
        console.log('Timelapse history produced <2 frames, skipping reply');
        return;
      }
      const replyRef = {
        root: { uri: posted.primary.uri, cid: posted.primary.cid },
        parent: { uri: posted.primary.uri, cid: posted.primary.cid },
      };
      const reply = await postWithVideo(
        posted.agent,
        buildVideoPostText(video, bunch),
        video.buffer,
        buildVideoAltText(bunch, ctx),
        replyRef,
      );
      console.log(`Timelapse reply: ${reply.url}`);
    } catch (e) {
      console.warn(`Timelapse reply failed: ${e.message}`);
    }
  }
}

// Cooldown/cap skips still record a posted=0 row so analytics + callouts see it.
function recordSkip(candidate) {
  incidents.recordBunching({
    kind: 'bus',
    route: candidate.route,
    direction: candidate.shapeId,
    vehicleCount: candidate.vehicles.length,
    severityFt: candidate.spanFt,
    nearStop: null,
    posted: false,
  });
}

runBin(main);
