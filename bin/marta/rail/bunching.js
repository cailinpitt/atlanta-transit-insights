#!/usr/bin/env node
require('../../../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));

const { loadGtfs } = require('../../../src/marta/gtfs');
const { loadShapes } = require('../../../src/marta/bus/shapes');
const { buildLineGeometry } = require('../../../src/marta/rail/lines');
const { buildLineTermini, terminusFor } = require('../../../src/marta/rail/termini');
const { railBunchesFromObservations } = require('../../../src/marta/rail/bunching');
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
const { setup, writeDryRunAsset, runBin } = require('../../../src/marta/shared/runBin');
const { renderRailBunchingMap } = require('../../../src/marta/map/railIncidents');
const {
  lineTitle,
  directionLabel,
  buildBunchingPostText,
  buildBunchingAltText,
  buildBunchingVideoPostText,
  buildBunchingVideoAltText,
} = require('../../../src/marta/rail/post');
const {
  VIDEO_WINDOW_MS,
  captureRailBunchingHistoryVideo,
} = require('../../../src/marta/rail/video');

const GTFS_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'marta', 'gtfs');
const WINDOW_MS = 3 * 60 * 1000;
const RAIL_BUNCHING_DAILY_CAP = 3;

// Map-chip labels: plain numerals (1 = lead train, furthest along the line).
// librsvg has no color-emoji font, so keycap glyphs (1️⃣) render as empty tofu
// on the map; the post text still uses keycaps. Matches the bus map labeling.
function trainLabels(bunch) {
  const labels = new Map();
  [...bunch.trains]
    .sort((a, b) => b.distFt - a.distFt)
    .forEach((t, i) => {
      labels.set(t.trainId, String(i + 1));
    });
  return labels;
}

function recordSuppressed(bunch, suppressed) {
  incidents.recordBunching({
    kind: 'rail',
    route: bunch.line,
    direction: bunch.direction,
    vehicleCount: bunch.trains.length,
    severityFt: bunch.spanFt,
    nearStop: null,
    posted: false,
  });
  incidents.recordMetaSignal({
    kind: 'rail',
    line: bunch.line,
    direction: bunch.direction || null,
    source: 'bunching',
    severity: Math.min(1, bunch.trains.length / 4),
    detail: { trains: bunch.trains.length, suppressed },
    posted: false,
  });
}

async function main() {
  setup();
  const gtfs = loadGtfs(GTFS_DIR);
  const shapes = loadShapes(GTFS_DIR);
  const lineGeom = buildLineGeometry(gtfs, shapes);
  const termini = buildLineTermini(gtfs);
  const now = Date.now();
  const rows = storage.getRecentRailObservationsAll(now - WINDOW_MS);
  if (rows.length === 0) {
    console.log('No recent rail observations in the window - is observe-rail running?');
    return;
  }

  const bunches = railBunchesFromObservations(rows, { lineGeom, now });
  if (!argv['dry-run']) {
    const closed = incidents.reconcileBunchingEvents({
      kind: 'rail',
      current: bunches.map((b) => ({ route: b.line, direction: b.direction })),
      now,
    });
    if (closed.length > 0) {
      console.log(`Resolved ${closed.length} open rail bunching event(s)`);
    }
  }
  if (bunches.length === 0) {
    console.log('No rail bunching detected');
    return;
  }
  console.log(`Found ${bunches.length} candidate rail bunch(es)`);

  let bunch = null;
  let cooldownOverridden = false;
  for (const candidate of bunches) {
    if (!argv['dry-run']) {
      const lineKey = `rail:bunch:${candidate.line}`;
      const dirKey = `rail:bunch:${candidate.line}:${candidate.direction}`;
      const cd = isOnCooldown(lineKey) || isOnCooldown(dirKey);
      const cooldownAllows = incidents.bunchingCooldownAllows({
        kind: 'rail',
        route: candidate.line,
        candidate: { vehicleCount: candidate.trains.length, severityFt: candidate.spanFt },
      });
      if (cd && !cooldownAllows) {
        console.log(`  skip ${candidate.line}/${candidate.direction}: on cooldown`);
        recordSuppressed(candidate, 'cooldown');
        continue;
      }
      if (cd && cooldownAllows) {
        console.log(
          `  override cooldown for ${candidate.line}/${candidate.direction}: worse bunch`,
        );
        cooldownOverridden = true;
      }
      const capAllows = incidents.bunchingCapAllows({
        kind: 'rail',
        route: candidate.line,
        candidate: { vehicleCount: candidate.trains.length, severityFt: candidate.spanFt },
        cap: RAIL_BUNCHING_DAILY_CAP,
      });
      if (!capAllows) {
        console.log(`  skip ${candidate.line}/${candidate.direction}: line at daily cap`);
        recordSuppressed(candidate, 'cap');
        continue;
      }
    }
    bunch = candidate;
    break;
  }

  if (!bunch) {
    console.log('All candidates filtered (cooldown/cap), nothing to post');
    return;
  }

  bunch.terminus = terminusFor(termini, bunch.line, bunch.direction);
  const line = lineGeom.get(bunch.line);
  const callouts = incidents.bunchingCallouts({
    kind: 'rail',
    route: bunch.line,
    routeLabel: lineTitle(bunch.line),
    vehicleCount: bunch.trains.length,
    severityFt: bunch.spanFt,
  });
  let image;
  try {
    image = await renderRailBunchingMap(bunch, line, {
      labels: trainLabels(bunch),
      title: `${lineTitle(bunch.line)}${bunch.direction ? ` - ${directionLabel(bunch.direction, bunch.terminus)}` : ''}`,
    });
  } catch (e) {
    console.warn(`Map render failed (${e.message}); will post text-only`);
    image = null;
  }
  const text = buildBunchingPostText(bunch, callouts);
  const alt = buildBunchingAltText(bunch);

  if (argv['dry-run']) {
    const out = image
      ? writeDryRunAsset(image, `rail-bunching-${bunch.line}-${bunch.direction}-${Date.now()}.jpg`)
      : '(render failed - text only)';
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${out}`);
    return;
  }

  const baseEvent = {
    kind: 'rail',
    route: bunch.line,
    direction: bunch.direction,
    vehicleCount: bunch.trains.length,
    severityFt: bunch.spanFt,
    nearStop: null,
  };
  const posted = await commitAndPost({
    cooldownKeys: [`rail:bunch:${bunch.line}`, `rail:bunch:${bunch.line}:${bunch.direction}`],
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
        line: bunch.line,
        direction: bunch.direction || null,
        source: 'bunching',
        severity: Math.min(1, bunch.trains.length / 4),
        detail: { trains: bunch.trains.length },
        posted: true,
      });
    },
    postWithImage,
    postText,
  });
  if (posted?.primary?.uri) {
    try {
      const videoRows = storage.getRecentRailObservationsAll(Date.now() - VIDEO_WINDOW_MS);
      const video = await captureRailBunchingHistoryVideo(bunch, line, videoRows, {
        lineGeom,
        labels: trainLabels(bunch),
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
        buildBunchingVideoPostText(video, bunch),
        video.buffer,
        buildBunchingVideoAltText(bunch),
        replyRef,
      );
      console.log(`Timelapse reply: ${reply.url}`);
    } catch (e) {
      console.warn(`Rail timelapse reply failed: ${e.message}`);
    }
  }
}

runBin(main);
