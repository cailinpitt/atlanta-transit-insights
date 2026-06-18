#!/usr/bin/env node
// MARTA cross-line rail bunching: a pileup at one spot involving 2+ lines (e.g.
// RED + GOLD stacked at Five Points or on the shared N-S trunk). detect →
// render station map → post (train account), keyed on the PLACE. Runs just
// before bin/marta/rail/bunching.js so its posted pileups suppress the per-line
// post for the same trains. Supports --dry-run. Static map only for now.
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
const { loginTrain, postWithImage, postText } = require('../../../src/marta/shared/bluesky');
const {
  renderCrossBunchingMap,
  pointsFromCluster,
} = require('../../../src/marta/map/crossBunching');
const { buildPostText, buildAltText } = require('../../../src/marta/rail/crossBunchingPost');
const { lineTitle } = require('../../../src/marta/rail/post');
const { setup, writeDryRunAsset, runBin } = require('../../../src/marta/shared/runBin');

const GTFS_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'marta', 'gtfs');
const WINDOW_MS = 3 * 60 * 1000;
const PLACE_MAX_FT = 2000; // rail stations are sparse; allow a bit more slack than bus
const CROSS_RAIL_DAILY_CAP = 3;

function placeFor(gtfs, centroid) {
  const near = nearestStop(gtfs, centroid.lat, centroid.lon);
  const placeName = near && near.distFt <= PLACE_MAX_FT ? near.stopName : null;
  const placeKey = placeName || `${centroid.lat.toFixed(3)},${centroid.lon.toFixed(3)}`;
  return { placeName, placeKey };
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
    if (closed.length > 0) console.log(`Resolved ${closed.length} open cross-line rail pileup(s)`);
  }
  if (clusters.length === 0) {
    console.log('No cross-line rail bunching detected');
    return;
  }
  console.log(`Found ${clusters.length} candidate cross-line pileup(s)`);

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
    routeLabel: place.placeName ? `pileup at ${place.placeName}` : 'multi-line pileup',
    vehicleCount: chosen.trains.length,
    severityFt: chosen.spanFt,
  });

  const { byLine, labels } = groupByLine(chosen);
  const ctx = { placeName: place.placeName };
  const text = buildPostText(chosen, ctx, callouts);
  const alt = buildAltText(chosen, ctx);

  let image;
  try {
    const { points, legend } = pointsFromCluster(chosen.trains, {
      idOf: (t) => t.trainId,
      groupKeyOf: (t) => t.line,
      labels,
      groupOrder: byLine.map((g) => g.line),
      legendLabelOf: (l) => lineTitle(l),
    });
    image = await renderCrossBunchingMap({
      points,
      legend,
      title: `${chosen.trains.length} trains · ${chosen.lineCount} lines`,
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
  await commitAndPost({
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
}

runBin(main);
