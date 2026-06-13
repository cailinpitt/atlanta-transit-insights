#!/usr/bin/env node
// Secondary backfill for alert_posts.short_description, used when CTA's
// activeonly=false feed no longer carries the alert (it expires resolved
// alerts within hours). For each row with NULL short_description but a
// non-NULL post_uri, fetch the bot's own Bluesky post and parse the body
// back out of the post text.
//
// The post text shape (see src/shared/alertPost.js buildAlertPostText):
//   {prefix} {headline}\n
//   \n
//   {body, truncated to 200 chars at sentence boundary if needed}\n
//   \n
//   Per CTA. Check transitchicago.com for updates.
//
// Very long alerts collapse to "{prefix} {head}\n\nPer CTA. transitchicago.com"
// (no body); for those we can't recover anything and leave the row alone.
//
// The recovered body is truncated (≤200 chars) — that's a known limitation,
// but it's strictly better than the headline-only view.

require('../src/shared/env');

const { loginAlerts, getPostRecord } = require('../src/shared/bluesky');
const { getDb } = require('../src/shared/history');
const { runBin } = require('../src/shared/runBin');

const FOOTER_FULL = 'Per CTA. Check transitchicago.com for updates.';
const FOOTER_SHORT = 'Per CTA. transitchicago.com';

function extractBody(text) {
  if (!text) return null;
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length < 3) return null;
  const last = paragraphs[paragraphs.length - 1];
  if (last !== FOOTER_FULL && last !== FOOTER_SHORT) return null;
  // Body is everything between the headline (first paragraph) and the footer
  // (last). Re-join with a blank line in case the body itself was multi-
  // paragraph — preserves the same whitespace-pre-line shape the event page
  // expects.
  const body = paragraphs.slice(1, -1).join('\n\n').trim();
  return body || null;
}

async function main() {
  const db = getDb();
  const missing = db
    .prepare(`
      SELECT alert_id, kind, post_uri, headline
      FROM alert_posts
      WHERE short_description IS NULL AND post_uri IS NOT NULL
      ORDER BY first_seen_ts DESC
    `)
    .all();

  if (missing.length === 0) {
    console.log('backfill-from-bluesky: nothing to do');
    return;
  }

  console.log(`backfill-from-bluesky: ${missing.length} candidate rows with post_uri`);

  const agent = await loginAlerts();
  const update = db.prepare(
    'UPDATE alert_posts SET short_description = ? WHERE alert_id = ? AND short_description IS NULL',
  );

  let filled = 0;
  let noPost = 0;
  let noBody = 0;

  for (const row of missing) {
    const record = await getPostRecord(agent, row.post_uri);
    if (!record) {
      noPost += 1;
      continue;
    }
    const body = extractBody(record.value?.text);
    if (!body) {
      noBody += 1;
      continue;
    }
    update.run(body, row.alert_id);
    filled += 1;
    console.log(`  filled ${row.alert_id} (${row.kind}): ${body.slice(0, 80)}`);
  }

  console.log(
    `backfill-from-bluesky: filled=${filled}, post-missing=${noPost}, no-body-in-post=${noBody}`,
  );
}

runBin(main);
