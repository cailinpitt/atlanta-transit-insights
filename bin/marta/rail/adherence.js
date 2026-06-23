#!/usr/bin/env node
// Rail adherence rollup (martatraininsights). A "MARTA rail running late" digest
// from the feed's signed DELAY field — posts the lines whose trains are materially
// behind schedule right now, with a clear-reply-free cooldown so it self-limits.
// Silent on a normal on-time day. Descriptive: minutes late, no grade.
require('../../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const storage = require('../../../src/marta/storage');
const {
  summarizeLineAdherence,
  delayLabel,
  LATE_THRESHOLD_SEC,
} = require('../../../src/marta/rail/adherence');
const { acquireCooldown } = require('../../../src/marta/shared/state');
const { loginTrain, postText } = require('../../../src/marta/shared/bluesky');
const { setup, runBin } = require('../../../src/marta/shared/runBin');
const { buildRollupThread } = require('../../../src/shared/post');
const { lineTitle } = require('../../../src/marta/rail/post');

const WINDOW_MS = 30 * 60 * 1000;
// A line makes the digest when its trains are materially behind: a median past
// MIN_MEDIAN_SEC, or at least MIN_LATE_TRAINS trains late past LATE_THRESHOLD_SEC.
// Needs MIN_TRAINS to trust the median (a line with 1-2 trains in service isn't a
// pattern). Tuned so a normal on-time day posts nothing.
const MIN_TRAINS = 3;
const MIN_MEDIAN_SEC = 180;
const MIN_LATE_TRAINS = 2;
const COOLDOWN_MS = 60 * 60 * 1000;

function qualifies(rec) {
  if (rec.trains < MIN_TRAINS) return false;
  return rec.medianDelaySec >= MIN_MEDIAN_SEC || rec.lateCount >= MIN_LATE_TRAINS;
}

function formatLine(rec) {
  const peak = `peak ${delayLabel(rec.maxDelaySec)}`;
  const late =
    rec.lateCount > 0
      ? ` · ${rec.lateCount} train${rec.lateCount === 1 ? '' : 's'} 5+ min late`
      : '';
  return `${lineTitle(rec.line)} · ~${delayLabel(rec.medianDelaySec)} (median) · ${peak}${late}`;
}

async function main() {
  setup();
  const now = Date.now();
  const rows = storage.getRecentRailObservationsAll(now - WINDOW_MS);
  if (rows.length === 0) {
    console.log('No recent rail observations in the window - is observe-rail running?');
    return;
  }

  const qualifying = summarizeLineAdherence(rows).filter(qualifies);
  if (qualifying.length === 0) {
    console.log('No rail line is materially behind schedule, staying silent');
    return;
  }

  const lines = qualifying.map(formatLine);
  const posts = buildRollupThread('🕒 MARTA rail running late, past ~30 min', lines, {
    footer: 'From MARTA’s reported train delays. On-time days stay quiet.',
  });
  if (!posts || posts.length === 0) {
    console.log('No lines fit under the post limit, skipping');
    return;
  }

  if (argv['dry-run']) {
    for (let i = 0; i < posts.length; i++) {
      console.log(`\n--- DRY RUN post ${i + 1}/${posts.length} ---\n${posts[i].text}`);
    }
    return;
  }

  if (!acquireCooldown('adherence_rollup_rail', now, COOLDOWN_MS)) {
    console.log('rail-adherence: cooldown active, skipping');
    return;
  }

  const agent = await loginTrain();
  let root = null;
  let parent = null;
  for (let i = 0; i < posts.length; i++) {
    const replyRef = root && parent ? { root, parent } : null;
    const result = await postText(agent, posts[i].text, replyRef);
    console.log(`Posted ${i + 1}/${posts.length}: ${result.url}`);
    if (!root) root = { uri: result.uri, cid: result.cid };
    parent = { uri: result.uri, cid: result.cid };
  }
}

module.exports = { qualifies, formatLine, MIN_MEDIAN_SEC, LATE_THRESHOLD_SEC };

if (require.main === module) runBin(main);
