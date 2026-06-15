#!/usr/bin/env node
require('../../../src/shared/env');

const Path = require('node:path');
const argv = require('minimist')(process.argv.slice(2));

const { loadGtfs } = require('../../../src/marta/gtfs');
const { loadShapes } = require('../../../src/marta/bus/shapes');
const { buildLineGeometry } = require('../../../src/marta/rail/lines');
const { captureRailSystemTimelapse } = require('../../../src/marta/rail/snapshotVideo');
const storage = require('../../../src/marta/storage');
const { loginTrain, postWithVideo } = require('../../../src/marta/shared/bluesky');
const { setup, writeDryRunAsset, runBin } = require('../../../src/marta/shared/runBin');
const { buildTimelapsePostText, buildTimelapseAltText } = require('../../../src/marta/rail/post');

const GTFS_DIR = Path.join(__dirname, '..', '..', '..', 'data', 'marta', 'gtfs');
const DEFAULT_WINDOW_MIN = 60;

async function main() {
  setup();
  const gtfs = loadGtfs(GTFS_DIR);
  const shapes = loadShapes(GTFS_DIR);
  const lineGeom = buildLineGeometry(gtfs, shapes);

  const windowMin = argv['window-min'] ? parseInt(argv['window-min'], 10) : DEFAULT_WINDOW_MIN;
  const interpolate = argv.interpolate ? parseInt(argv.interpolate, 10) : undefined;
  const now = Date.now();
  const rows = storage.getRecentRailObservationsAll(now - windowMin * 60 * 1000);
  if (rows.length === 0) {
    console.log('No recent rail observations in the window - is observe-rail running?');
    return;
  }

  const result = await captureRailSystemTimelapse(rows, lineGeom, { interpolate });
  if (!result) {
    console.log('System timelapse produced <2 frames, nothing to post');
    return;
  }
  const text = buildTimelapsePostText(result);
  const alt = buildTimelapseAltText(result);
  console.log(
    `Captured ${result.frameCount} frames over ${result.elapsedSec}s ` +
      `(${(result.buffer.length / 1024 / 1024).toFixed(1)} MB)`,
  );

  if (argv['dry-run']) {
    const out = writeDryRunAsset(result.buffer, `rail-timelapse-${Date.now()}.mp4`);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nVideo: ${out}`);
    return;
  }

  const agent = await loginTrain();
  const post = await postWithVideo(agent, text, result.buffer, alt);
  console.log(`Posted: ${post.url}`);
}

runBin(main);
