#!/usr/bin/env node
// Metra recap — weekly/monthly on-time digest posted to @metrainsights
// (loginMetra, the analytics account). The Metra sibling of bin/train/recap.js.
//
// Unlike the train recap (a bunching heatmap + gap-chart reply), Metra's
// rider-facing story is schedule adherence, so this posts a per-line on-time
// reliability chart with a short text summary:
//   reliability = (scheduled − disrupted) / scheduled
//   disrupted   = cancelled (confirmed or inferred) + ran 15+ min late
// Both numerator inputs come from disruption_events (kind='metra', 90-day
// rolloff — covers week AND month); the scheduled-trip denominator is counted
// from the static GTFS index (trips whose service_id is active each day in the
// window). The detector (src/metra/recap.js) is pure; this bin wires it to the
// DB, the index, the renderer, and Bluesky.
//
// Cadence: weekly + monthly, mirroring bus-/train-recap (see cron/crontab.txt).

require('../../src/shared/env');

const Path = require('node:path');
const Fs = require('node:fs');

const argv = require('minimist')(process.argv.slice(2));

const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');
const { rangeForWindow } = require('../../src/shared/recap');
const { getMetraDisruptions } = require('../../src/shared/history');
const { activeServiceIds, chicagoDateStr } = require('../../src/metra/schedule');
const { LINE_COLORS } = require('../../src/metra/lines');
const { buildRecap, chartEntries, buildPostText, buildAltText } = require('../../src/metra/recap');
const { renderRecapChart } = require('../../src/map/metra/recapChart');
const { loginMetra, postWithImage } = require('../../src/metra/bluesky');

const DRY_RUN = process.env.METRA_DRY_RUN === '1' || argv['dry-run'];
const HALF_DAY_MS = 12 * 60 * 60 * 1000;

function loadIndex() {
  try {
    const p = Path.join(__dirname, '..', '..', 'data', 'metra-gtfs', 'index.json');
    return JSON.parse(Fs.readFileSync(p, 'utf8'));
  } catch (_e) {
    return null;
  }
}

// Scheduled trip count per line across every service day in [since, until). Steps
// every 12h with a date-string dedup so a DST-short day is never skipped and a
// DST-long day is never double-counted. Uses the CURRENT static schedule as the
// baseline — Metra timetables change rarely, so it's a sound denominator for a
// recent week/month.
function scheduledCountsByLine(index, since, until) {
  const counts = {};
  const seen = new Set();
  for (let ms = since; ms < until; ms += HALF_DAY_MS) {
    const dateStr = chicagoDateStr(ms);
    if (seen.has(dateStr)) continue;
    seen.add(dateStr);
    const active = activeServiceIds(index, dateStr);
    for (const trip of Object.values(index.trips || {})) {
      if (!active.has(trip.service_id)) continue;
      counts[trip.route_id] = (counts[trip.route_id] || 0) + 1;
    }
  }
  return counts;
}

async function main() {
  setup();
  const window = argv.window || 'month';
  if (window !== 'week' && window !== 'month') {
    console.error(`Unknown --window: ${window}. Use week or month.`);
    process.exit(1);
  }

  const index = loadIndex();
  if (!index) {
    console.error('metra recap: schedule index missing — run fetch-metra-gtfs first');
    return;
  }

  const { since, until, label: windowLabel } = rangeForWindow(window);
  console.log(`Metra recap, ${window} (${windowLabel})`);

  const events = getMetraDisruptions(since, until);
  const scheduledByLine = scheduledCountsByLine(index, since, until);
  const recap = buildRecap({ events, scheduledByLine });

  const { systemwide } = recap;
  console.log(
    `  ${systemwide.scheduled} scheduled trips · ${systemwide.cancelled} cancelled · ${systemwide.delayed} delayed (≥15min) → ${systemwide.reliabilityPct}% on-time`,
  );
  for (const r of chartEntries(recap).slice(0, 5)) {
    console.log(
      `  ${r.reliabilityPct}% ${r.line} (sched ${r.scheduled}, disrupted ${r.disrupted})`,
    );
  }

  if (systemwide.scheduled === 0) {
    console.log('No Metra schedule data for this window — nothing to post.');
    return;
  }

  const entries = chartEntries(recap);
  const image = await renderRecapChart({ entries, window, windowLabel, lineColors: LINE_COLORS });
  const text = buildPostText({ recap, windowLabel });
  const alt = buildAltText({ recap, windowLabel });

  if (DRY_RUN) {
    const outPath = writeDryRunAsset(image, `metra-recap-${window}-${Date.now()}.jpg`);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    return;
  }

  const agent = await loginMetra();
  const result = await postWithImage(agent, text, image, alt);
  console.log(`Posted metra recap: ${result.url}`);
}

if (require.main === module) {
  runBin(main);
}

module.exports = { scheduledCountsByLine };
