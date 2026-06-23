#!/usr/bin/env node
// MARTA cross-route bus bunching: a pileup at one spot involving 2+ routes.
// detect → render intersection map → post (insights account), with the same
// incident open/cooldown/cap lifecycle as per-route bunching but keyed on the
// PLACE instead of a route. Runs just before bin/marta/bus/bunching.js so its
// posted pileups suppress the per-route post for the same buses. Replies with a
// ~10-min timelapse (from observation history). Supports --dry-run.
require('../../../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));

const { loadGtfs } = require('../../../src/marta/gtfs');
const { loadShapes, projectObservation, shapeForTrip } = require('../../../src/marta/bus/shapes');
const { haversineFt } = require('../../../src/shared/geo');
const {
  detectCrossRouteBunches,
  groupByRoute,
  isAtTerminal,
  collectShapeTerminals,
  nearAnyTerminal,
  STATION_BAY_FT,
} = require('../../../src/marta/bus/crossBunching');
const { findParkedBusVids } = require('../../../src/marta/bus/bunching');
const { nearestStop } = require('../../../src/marta/bus/stops');
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
const {
  renderCrossBunchingMap,
  pointsFromCluster,
} = require('../../../src/marta/map/crossBunching');
const { captureCrossBunchingVideo } = require('../../../src/marta/map/crossBunchingVideo');
const {
  buildPostText,
  buildAltText,
  buildVideoPostText,
  buildVideoAltText,
} = require('../../../src/marta/bus/crossBunchingPost');
const { setup, writeDryRunAsset, runBin } = require('../../../src/marta/shared/runBin');

const GTFS_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'marta', 'gtfs');
const WINDOW_MS = 3 * 60 * 1000;
const VIDEO_WINDOW_MS = 10 * 60 * 1000; // history window for the timelapse reply
const PLACE_MAX_FT = 1500; // beyond this the nearest stop isn't a fair label
const CROSS_BUS_DAILY_CAP = 3;

function routeTitleFor(gtfs, route) {
  const r = gtfs.routesByShortName.get(String(route));
  const long = r?.route_long_name;
  return long ? `Route ${route} (${long})` : `Route ${route}`;
}

// A pileup is a place, not a route. Key the lifecycle on the nearest stop name
// when we have one, else a coarse rounded centroid, so the same corner cools
// down / caps together across snapshots.
function placeFor(gtfs, centroid) {
  const near = nearestStop(gtfs, centroid.lat, centroid.lon);
  const placeName = near && near.distFt <= PLACE_MAX_FT ? near.stopName : null;
  const placeKey = placeName || `${centroid.lat.toFixed(3)},${centroid.lon.toFixed(3)}`;
  return { placeName, placeKey };
}

// Route-line overlays for the map: for each route group, draw the GTFS shape the
// pileup is sitting on. We pick the clustered bus of that route nearest the
// centroid and resolve its trip's shape (buses in a bunch share a trip pattern,
// so any of them resolves the same line through the corner). groupIndex matches
// the disc color so each line ties to its vehicles + legend. Best-effort — a
// route whose shape won't resolve is just left without a line.
function buildRoutePaths(gtfs, shapes, cluster, groupOrder) {
  const paths = [];
  for (let groupIndex = 0; groupIndex < groupOrder.length; groupIndex++) {
    const route = groupOrder[groupIndex];
    const members = cluster.vehicles.filter((v) => v.route === route && v.tripId);
    if (members.length === 0) continue;
    const rep = members.reduce((a, b) =>
      haversineFt(b, cluster.centroid) < haversineFt(a, cluster.centroid) ? b : a,
    );
    const shape = shapeForTrip(gtfs, shapes, rep.tripId);
    const points = (shape?.points || [])
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map((p) => ({ lat: p.lat, lon: p.lon }));
    if (points.length >= 2) paths.push({ points, groupIndex });
  }
  return paths;
}

function recordSkip(cluster, placeKey, placeName, suppressed) {
  incidents.recordBunching({
    kind: 'bus-multi',
    route: placeKey,
    direction: cluster.routes.join(','),
    vehicleCount: cluster.vehicles.length,
    severityFt: cluster.spanFt,
    nearStop: placeName,
    posted: false,
  });
  incidents.recordMetaSignal({
    kind: 'bus',
    line: placeKey,
    direction: cluster.routes.join(','),
    source: 'cross-bunching',
    severity: Math.min(1, cluster.vehicles.length / 5),
    detail: { vehicles: cluster.vehicles.length, routes: cluster.routes, suppressed },
    posted: false,
  });
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

  // Latest fix per vehicle for clustering; full window feeds the congestion gate.
  const latestByVid = new Map();
  for (const o of rows) latestByVid.set(o.vehicleId, o);
  const vehicles = [];
  for (const o of latestByVid.values()) {
    if (!Number.isFinite(o.lat) || !Number.isFinite(o.lon)) continue;
    const trip = gtfs.tripsById.get(o.tripId);
    const route = trip ? (gtfs.routesById.get(trip.route_id)?.route_short_name ?? null) : null;
    if (route == null) continue;
    vehicles.push({
      vehicleId: o.vehicleId,
      route: String(route),
      lat: o.lat,
      lon: o.lon,
      tmstmp: o.ts,
      tripId: o.tripId,
    });
  }

  // Congestion gate input: confirmed-parked buses (barely moved across the window).
  const projectedWindow = [];
  for (const o of rows) {
    const proj = projectObservation(o, { gtfs, shapes });
    if (proj) projectedWindow.push({ vehicleId: o.vehicleId, distFt: proj.distFt });
  }
  const stoppedIds = findParkedBusVids(projectedWindow);

  // Layover gate: a parked bus sitting at its route terminal OR at a rail-station
  // bus bay is between trips, not stuck in traffic. Several routes lay over
  // together at the same transit center (Doraville, Lindbergh, …), which would
  // otherwise read as a multi-route pileup. Drop these before clustering. The
  // off-route slack is widened since layover bays sit back from the route line.
  const STATION_NAME_RE = /\bstation\b/i;
  // Geographic terminals of every route (shape endpoints), as a route-agnostic
  // layover backstop — catches parked buses resting at a shared layover point
  // (e.g. Shannon Pkwy @ Lancaster Ln) that their own currently-tagged trip's
  // shape doesn't flag as a terminal.
  const terminalPoints = collectShapeTerminals(shapes);
  const layoverIds = new Set();
  for (const v of vehicles) {
    if (!stoppedIds.has(v.vehicleId)) continue;
    const shape = shapeForTrip(gtfs, shapes, v.tripId);
    const proj = projectObservation(v, { gtfs, shapes, maxOffrouteFt: 1500 });
    let layover = !!(shape && proj && isAtTerminal(proj.distFt, shape.lengthFt));
    if (!layover) layover = nearAnyTerminal(v.lat, v.lon, terminalPoints);
    if (!layover) {
      const near = nearestStop(gtfs, v.lat, v.lon);
      layover = !!(near && near.distFt <= STATION_BAY_FT && STATION_NAME_RE.test(near.stopName));
    }
    if (layover) layoverIds.add(v.vehicleId);
  }
  if (layoverIds.size > 0)
    console.log(`Excluding ${layoverIds.size} layover bus(es) at terminals/bays`);

  const clusters = detectCrossRouteBunches(vehicles, { now, stoppedIds, layoverIds });
  if (!argv['dry-run']) {
    const closed = incidents.reconcileBunchingEvents({
      kind: 'bus-multi',
      current: clusters.map((c) => ({
        route: placeFor(gtfs, c.centroid).placeKey,
        direction: c.routes.join(','),
      })),
      now,
    });
    if (closed.length > 0) console.log(`Resolved ${closed.length} open cross-route bus pileup(s)`);
  }
  if (clusters.length === 0) {
    console.log('No cross-route bus bunching detected');
    return;
  }
  console.log(`Found ${clusters.length} candidate cross-route pileup(s)`);

  let chosen = null;
  let place = null;
  let cooldownOverridden = false;
  for (const cluster of clusters) {
    const p = placeFor(gtfs, cluster.centroid);
    console.log(
      `  ${cluster.vehicles.length} buses / ${cluster.routeCount} routes (${cluster.routes.join(', ')}) near ${p.placeName || p.placeKey}`,
    );
    if (!argv['dry-run']) {
      const cdKey = `xbunch:bus:${p.placeKey}`;
      const cd = isOnCooldown(cdKey);
      const cooldownAllows = incidents.bunchingCooldownAllows({
        kind: 'bus-multi',
        route: p.placeKey,
        candidate: { vehicleCount: cluster.vehicles.length, severityFt: cluster.spanFt },
      });
      if (cd && !cooldownAllows) {
        console.log('  skip: on cooldown');
        recordSkip(cluster, p.placeKey, p.placeName, 'cooldown');
        continue;
      }
      if (cd && cooldownAllows) cooldownOverridden = true;
      const capAllows = incidents.bunchingCapAllows({
        kind: 'bus-multi',
        route: p.placeKey,
        candidate: { vehicleCount: cluster.vehicles.length, severityFt: cluster.spanFt },
        cap: CROSS_BUS_DAILY_CAP,
      });
      if (!capAllows) {
        console.log('  skip: at daily cap and not more severe');
        recordSkip(cluster, p.placeKey, p.placeName, 'cap');
        continue;
      }
    }
    chosen = cluster;
    place = p;
    break;
  }

  if (!chosen) {
    console.log('All candidates filtered (cooldown/cap), nothing to post');
    return;
  }

  // Callouts BEFORE recordBunching so the new event isn't compared against itself.
  const callouts = incidents.bunchingCallouts({
    kind: 'bus-multi',
    route: place.placeKey,
    routeLabel: place.placeName ? `pileup near ${place.placeName}` : 'multi-route pileup',
    vehicleCount: chosen.vehicles.length,
    severityFt: chosen.spanFt,
  });

  const { byRoute, labels } = groupByRoute(chosen);
  const routeTitles = new Map(chosen.routes.map((r) => [r, routeTitleFor(gtfs, r)]));
  const ctx = { placeName: place.placeName, routeTitles };
  const text = buildPostText(chosen, ctx, callouts);
  const alt = buildAltText(chosen, ctx);

  const { points, legend } = pointsFromCluster(chosen.vehicles, {
    idOf: (v) => v.vehicleId,
    groupKeyOf: (v) => v.route,
    labels,
    groupOrder: byRoute.map((g) => g.route),
    legendLabelOf: (r) => routeTitles.get(r) || `Route ${r}`,
  });
  const mapTitle = `${chosen.vehicles.length} buses · ${chosen.routeCount} routes`;
  const routePaths = buildRoutePaths(
    gtfs,
    shapes,
    chosen,
    byRoute.map((g) => g.route),
  );

  let image;
  try {
    image = await renderCrossBunchingMap({
      points,
      legend,
      title: mapTitle,
      markerKind: 'bus',
      routePaths,
    });
  } catch (e) {
    console.warn(`Map render failed (${e.message}); will post text-only`);
    image = null;
  }

  if (argv['dry-run']) {
    const out = image
      ? writeDryRunAsset(
          image,
          `cross-bus-${place.placeKey.replace(/[^a-z0-9]+/gi, '-')}-${Date.now()}.jpg`,
        )
      : '(render failed — text only)';
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${out}`);
    return;
  }

  const baseEvent = {
    kind: 'bus-multi',
    route: place.placeKey,
    direction: chosen.routes.join(','),
    vehicleCount: chosen.vehicles.length,
    severityFt: chosen.spanFt,
    nearStop: place.placeName,
    memberIds: chosen.vehicles.map((v) => v.vehicleId),
  };
  const posted = await commitAndPost({
    cooldownKeys: [`xbunch:bus:${place.placeKey}`],
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
        line: place.placeKey,
        direction: chosen.routes.join(','),
        source: 'cross-bunching',
        severity: Math.min(1, chosen.vehicles.length / 5),
        detail: {
          vehicles: chosen.vehicles.length,
          routes: chosen.routes,
          nearStop: place.placeName,
        },
        posted: true,
      });
    },
    postWithImage,
    postText,
  });

  // Timelapse reply is non-fatal — the primary post already went out.
  if (posted?.primary?.uri) {
    try {
      const groupOrder = byRoute.map((g) => g.route);
      const groupIndexByRoute = new Map(groupOrder.map((r, i) => [r, i]));
      const routeByVid = new Map(chosen.vehicles.map((v) => [String(v.vehicleId), v.route]));
      const memberSet = new Set(chosen.vehicles.map((v) => String(v.vehicleId)));
      const videoRows = storage
        .getRecentBusObservationsAll(Date.now() - VIDEO_WINDOW_MS)
        .filter(
          (o) =>
            memberSet.has(String(o.vehicleId)) && Number.isFinite(o.lat) && Number.isFinite(o.lon),
        )
        .map((o) => ({
          id: String(o.vehicleId),
          lat: o.lat,
          lon: o.lon,
          ts: o.ts,
          label: String(labels.get(o.vehicleId) ?? '?'),
          groupIndex: groupIndexByRoute.get(routeByVid.get(String(o.vehicleId))) ?? 0,
        }));
      const video = await captureCrossBunchingVideo(videoRows, {
        legend,
        title: mapTitle,
        markerKind: 'bus',
        routePaths,
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
        buildVideoPostText(video, chosen),
        video.buffer,
        buildVideoAltText(chosen, ctx),
        replyRef,
      );
      console.log(`Timelapse reply: ${reply.url}`);
    } catch (e) {
      console.warn(`Timelapse reply failed: ${e.message}`);
    }
  }
}

runBin(main);
