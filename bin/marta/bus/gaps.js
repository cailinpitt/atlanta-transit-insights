#!/usr/bin/env node
require('../../../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));

const { loadGtfs } = require('../../../src/marta/gtfs');
const { loadShapes } = require('../../../src/marta/bus/shapes');
const {
  gapsFromObservations,
  RATIO_THRESHOLD,
  ABSOLUTE_MIN_MIN,
} = require('../../../src/marta/bus/gaps');
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
const { renderGapMap } = require('../../../src/marta/map/busGap');
const {
  buildPostText,
  buildAltText,
  buildVideoPostText,
  buildVideoAltText,
} = require('../../../src/marta/bus/gapPost');
const { busDeviationsByVid } = require('../../../src/marta/bus/adherence');
const { VIDEO_WINDOW_MS, captureBusGapHistoryVideo } = require('../../../src/marta/bus/video');
const { setup, writeDryRunAsset, runBin } = require('../../../src/marta/shared/runBin');

const GTFS_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'marta', 'gtfs');
const WINDOW_MS = 3 * 60 * 1000;
const MAP_CONTEXT_FT = 1800;
const BUS_GAP_DAILY_CAP = 3;

function routeTitleFor(gtfs, route) {
  const r = gtfs.routesByShortName.get(String(route));
  const long = r?.route_long_name;
  return long ? `Route ${route} (${long})` : `Route ${route}`;
}

function gapSegmentDetail(g) {
  return {
    fromStation: g.flankBefore?.stopName || null,
    toStation: g.flankAfter?.stopName || null,
  };
}

function recordSuppressed(gap, nearStop, suppressed) {
  incidents.recordGap({
    kind: 'bus',
    route: gap.route,
    direction: gap.shapeId,
    gapFt: gap.gapFt,
    gapMin: gap.gapMin,
    expectedMin: gap.expectedMin,
    ratio: gap.ratio,
    nearStop,
    posted: false,
  });
  incidents.recordMetaSignal({
    kind: 'bus',
    line: gap.route,
    direction: gap.shapeId,
    source: 'gap',
    severity: Math.min(1, gap.ratio / 4),
    detail: { ratio: gap.ratio, gapMin: gap.gapMin, suppressed, ...gapSegmentDetail(gap) },
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
    console.log('No recent bus observations in the window - is observe-buses running?');
    return;
  }

  const latestByVid = new Map();
  for (const o of rows) latestByVid.set(o.vehicleId, o);
  const latest = [...latestByVid.values()];
  console.log(`Window: ${rows.length} rows, ${latest.length} distinct vehicles`);

  const gaps = gapsFromObservations(latest, { gtfs, shapes, now });
  if (!argv['dry-run']) {
    const closed = incidents.reconcileGapEvents({
      kind: 'bus',
      current: gaps.map((g) => ({ route: g.route, direction: g.shapeId })),
      now,
    });
    if (closed.length > 0) {
      console.log(`Resolved ${closed.length} open bus gap event(s)`);
    }
  }
  if (gaps.length === 0) {
    console.log('No significant gaps detected');
    return;
  }
  console.log(`Found ${gaps.length} candidate gap(s):`);
  for (const g of gaps) {
    console.log(
      `  route ${g.route} shape ${g.shapeId} - ${Math.round(g.gapMin)} min gap (${g.ratio.toFixed(2)}x expected)`,
    );
  }

  let gap = null;
  let nearStop = null;
  let cooldownOverridden = false;
  for (const candidate of gaps) {
    const midLat = (candidate.leading.lat + candidate.trailing.lat) / 2;
    const midLon = (candidate.leading.lon + candidate.trailing.lon) / 2;
    const near = nearestStop(gtfs, midLat, midLon);
    const nearName = near?.stopName || null;

    if (!argv['dry-run']) {
      const shapeKey = `gap:${candidate.shapeId}`;
      const routeKey = `gap:route:${candidate.route}`;
      const shapeCd = isOnCooldown(shapeKey);
      const routeCd = isOnCooldown(routeKey);
      const cooldownAllows = incidents.gapCooldownAllows({
        kind: 'bus',
        route: candidate.route,
        candidate: { ratio: candidate.ratio },
      });
      if ((shapeCd || routeCd) && !cooldownAllows) {
        console.log(`  skip shape ${candidate.shapeId}: on cooldown`);
        recordSuppressed(candidate, nearName, 'cooldown');
        continue;
      }
      if ((shapeCd || routeCd) && cooldownAllows) {
        console.log(
          `  override cooldown for shape ${candidate.shapeId}: ${candidate.ratio.toFixed(2)}x is materially worse`,
        );
        cooldownOverridden = true;
      }
      const capAllows = incidents.gapCapAllows({
        kind: 'bus',
        route: candidate.route,
        candidate: { ratio: candidate.ratio },
        cap: BUS_GAP_DAILY_CAP,
      });
      if (!capAllows) {
        console.log(`  skip shape ${candidate.shapeId}: route ${candidate.route} at daily cap`);
        recordSuppressed(candidate, nearName, 'cap');
        continue;
      }
    }
    gap = candidate;
    nearStop = near;
    break;
  }

  if (!gap) {
    console.log('All candidates filtered (cooldown/cap), nothing to post');
    return;
  }

  if (gap.gapMin < ABSOLUTE_MIN_MIN || gap.ratio < RATIO_THRESHOLD) {
    console.log(
      `Gap no longer meets threshold (${gap.gapMin.toFixed(1)} min, ${gap.ratio.toFixed(2)}x); skipping`,
    );
    return;
  }

  const shape = shapes.get(gap.shapeId);
  const routeTitle = routeTitleFor(gtfs, gap.route);
  const leadTrip = gtfs.tripsById.get(gap.leading.tripId);
  const direction = leadTrip?.trip_headsign || null;
  const nearStopName = nearStop?.stopName || null;
  const stops = stopsNearShape(
    gtfs,
    shape,
    Math.min(gap.trailing.distFt, gap.leading.distFt) - MAP_CONTEXT_FT,
    Math.max(gap.trailing.distFt, gap.leading.distFt) + MAP_CONTEXT_FT,
  );

  console.log(
    `Posting: route ${gap.route} shape ${gap.shapeId} - ${Math.round(gap.gapMin)} min gap (${gap.ratio.toFixed(2)}x expected) near ${nearStopName}`,
  );

  const callouts = incidents.gapCallouts({
    kind: 'bus',
    route: gap.route,
    routeLabel: `Route ${gap.route}`,
    ratio: gap.ratio,
  });
  if (callouts.length > 0) console.log(`Callouts: ${callouts.join(' · ')}`);

  let image;
  try {
    image = await renderGapMap(gap, shape, stops, {
      title: direction ? `${routeTitle} - ${direction}` : routeTitle,
      nearStop,
    });
  } catch (e) {
    console.warn(`Map render failed (${e.message}); will post text-only`);
    image = null;
  }

  const ctx = { routeTitle, direction, nearStopName };
  const deviations = busDeviationsByVid(rows);
  const text = buildPostText(gap, ctx, callouts, {
    leadingDev: deviations.get(gap.leading?.vehicleId),
    trailingDev: deviations.get(gap.trailing?.vehicleId),
  });
  const alt = buildAltText(gap, ctx);

  if (argv['dry-run']) {
    const fname = `gap-${gap.route}-${gap.shapeId}-${Date.now()}.jpg`;
    const out = image ? writeDryRunAsset(image, fname) : '(render failed - text only)';
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${out}`);
    if (argv.video) {
      console.log('\nBuilding gap timelapse from recent observations...');
      const videoRows = storage.getRecentBusObservationsAll(Date.now() - VIDEO_WINDOW_MS);
      const video = await captureBusGapHistoryVideo(gap, shape, videoRows, { gtfs, shapes, stops });
      if (!video) {
        console.log('Gap timelapse skipped (<2 frames in window)');
      } else {
        const videoPath = writeDryRunAsset(
          video.buffer,
          `gap-${gap.route}-${gap.shapeId}-${Date.now()}.mp4`,
        );
        console.log(`Video: ${videoPath}\n${buildVideoPostText(video, gap, ctx)}`);
      }
    }
    return;
  }

  const baseEvent = {
    kind: 'bus',
    route: gap.route,
    direction: gap.shapeId,
    gapFt: gap.gapFt,
    gapMin: gap.gapMin,
    expectedMin: gap.expectedMin,
    ratio: gap.ratio,
    nearStop: nearStopName,
  };
  const posted = await commitAndPost({
    cooldownKeys: [`gap:${gap.shapeId}`, `gap:route:${gap.route}`],
    forceClearCooldown: cooldownOverridden,
    recordSkip: () => incidents.recordGap({ ...baseEvent, posted: false }),
    agentLogin: loginBus,
    image,
    text,
    alt,
    recordPosted: (primary) => {
      incidents.recordGap({ ...baseEvent, posted: true, postUri: primary.uri });
      incidents.recordMetaSignal({
        kind: 'bus',
        line: gap.route,
        direction: gap.shapeId,
        source: 'gap',
        severity: Math.min(1, gap.ratio / 4),
        detail: {
          ratio: gap.ratio,
          gapMin: gap.gapMin,
          nearStop: baseEvent.nearStop,
          ...gapSegmentDetail(gap),
        },
        posted: true,
      });
    },
    postWithImage,
    postText,
  });
  if (posted?.primary?.uri) {
    try {
      const videoRows = storage.getRecentBusObservationsAll(Date.now() - VIDEO_WINDOW_MS);
      const video = await captureBusGapHistoryVideo(gap, shape, videoRows, {
        gtfs,
        shapes,
        stops,
      });
      if (!video) {
        console.log('Gap timelapse history produced <2 frames, skipping reply');
        return;
      }
      const replyRef = {
        root: { uri: posted.primary.uri, cid: posted.primary.cid },
        parent: { uri: posted.primary.uri, cid: posted.primary.cid },
      };
      const reply = await postWithVideo(
        posted.agent,
        buildVideoPostText(video, gap, ctx),
        video.buffer,
        buildVideoAltText(gap, ctx, video),
        replyRef,
      );
      console.log(`Timelapse reply: ${reply.url}`);
    } catch (e) {
      console.warn(`Gap timelapse reply failed: ${e.message}`);
    }
  }
}

runBin(main);
