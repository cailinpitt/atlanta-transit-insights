#!/usr/bin/env node
// MARTA bus cancellation rollup → @martaalertinsights. Hourly per-route digest
// of GTFS-rt TripUpdates CANCELED trips seen in the last window — the same
// structured source the ghost detector subtracts, so the alerts-account total
// and the insights-account ghost context can't contradict each other. Mirrors
// the Metra cancellation rollup: website-/feed-data-first, ONE fire-and-forget
// digest, no per-incident thread/clear machinery. Silent when nothing's new.
//
// Why not the OTP "cancellation-alert" notices? They're a different measurement
// (whole-day announced vs. live-annulled) and are dropped in src/marta/alert/otp.js.
// See src/marta/bus/cancellations.js for the full rationale.
require('../../../src/shared/env');

const { setup, runBin } = require('../../../src/marta/shared/runBin');
const storage = require('../../../src/marta/storage');
const {
  extractCanceledTrips,
  filterScheduledInTrailingHour,
  summarizeByRoute,
  buildCancellationDigest,
} = require('../../../src/marta/bus/cancellations');
const {
  recordCanceledTrips,
  getUnreportedCanceledTrips,
  markCanceledReported,
  pruneOldCancellations,
} = require('../../../src/marta/bus/cancellationStore');
const { loginAlerts, postText } = require('../../../src/marta/shared/bluesky');

const DRY_RUN = process.env.MARTA_ALERTS_DRY_RUN === '1' || process.argv.includes('--dry-run');

// Read a little over the hourly cadence so a late cron tick can't drop a
// cancellation between runs; the ledger makes the overlap idempotent.
const WINDOW_MS = 90 * 60 * 1000;

// Boundaries behind one object so the lifecycle is testable with injected fakes.
const io = { loginAlerts, postText };

async function main({ now = Date.now() } = {}) {
  setup();

  // 1. Distinct canceled trips currently in the read window, restricted to those
  //    SCHEDULED to depart in the trailing hour. MARTA lists the whole remaining
  //    day's CANCELED trips in every snapshot, so without this the digest would
  //    dump the entire day under a "past hour" header on the batch-arrival tick;
  //    the filter drips each cancellation out in its scheduled hour instead, and
  //    the ledger still posts each exactly once. See cancellations.js.
  const statuses = storage.getRecentBusTripStatuses(now - WINDOW_MS);
  const canceled = filterScheduledInTrailingHour(extractCanceledTrips(statuses), new Date(now));

  if (DRY_RUN) {
    const summary = summarizeByRoute(canceled);
    const text = buildCancellationDigest(summary);
    console.log(
      `--- DRY RUN marta bus cancellations (DB writes skipped) ---\n` +
        `${canceled.length} canceled trips in window across ${summary.routeCount} routes\n` +
        `${text || '(nothing to post)'}`,
    );
    return;
  }

  // 2. Ledger the window's cancellations (idempotent); the not-yet-reported set
  //    is what this digest covers.
  recordCanceledTrips(canceled, now);
  pruneOldCancellations(now);
  const unreported = getUnreportedCanceledTrips();
  if (unreported.length === 0) {
    console.log('No new MARTA bus cancellations to report this run');
    return;
  }

  // 3. One digest of the new cancellations, then mark them reported.
  const summary = summarizeByRoute(unreported);
  const text = buildCancellationDigest(summary);
  if (!text) {
    markCanceledReported(unreported, now);
    return;
  }
  const agent = await io.loginAlerts();
  const result = await io.postText(agent, text);
  console.log(
    `Posted MARTA bus cancellation rollup (${summary.totalTrips} trips, ${summary.routeCount} routes): ${result.url}`,
  );
  markCanceledReported(unreported, now);
}

if (require.main === module) {
  runBin(main);
}

module.exports = { main, io };
