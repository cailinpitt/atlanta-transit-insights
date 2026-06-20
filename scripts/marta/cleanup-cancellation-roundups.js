#!/usr/bin/env node
// One-off cleanup for the bus cancellation-surge denominator bug.
//
// The cancellation-surge detector sized canceled trips against a SNAPSHOT count
// (activeForLine: trips in motion at :30) instead of the FLOW count (trips
// scheduled to operate over the hour). The numerator is distinct trips canceled
// over a rolling hour, so the fraction overstated reality and frequently went
// impossible ("7 of 3 scheduled trips canceled"). Every bus roundup the feature
// produced is therefore mis-sized.
//
// This retracts those incidents end to end:
//   1. deletes the Bluesky posts (the roundup anchor post + its resolution
//      reply, if any) from the alerts account, and
//   2. deletes the roundup_anchors rows so the events disappear from the website
//      (the web export surfaces every anchor with a post_uri, resolved or not),
//   3. clears the source='cancellation' meta_signals so the next roundup tick
//      can't immediately re-stand-up a bad incident from the same breadcrumbs.
//
// Run ON THE SERVER (needs the production DB + alerts Bluesky creds). Dry-run by
// default — it prints exactly what it would touch and changes nothing. Pass
// --apply to perform the deletions.
//
//   node scripts/marta/cleanup-cancellation-roundups.js            # preview
//   node scripts/marta/cleanup-cancellation-roundups.js --apply    # delete
//
// NOTE: rebuild the schedule index (scripts/marta/build-schedule-index.js)
// before the surge bin runs again, or it stays silent (scheduledForLine returns
// null until the index carries inServiceByHour) — which is the safe state.
require('../../src/shared/env');

const Path = require('node:path');
const { getDb } = require('../../src/marta/shared/incidents');
const { loginAlerts, deletePost } = require('../../src/marta/shared/bluesky');
const { markWebPushPending, flushPendingWebPush } = require('../../src/shared/webPushTrigger');

const APPLY = process.argv.includes('--apply');

function fmtEt(ts) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ts));
}

// Pull the cancellation bullet's stored counts, if present, for the preview.
function cancellationCounts(bulletsJson) {
  try {
    const bullets = bulletsJson ? JSON.parse(bulletsJson) : [];
    const b = bullets.find((x) => x?.source === 'cancellation');
    if (!b?.detail) return null;
    const { canceled, scheduled, fraction } = b.detail;
    return { canceled, scheduled, fraction };
  } catch (_e) {
    return null;
  }
}

async function main() {
  const db = getDb();

  // Every bus roundup carrying a `cancellation` signal is from the buggy feature
  // (the signal did not exist before it shipped), so all are mis-sized.
  const rows = db
    .prepare(`
      SELECT id, line, post_uri, resolution_post_uri, ts, signals, bullets
      FROM roundup_anchors
      WHERE kind = 'bus' AND signals LIKE '%cancellation%'
      ORDER BY ts DESC, id DESC
    `)
    .all();

  if (rows.length === 0) {
    console.log('No bus cancellation roundups found — nothing to clean up.');
    return;
  }

  console.log(`${APPLY ? 'DELETING' : 'DRY RUN — would delete'} ${rows.length} bus roundup(s):\n`);
  for (const r of rows) {
    const c = cancellationCounts(r.bullets);
    const counts = c
      ? `${c.canceled} of ${c.scheduled} (${Math.round((c.fraction ?? 0) * 100)}%)${
          c.canceled > c.scheduled ? '  ⚠️ impossible' : ''
        }`
      : '(no cancellation counts stored)';
    console.log(`  #${r.id} Route ${r.line} · ${fmtEt(r.ts)} · signals=[${r.signals}] · ${counts}`);
    console.log(`      post: ${r.post_uri}`);
    if (r.resolution_post_uri) console.log(`      resolution: ${r.resolution_post_uri}`);
  }

  // Count the breadcrumbs we'll clear so the preview is honest about scope.
  const sigCount = db
    .prepare(`SELECT COUNT(*) AS c FROM meta_signals WHERE source = 'cancellation'`)
    .get().c;
  console.log(`\nAlso clearing ${sigCount} 'cancellation' meta_signal breadcrumb(s).`);

  if (!APPLY) {
    console.log('\nDry run — no changes made. Re-run with --apply to delete.');
    return;
  }

  const agent = await loginAlerts();
  let postsDeleted = 0;
  for (const r of rows) {
    // Delete the resolution reply first, then the anchor post. A missing record
    // (already expired/deleted) is reported false and skipped, not fatal.
    if (r.resolution_post_uri && (await deletePost(agent, r.resolution_post_uri))) postsDeleted++;
    if (r.post_uri && (await deletePost(agent, r.post_uri))) postsDeleted++;
  }

  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM roundup_anchors WHERE id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM meta_signals WHERE source = 'cancellation'`).run();
  });
  tx();

  console.log(
    `\nDeleted ${postsDeleted} Bluesky post(s), ${rows.length} roundup row(s), ${sigCount} meta_signal(s).`,
  );

  // Re-publish the site so the retracted events drop off without waiting for the
  // next detector tick's export.
  process.env.PUSH_WEB_SCRIPT =
    process.env.PUSH_WEB_SCRIPT ||
    Path.join(__dirname, '..', '..', 'bin', 'marta', 'push-web-data.sh');
  process.env.PUSH_WEB_LOG =
    process.env.PUSH_WEB_LOG ||
    Path.join(__dirname, '..', '..', 'state', 'logs', 'push-web-data-trigger.log');
  markWebPushPending();
  flushPendingWebPush();
  console.log('Triggered web data publish.');
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
