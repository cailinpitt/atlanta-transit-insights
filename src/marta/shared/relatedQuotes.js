// Quote-attaches the insight bots' detector observations (bunching/gap/ghost
// posts) into the ALERTS account's own alert/roundup threads, so an official
// MARTA alert or a multi-signal roundup carries the live evidence underneath it
// as "🕵 Related observation" quote-replies. MARTA analog of cta-insights
// src/shared/relatedQuotes.js, simplified to MARTA's data model:
//
//   - Anchors are official alerts (`alert_posts`, resolved_ts NULL + post_uri)
//     and active roundup anchors (`roundup_anchors`). MARTA has no pulse/held
//     detectors, so those CTA anchor types don't exist here.
//   - Relevance is route/line + mode equality (CTA's bar for roundup anchors).
//     MARTA doesn't carry the bus-pattern / train-segment geometry CTA uses to
//     additionally segment-match official-alert anchors, so all anchors use the
//     route-only bar: a same-line observation inside the lead window attaches.
//
// Both insight kinds are swept ('bus' → @martabusinsights, 'rail' →
// @martatraininsights, including the SC streetcar line); every quote is authored
// by the ALERTS account so the thread stays on one profile.

const { listUnresolvedAlerts } = require('../alert/store');
const {
  listActiveRoundupAnchors,
  findRelatedAnalyticsPosts,
  recordThreadQuote,
  getThreadQuotedSourceUris,
  getLatestThreadQuote,
} = require('./incidents');
const { getPostRecord, postQuote } = require('./bluesky');

const LEAD_MS = 30 * 60 * 1000;
const MAX_QUOTES_PER_THREAD = 3;
const QUOTE_TEXT = '🕵 Related observation';

function isEnabled() {
  return process.env.QUOTE_RELATED_POSTS !== '0';
}

// Official-alert mode → insight kind. Streetcar gaps/bunches/ghosts/speedmaps run
// under the rail detector kind (the SC line lives in the rail rotation), so a
// streetcar alert anchors against rail observations. 'general' alerts aren't
// scoped to a route, so they never anchor.
function alertKind(mode) {
  if (mode === 'bus') return 'bus';
  if (mode === 'rail' || mode === 'streetcar') return 'rail';
  return null;
}

function splitRoutes(routes) {
  return String(routes || '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
}

// Collect every anchor for `kind`, resolve each to its thread root, and merge
// anchors that share a root into one work item: routes unioned, lead window from
// the earliest anchor, the cap-of-3 applied once per thread root.
async function buildWorkItems({ kind, agent, now }) {
  const anchors = [];

  for (const a of listUnresolvedAlerts()) {
    if (!a.post_uri) continue;
    if (alertKind(a.mode) !== kind) continue;
    anchors.push({ postUri: a.post_uri, routes: splitRoutes(a.routes), ts: a.first_seen_ts });
  }

  // Roundup anchors assert "this whole route/line is degraded", so route equality
  // is the right bar (same as the alert anchors here).
  for (const a of listActiveRoundupAnchors(kind, now)) {
    anchors.push({ postUri: a.post_uri, routes: [a.line], ts: a.ts || now });
  }

  const groups = new Map();
  for (const anchor of anchors) {
    if (!anchor.postUri) continue;
    const rec = await getPostRecord(agent, anchor.postUri);
    if (!rec) continue;
    const rootUri = rec.value?.reply?.root?.uri || anchor.postUri;
    const rootCid = rec.value?.reply?.root?.cid || rec.cid;
    let g = groups.get(rootUri);
    if (!g) {
      g = {
        kind,
        rootUri,
        rootCid,
        latestPostUri: anchor.postUri,
        latestPostCid: rec.cid,
        latestTs: anchor.ts || 0,
        routes: new Set(),
        earliestTs: anchor.ts || now,
      };
      groups.set(rootUri, g);
    }
    for (const r of anchor.routes) if (r) g.routes.add(String(r));
    if (anchor.ts && anchor.ts < g.earliestTs) g.earliestTs = anchor.ts;
    if ((anchor.ts || 0) > g.latestTs) {
      g.latestTs = anchor.ts || 0;
      g.latestPostUri = anchor.postUri;
      g.latestPostCid = rec.cid;
    }
  }

  // Re-anchor each group's tail to the most recent quote we've already authored
  // in the thread, so the next quote chains onto it (linear thread, no branch).
  for (const g of groups.values()) {
    const last = getLatestThreadQuote(g.rootUri);
    if (last) {
      g.latestPostUri = last.uri;
      g.latestPostCid = last.cid;
    }
  }
  return [...groups.values()];
}

async function processGroup({ group, kind, agent, dryRun, now }) {
  const alreadyQuoted = getThreadQuotedSourceUris(group.rootUri);
  if (alreadyQuoted.size >= MAX_QUOTES_PER_THREAD) return 0;

  const sinceTs = (group.earliestTs || now) - LEAD_MS;
  const candidates = findRelatedAnalyticsPosts({
    kind,
    routes: [...group.routes],
    sinceTs,
    untilTs: now,
    excludeSourceUris: alreadyQuoted,
  });
  if (candidates.length === 0) return 0;

  let posted = 0;
  const remaining = MAX_QUOTES_PER_THREAD - alreadyQuoted.size;
  // Duplicate event rows (e.g. a ghost rollup written once per route) can name
  // the same post_uri; only quote each underlying post once per tick.
  const postedThisTick = new Set();
  for (const cand of candidates) {
    if (posted >= remaining) break;
    if (postedThisTick.has(cand.post_uri)) continue;

    const sourceRec = await getPostRecord(agent, cand.post_uri);
    if (!sourceRec) {
      // Source post is gone — tombstone it so we don't re-check every tick.
      if (!dryRun) {
        recordThreadQuote({
          threadRootUri: group.rootUri,
          sourcePostUri: cand.post_uri,
          quotePostUri: null,
        });
      }
      continue;
    }

    const replyRef = {
      root: { uri: group.rootUri, cid: group.rootCid },
      parent: { uri: group.latestPostUri, cid: group.latestPostCid },
    };

    if (dryRun) {
      console.log(
        `--- DRY RUN quote-attach (${kind} ${cand.source}) ${cand.post_uri} → thread ${group.rootUri} ---`,
      );
      posted++;
      postedThisTick.add(cand.post_uri);
      continue;
    }

    try {
      const result = await postQuote(
        agent,
        QUOTE_TEXT,
        { uri: sourceRec.uri, cid: sourceRec.cid },
        replyRef,
      );
      console.log(
        `Quote-attached ${cand.source} ${cand.post_uri} → thread ${group.rootUri}: ${result.url}`,
      );
      recordThreadQuote({
        threadRootUri: group.rootUri,
        sourcePostUri: cand.post_uri,
        quotePostUri: result.uri,
        quotePostCid: result.cid,
      });
      postedThisTick.add(cand.post_uri);
      // This quote replied to the prior tail; it's now the tail for the next one.
      group.latestPostUri = result.uri;
      group.latestPostCid = result.cid;
      posted++;
    } catch (e) {
      console.warn(`postQuote failed for ${cand.post_uri}: ${e.stack || e.message}`);
    }
  }
  return posted;
}

// Cheap DB-only count of anchors that could attract quotes, to short-circuit
// before spending a Bluesky session on getRecord calls on quiet ticks.
function countCandidateAnchors(kind, now) {
  let n = 0;
  for (const a of listUnresolvedAlerts()) {
    if (a.post_uri && alertKind(a.mode) === kind) n++;
  }
  for (const _ of listActiveRoundupAnchors(kind, now)) n++;
  return n;
}

async function sweepRelatedQuotes({ kind, agent, agentGetter, dryRun = false, now = Date.now() }) {
  if (!isEnabled()) {
    console.log(`[${kind}/related-quotes] disabled via QUOTE_RELATED_POSTS=0`);
    return { groups: 0, posted: 0 };
  }
  if (countCandidateAnchors(kind, now) === 0) {
    console.log(`[${kind}/related-quotes] 0 anchor(s) — skipping`);
    return { groups: 0, posted: 0 };
  }
  const liveAgent = agent || (agentGetter ? await agentGetter() : null);
  if (!liveAgent) throw new Error('sweepRelatedQuotes: agent or agentGetter required');
  const groups = await buildWorkItems({ kind, agent: liveAgent, now });
  let posted = 0;
  for (const g of groups) {
    try {
      posted += await processGroup({ group: g, kind, agent: liveAgent, dryRun, now });
    } catch (e) {
      console.warn(`related-quotes group ${g.rootUri} failed: ${e.stack || e.message}`);
    }
  }
  console.log(`[${kind}/related-quotes] ${groups.length} thread(s), ${posted} quote(s) posted`);
  return { groups: groups.length, posted };
}

module.exports = {
  sweepRelatedQuotes,
  buildWorkItems,
  processGroup,
  alertKind,
  QUOTE_TEXT,
  MAX_QUOTES_PER_THREAD,
  LEAD_MS,
};
