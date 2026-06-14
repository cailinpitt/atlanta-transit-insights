#!/usr/bin/env node
require('../../../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));

const { loadGtfs } = require('../../../src/marta/gtfs');
const { loadShapes } = require('../../../src/marta/bus/shapes');
const { buildLineGeometry } = require('../../../src/marta/rail/lines');
const {
  railGapsFromObservations,
  RATIO_THRESHOLD,
  ABSOLUTE_MIN_MIN,
} = require('../../../src/marta/rail/gaps');
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
const { renderRailGapMap } = require('../../../src/marta/map/railIncidents');
const {
  lineTitle,
  directionLabel,
  buildGapPostText,
  buildGapAltText,
  buildGapVideoPostText,
  buildGapVideoAltText,
} = require('../../../src/marta/rail/post');
const { VIDEO_WINDOW_MS, captureRailGapHistoryVideo } = require('../../../src/marta/rail/video');

const GTFS_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'marta', 'gtfs');
const WINDOW_MS = 3 * 60 * 1000;
const RAIL_GAP_DAILY_CAP = 3;

function recordSuppressed(gap, suppressed) {
  incidents.recordGap({
    kind: 'rail',
    route: gap.line,
    direction: gap.direction,
    gapFt: gap.gapFt,
    gapMin: gap.gapMin,
    expectedMin: gap.expectedMin,
    ratio: gap.ratio,
    nearStop: null,
    posted: false,
  });
  incidents.recordMetaSignal({
    kind: 'rail',
    line: gap.line,
    direction: gap.direction || null,
    source: 'gap',
    severity: Math.min(1, gap.ratio / 4),
    detail: { ratio: gap.ratio, gapMin: gap.gapMin, suppressed },
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

  const gaps = railGapsFromObservations(rows, { lineGeom, now });
  if (gaps.length === 0) {
    console.log('No significant rail gaps detected');
    return;
  }
  console.log(`Found ${gaps.length} candidate rail gap(s)`);

  let gap = null;
  let cooldownOverridden = false;
  for (const candidate of gaps) {
    if (!argv['dry-run']) {
      const lineKey = `rail:gap:${candidate.line}`;
      const dirKey = `rail:gap:${candidate.line}:${candidate.direction}`;
      const cd = isOnCooldown(lineKey) || isOnCooldown(dirKey);
      const cooldownAllows = incidents.gapCooldownAllows({
        kind: 'rail',
        route: candidate.line,
        candidate: { ratio: candidate.ratio },
      });
      if (cd && !cooldownAllows) {
        console.log(`  skip ${candidate.line}/${candidate.direction}: on cooldown`);
        recordSuppressed(candidate, 'cooldown');
        continue;
      }
      if (cd && cooldownAllows) {
        console.log(`  override cooldown for ${candidate.line}/${candidate.direction}: worse gap`);
        cooldownOverridden = true;
      }
      const capAllows = incidents.gapCapAllows({
        kind: 'rail',
        route: candidate.line,
        candidate: { ratio: candidate.ratio },
        cap: RAIL_GAP_DAILY_CAP,
      });
      if (!capAllows) {
        console.log(`  skip ${candidate.line}/${candidate.direction}: line at daily cap`);
        recordSuppressed(candidate, 'cap');
        continue;
      }
    }
    gap = candidate;
    break;
  }

  if (!gap) {
    console.log('All candidates filtered (cooldown/cap), nothing to post');
    return;
  }
  if (gap.gapMin < ABSOLUTE_MIN_MIN || gap.ratio < RATIO_THRESHOLD) return;

  const line = lineGeom.get(gap.line);
  const callouts = incidents.gapCallouts({
    kind: 'rail',
    route: gap.line,
    routeLabel: lineTitle(gap.line),
    ratio: gap.ratio,
  });
  let image;
  try {
    image = await renderRailGapMap(gap, line, {
      title: `${lineTitle(gap.line)}${gap.direction ? ` - ${directionLabel(gap.direction)}` : ''}`,
    });
  } catch (e) {
    console.warn(`Map render failed (${e.message}); will post text-only`);
    image = null;
  }
  const text = buildGapPostText(gap, callouts);
  const alt = buildGapAltText(gap);

  if (argv['dry-run']) {
    const out = image
      ? writeDryRunAsset(image, `rail-gap-${gap.line}-${gap.direction}-${Date.now()}.jpg`)
      : '(render failed - text only)';
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${out}`);
    return;
  }

  const baseEvent = {
    kind: 'rail',
    route: gap.line,
    direction: gap.direction,
    gapFt: gap.gapFt,
    gapMin: gap.gapMin,
    expectedMin: gap.expectedMin,
    ratio: gap.ratio,
    nearStop: null,
  };
  const posted = await commitAndPost({
    cooldownKeys: [`rail:gap:${gap.line}`, `rail:gap:${gap.line}:${gap.direction}`],
    forceClearCooldown: cooldownOverridden,
    recordSkip: () => incidents.recordGap({ ...baseEvent, posted: false }),
    agentLogin: loginTrain,
    image,
    text,
    alt,
    recordPosted: (primary) => {
      incidents.recordGap({ ...baseEvent, posted: true, postUri: primary.uri });
      incidents.recordMetaSignal({
        kind: 'rail',
        line: gap.line,
        direction: gap.direction || null,
        source: 'gap',
        severity: Math.min(1, gap.ratio / 4),
        detail: { ratio: gap.ratio, gapMin: gap.gapMin },
        posted: true,
      });
    },
    postWithImage,
    postText,
  });
  if (posted?.primary?.uri) {
    try {
      const videoRows = storage.getRecentRailObservationsAll(Date.now() - VIDEO_WINDOW_MS);
      const video = await captureRailGapHistoryVideo(gap, line, videoRows, { lineGeom });
      if (!video) {
        console.log('Rail gap timelapse history produced <2 frames, skipping reply');
        return;
      }
      const replyRef = {
        root: { uri: posted.primary.uri, cid: posted.primary.cid },
        parent: { uri: posted.primary.uri, cid: posted.primary.cid },
      };
      const reply = await postWithVideo(
        posted.agent,
        buildGapVideoPostText(video, gap),
        video.buffer,
        buildGapVideoAltText(gap),
        replyRef,
      );
      console.log(`Timelapse reply: ${reply.url}`);
    } catch (e) {
      console.warn(`Rail gap timelapse reply failed: ${e.message}`);
    }
  }
}

runBin(main);
