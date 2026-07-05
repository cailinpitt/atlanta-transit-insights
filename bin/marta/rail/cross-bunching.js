#!/usr/bin/env node
// MARTA cross-line rail bunching: a cluster at one spot involving 2+ lines (e.g.
// RED + GOLD close together at Five Points or on the shared N-S trunk). detect →
// render station map → post (train account), keyed on the PLACE. Runs just
// before bin/marta/rail/bunching.js so its posted clusters suppress the per-line
// post for the same trains. Replies with a ~10-min timelapse (from observation
// history). Supports --dry-run.
require('../../../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));

const { loadGtfs } = require('../../../src/marta/gtfs');
const { loadShapes } = require('../../../src/marta/bus/shapes');
const { buildLineGeometry } = require('../../../src/marta/rail/lines');
const { latestTrainPositions } = require('../../../src/marta/rail/trains');
const { detectCrossLineBunches, groupByLine } = require('../../../src/marta/rail/crossBunching');
const { nearestStop } = require('../../../src/marta/bus/stops');
const storage = require('../../../src/marta/storage');
const incidents = require('../../../src/marta/shared/incidents');
const { isOnCooldown } = require('../../../src/marta/shared/state');
const { commitAndPost } = require('../../../src/marta/shared/postDetection');
const {
  loginTrain,
  postWithImage,
  postWithVideo,
  postText,
} = require('../../../src/marta/shared/bluesky');
const {
  renderCrossBunchingMap,
  pointsFromCluster,
} = require('../../../src/marta/map/crossBunching');
const { lineColor } = require('../../../src/marta/map/railIncidents');
const { captureCrossBunchingVideo } = require('../../../src/marta/map/crossBunchingVideo');
const {
  buildPostText,
  buildAltText,
  buildVideoPostText,
  buildVideoAltText,
} = require('../../../src/marta/rail/crossBunchingPost');
const { lineTitle } = require('../../../src/marta/rail/post');
const { railDeviationsByTrain } = require('../../../src/marta/rail/adherence');
const { setup, writeDryRunAsset, runBin } = require('../../../src/marta/shared/runBin');

const GTFS_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'marta', 'gtfs');
const WINDOW_MS = 3 * 60 * 1000;
const VIDEO_WINDOW_MS = 10 * 60 * 1000; // history window for the timelapse reply
const PLACE_MAX_FT = 2000; // rail stations are sparse; allow a bit more slack than bus
const CROSS_RAIL_DAILY_CAP = 3;

function placeFor(gtfs, centroid) {
  const near = nearestStop(gtfs, centroid.lat, centroid.lon);
  const placeName = near && near.distFt <= PLACE_MAX_FT ? near.stopName : null;
  const placeKey = placeName || `${centroid.lat.toFixed(3)},${centroid.lon.toFixed(3)}`;
  return { placeName, placeKey };
}

// Route-line overlays for the map: each involved line's geometry, colored to
// match its discs + legend (groupIndex = index in groupOrder). The map module
// clips each to the framed intersection, so passing the whole line is fine.
// Best-effort — a line with no geometry just renders without a trace line.
function buildRoutePaths(lineGeom, groupOrder) {
  const paths = [];
  for (let groupIndex = 0; groupIndex < groupOrder.length; groupIndex++) {
    const geom = lineGeom.get(groupOrder[groupIndex]);
    const points = (geom?.points || [])
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map((p) => ({ lat: p.lat, lon: p.lon }));
    if (points.length >= 2) paths.push({ points, groupIndex });
  }
  return paths;
}

function recordSkip(cluster, placeKey, placeName, suppressed) {
  incidents.recordBunching({
    kind: 'rail-multi',
    route: placeKey,
    direction: cluster.lines.join(','),
    vehicleCount: cluster.trains.length,
    severityFt: cluster.spanFt,
    nearStop: placeName,
    posted: false,
  });
  incidents.recordMetaSignal({
    kind: 'rail',
    line: placeKey,
    direction: cluster.lines.join(','),
    source: 'cross-bunching',
    severity: Math.min(1, cluster.trains.length / 5),
    detail: { trains: cluster.trains.length, lines: cluster.lines, suppressed },
    posted: false,
  });
}

async function main() {
  setup();
  const gtfs = loadGtfs(GTFS_DIR);
  const shapes = loadShapes(GTFS_DIR);
  const lineGeom = buildLineGeometry(gtfs, shapes);

  const now = Date.now();
  const rows = storage.getRecentRailObservationsAll(now - WINDOW_MS);
  if (rows.length === 0) {
    console.log('No recent rail observations in the window - is observe-rail running?');
    return;
  }

  const trains = latestTrainPositions(rows, lineGeom, { now });
  const clusters = detectCrossLineBunches(trains);
  if (!argv['dry-run']) {
    const closed = incidents.reconcileBunchingEvents({
      kind: 'rail-multi',
      current: clusters.map((c) => ({
        route: placeFor(gtfs, c.centroid).placeKey,
        direction: c.lines.join(','),
      })),
      now,
    });
    if (closed.length > 0) console.log(`Resolved ${closed.length} open cross-line rail cluster(s)`);
  }
  if (clusters.length === 0) {
    console.log('No cross-line rail bunching detected');
    return;
  }
  console.log(`Found ${clusters.length} candidate cross-line cluster(s)`);

  let chosen = null;
  let place = null;
  let cooldownOverridden = false;
  for (const cluster of clusters) {
    const p = placeFor(gtfs, cluster.centroid);
    console.log(
      `  ${cluster.trains.length} trains / ${cluster.lineCount} lines (${cluster.lines.join(', ')}) near ${p.placeName || p.placeKey}`,
    );
    if (!argv['dry-run']) {
      const cdKey = `xbunch:rail:${p.placeKey}`;
      const cd = isOnCooldown(cdKey);
      const cooldownAllows = incidents.bunchingCooldownAllows({
        kind: 'rail-multi',
        route: p.placeKey,
        candidate: { vehicleCount: cluster.trains.length, severityFt: cluster.spanFt },
      });
      if (cd && !cooldownAllows) {
        console.log('  skip: on cooldown');
        recordSkip(cluster, p.placeKey, p.placeName, 'cooldown');
        continue;
      }
      if (cd && cooldownAllows) cooldownOverridden = true;
      const capAllows = incidents.bunchingCapAllows({
        kind: 'rail-multi',
        route: p.placeKey,
        candidate: { vehicleCount: cluster.trains.length, severityFt: cluster.spanFt },
        cap: CROSS_RAIL_DAILY_CAP,
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

  const callouts = incidents.bunchingCallouts({
    kind: 'rail-multi',
    route: place.placeKey,
    routeLabel: place.placeName ? `cluster at ${place.placeName}` : 'multi-line cluster',
    calloutNoun: '',
    vehicleCount: chosen.trains.length,
    severityFt: chosen.spanFt,
  });

  const { byLine, labels } = groupByLine(chosen);
  const ctx = { placeName: place.placeName };
  const text = buildPostText(chosen, ctx, callouts, { deviations: railDeviationsByTrain(rows) });
  const alt = buildAltText(chosen, ctx);

  const { points, legend } = pointsFromCluster(chosen.trains, {
    idOf: (t) => t.trainId,
    groupKeyOf: (t) => t.line,
    labels,
    groupOrder: byLine.map((g) => g.line),
    legendLabelOf: (l) => lineTitle(l),
  });
  const mapTitle = `${chosen.trains.length} trains · ${chosen.lineCount} lines`;
  const groupLines = byLine.map((g) => g.line);
  const routePaths = buildRoutePaths(lineGeom, groupLines);
  // Official MARTA line colors (RED, GOLD, BLUE, GREEN) so each disc + line reads
  // as its real line rather than an arbitrary palette swatch.
  const colors = groupLines.map((line) => lineColor(line));

  let image;
  try {
    image = await renderCrossBunchingMap({
      points,
      legend,
      title: mapTitle,
      markerKind: 'train',
      routePaths,
      colors,
    });
  } catch (e) {
    console.warn(`Map render failed (${e.message}); will post text-only`);
    image = null;
  }

  if (argv['dry-run']) {
    const out = image
      ? writeDryRunAsset(
          image,
          `cross-rail-${place.placeKey.replace(/[^a-z0-9]+/gi, '-')}-${Date.now()}.jpg`,
        )
      : '(render failed - text only)';
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${out}`);
    return;
  }

  const baseEvent = {
    kind: 'rail-multi',
    route: place.placeKey,
    direction: chosen.lines.join(','),
    vehicleCount: chosen.trains.length,
    severityFt: chosen.spanFt,
    nearStop: place.placeName,
    memberIds: chosen.trains.map((t) => t.trainId),
  };
  const posted = await commitAndPost({
    cooldownKeys: [`xbunch:rail:${place.placeKey}`],
    forceClearCooldown: cooldownOverridden,
    recordSkip: () => incidents.recordBunching({ ...baseEvent, posted: false }),
    agentLogin: loginTrain,
    image,
    text,
    alt,
    recordPosted: (primary) => {
      incidents.recordBunching({ ...baseEvent, posted: true, postUri: primary.uri });
      incidents.recordMetaSignal({
        kind: 'rail',
        line: place.placeKey,
        direction: chosen.lines.join(','),
        source: 'cross-bunching',
        severity: Math.min(1, chosen.trains.length / 5),
        detail: { trains: chosen.trains.length, lines: chosen.lines, nearStop: place.placeName },
        posted: true,
      });
    },
    postWithImage,
    postText,
  });

  // Timelapse reply is non-fatal — the primary post already went out.
  if (posted?.primary?.uri) {
    try {
      const groupOrder = byLine.map((g) => g.line);
      const groupIndexByLine = new Map(groupOrder.map((l, i) => [l, i]));
      const memberSet = new Set(chosen.trains.map((t) => String(t.trainId)));
      const videoRows = storage
        .getRecentRailObservationsAll(Date.now() - VIDEO_WINDOW_MS)
        .filter(
          (o) =>
            memberSet.has(String(o.trainId)) && Number.isFinite(o.lat) && Number.isFinite(o.lon),
        )
        .map((o) => ({
          id: String(o.trainId),
          lat: o.lat,
          lon: o.lon,
          ts: o.ts,
          label: String(labels.get(o.trainId) ?? '?'),
          groupIndex: groupIndexByLine.get(o.line) ?? 0,
        }));
      const video = await captureCrossBunchingVideo(videoRows, {
        legend,
        title: mapTitle,
        markerKind: 'train',
        routePaths,
        colors,
      });
      if (!video) {
        console.log('Rail timelapse history produced <2 frames, skipping reply');
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
      console.warn(`Rail timelapse reply failed: ${e.message}`);
    }
  }
}

runBin(main);
