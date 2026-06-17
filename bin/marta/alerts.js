#!/usr/bin/env node
// Republishes MARTA's official GTFS-rt ServiceAlerts to the ALERTS Bluesky
// account, and posts a threaded "resolved" reply when an alert drops out of the
// feed. MARTA analog of bin/metra/alerts.js, streamlined for Phase 6:
//   - input is native GTFS-rt (no XML quirks, no severity scoring);
//   - posts are text-only (no disruption-segment maps);
//   - the resolution reply links to the incident archive page once the original
//     post URI is known;
//   - no single-train cancellation/delay lifecycle (MARTA's are general service
//     alerts, not Metra-style annulments of one timetabled train).
// Lifecycle state lives in src/marta/alert/store.js (its own tables on the
// shared MARTA SQLite file); the significance gate + post text are in
// src/marta/alert/significance.js.
require('../../src/shared/env');

const { setup, runBin } = require('../../src/marta/shared/runBin');
const { fetchAlerts } = require('../../src/marta/alert/api');
const {
  isSignificantAlert,
  alertRelevance,
  buildAlertText,
  buildResolutionText,
} = require('../../src/marta/alert/significance');
const {
  loginAlerts,
  postText,
  postWithExternal,
  resolveReplyRef,
} = require('../../src/marta/shared/bluesky');
const { resolvedEventLink } = require('../../src/marta/shared/eventLink');
const { classifyRailCancellation } = require('../../src/marta/alert/cancellation');
const { extractAlertStations } = require('../../src/marta/alert/stations');
const {
  getAlertPost,
  recordAlertSeen,
  recordAlertResolved,
  incrementAlertClearTicks,
  resetAlertClearTicks,
  listUnresolvedAlerts,
  ALERT_CLEAR_TICKS,
} = require('../../src/marta/alert/store');

const DRY_RUN = process.env.MARTA_ALERTS_DRY_RUN === '1' || process.argv.includes('--dry-run');

// External boundaries (the feed + the Bluesky login/post/thread calls) grouped
// behind one object so the lifecycle orchestration can be exercised with
// injected fakes — the bin needs no network, login, or real posting to test.
const io = {
  fetchAlerts,
  loginAlerts,
  postText,
  postWithExternal,
  resolveReplyRef,
};

// The fields the store persists for an alert, derived from a feed entity + its
// resolved relevance (mode + affected routes).
function seenFields(alert, rel, postUri, period) {
  // Pull the canonical station names out of rail-alert prose so the web export
  // can tie the alert to its /station/:slug pages. Rail only — bus/streetcar
  // alerts don't name heavy-rail stations, and the extractor is line-scoped to
  // the rail roster.
  const stations =
    rel.mode === 'rail'
      ? extractAlertStations({
          headline: alert.header,
          description: alert.description,
          lines: rel.routes,
        })
      : { affectedFromStation: null, affectedToStation: null, mentionedStations: [] };
  return {
    alertId: alert.id,
    mode: rel.mode,
    routes: rel.routes.join(',') || null,
    headline: alert.header,
    description: alert.description || null,
    cause: alert.cause || null,
    effect: alert.effect || null,
    activeStartTs: period?.start ?? null,
    activeEndTs: period?.end ?? null,
    postUri,
    affectedFromStation: stations.affectedFromStation,
    affectedToStation: stations.affectedToStation,
    mentionedStations: stations.mentionedStations,
  };
}

// Earliest active-period start / latest end across an alert's periods (epoch s),
// for display + the store's active_start/end columns. Null when unbounded.
function periodBounds(alert) {
  const periods = alert.activePeriods || [];
  if (periods.length === 0) return null;
  const starts = periods.map((p) => p.start).filter((v) => v != null);
  const ends = periods.map((p) => p.end).filter((v) => v != null);
  return {
    start: starts.length ? Math.min(...starts) : null,
    end: ends.length ? Math.max(...ends) : null,
  };
}

async function postNewAlert(alert, rel, agentGetter, now = Date.now()) {
  const text = buildAlertText(alert, rel.mode);
  const period = periodBounds(alert);

  if (DRY_RUN) {
    console.log(
      `--- DRY RUN marta alert ${alert.id} [${rel.mode}] (DB write skipped) ---\n${text}\n`,
    );
    return;
  }

  // Pre-post write (postUri:null) so a crash between posting and the post-post
  // write is still detectable — mirrors the CTA/Metra invariant.
  recordAlertSeen(seenFields(alert, rel, null, period), now);

  const agent = await agentGetter();
  const result = await io.postText(agent, text);
  console.log(`Posted marta alert ${alert.id}: ${result.url}`);
  recordAlertSeen(seenFields(alert, rel, result.uri, period), now);
}

// A stored alert row that names a single cancelled rail departure. The website
// models these as terminal cancellations, not ongoing→resolved disruptions — so
// when one drops from the feed we close it SILENTLY (no "✅ resolved" reply): a
// cancelled train doesn't get "resolved".
function rowIsRailCancellation(row) {
  if (row.mode !== 'rail') return false;
  const line = (row.routes || '').split(',')[0]?.trim() || null;
  return (
    classifyRailCancellation({
      headline: row.headline,
      description: row.description,
      line,
      anchorTs: row.first_seen_ts,
    }) != null
  );
}

async function postResolution(alertRow, agentGetter) {
  // Cancellation events are terminal; don't post a misleading resolution reply.
  if (rowIsRailCancellation(alertRow)) {
    if (DRY_RUN) {
      console.log(
        `--- DRY RUN would silently close cancellation alert ${alertRow.alert_id} (no resolution reply) ---`,
      );
      return;
    }
    recordAlertResolved({ alertId: alertRow.alert_id, replyUri: null });
    console.log(`Marta cancellation alert ${alertRow.alert_id} silently closed (no reply)`);
    return;
  }

  const link = resolvedEventLink(alertRow.post_uri, alertRow.headline || 'MARTA alert resolved');
  const baseText = buildResolutionText(alertRow.headline);
  const text = link ? `${baseText}\n\n${link.url}` : baseText;

  if (DRY_RUN) {
    console.log(
      `--- DRY RUN marta resolution for alert ${alertRow.alert_id} (DB write skipped) ---\n${text}`,
    );
    return;
  }

  // No post to reply to (a resolution swept in before any post landed): just
  // record the resolution so the row leaves the unresolved set.
  if (!alertRow.post_uri) {
    recordAlertResolved({ alertId: alertRow.alert_id, replyUri: null });
    return;
  }

  const agent = await agentGetter();
  try {
    const replyRef = await io.resolveReplyRef(agent, alertRow.post_uri);
    if (!replyRef) throw new Error('could not resolve reply ref for alert post');
    const result = link
      ? await io.postWithExternal(agent, text, link, replyRef)
      : await io.postText(agent, text, replyRef);
    console.log(`Posted marta resolution for alert ${alertRow.alert_id}: ${result.url}`);
    recordAlertResolved({ alertId: alertRow.alert_id, replyUri: result.uri });
  } catch (e) {
    console.warn(`Marta resolution reply failed for alert ${alertRow.alert_id}: ${e.message}`);
    recordAlertResolved({ alertId: alertRow.alert_id, replyUri: null });
  }
}

async function main({ now = Date.now() } = {}) {
  setup();
  const { alerts } = await io.fetchAlerts();
  const relevant = alerts.filter(isSignificantAlert);
  const significantIds = new Set(relevant.map((a) => a.id));
  // Everything in the feed regardless of our gate — lets the resolution sweep
  // tell "MARTA cleared it" (post a resolution) from "we filtered it out"
  // (silent close).
  const feedIds = new Set(alerts.map((a) => a.id));

  console.log(`Fetched ${alerts.length} MARTA alerts, ${relevant.length} significant`);

  let agent = null;
  const agentGetter = async () => {
    if (!agent) agent = await io.loginAlerts();
    return agent;
  };

  for (const alert of relevant) {
    const rel = alertRelevance(alert);
    const existing = getAlertPost(alert.id);
    if (existing?.post_uri) {
      // Already posted — refresh last_seen (and backfill any newly-derived
      // fields) so the resolution sweep doesn't think it dropped out. postUri:
      // null preserves the stored URI via COALESCE.
      if (!DRY_RUN) {
        recordAlertSeen(seenFields(alert, rel, null, periodBounds(alert)), now);
      }
      continue;
    }
    try {
      await postNewAlert(alert, rel, agentGetter, now);
    } catch (e) {
      console.error(`Failed to post marta alert ${alert.id}: ${e.stack || e.message}`);
    }
  }

  // Feed flicker guard: the MARTA feed occasionally returns empty; don't treat
  // that as "everything resolved at once".
  if (alerts.length === 0) {
    console.warn('MARTA returned 0 alerts — skipping resolution sweep this tick');
    return;
  }

  for (const row of listUnresolvedAlerts()) {
    if (significantIds.has(row.alert_id)) {
      if (!DRY_RUN && row.clear_ticks > 0) resetAlertClearTicks(row.alert_id);
      continue;
    }
    // Still in the feed but no longer passes the gate — close silently (no
    // misleading "resolved" reply); the original post stays.
    if (feedIds.has(row.alert_id)) {
      if (DRY_RUN) {
        console.log(
          `--- DRY RUN would silently close marta alert ${row.alert_id} (still in feed, filtered) ---`,
        );
        continue;
      }
      console.log(
        `Marta alert ${row.alert_id} silently closed — still in feed but no longer significant`,
      );
      recordAlertResolved({ alertId: row.alert_id, replyUri: null });
      continue;
    }
    if (DRY_RUN) {
      console.log(`--- DRY RUN would advance clear_ticks for marta alert ${row.alert_id} ---`);
      continue;
    }
    const next = incrementAlertClearTicks(row.alert_id, now);
    if (next < ALERT_CLEAR_TICKS) {
      console.log(`Marta alert ${row.alert_id} missing tick ${next}/${ALERT_CLEAR_TICKS}`);
      continue;
    }
    try {
      await postResolution(row, agentGetter);
    } catch (e) {
      console.error(`Failed marta resolution for alert ${row.alert_id}: ${e.stack || e.message}`);
    }
  }
}

if (require.main === module) {
  runBin(main);
}

module.exports = { main, io };
