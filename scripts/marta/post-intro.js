#!/usr/bin/env node
// Each MARTA bot posts a pinned intro post that (a) links atlantatransitalerts.app
// as a clickable richtext facet and (b) embeds the starter pack as a native
// card (app.bsky.embed.record) — the same shape as the Chicago bots' intros.
//
// The starter pack ref (uri + cid) comes from data/marta/starter-pack.json
// (written by create-starter-pack.js), or --starter-pack <url> /
// MARTA_STARTER_PACK_URL with the cid resolved from the public API.
//
// Idempotent: if an account's current intro already matches the copy below it's
// left in place (and re-pinned); otherwise any prior intro (a post embedding or
// link-carding this starter pack) is deleted and replaced. The fresh intro is
// pinned. --force always deletes + reposts.
//
// Usage:
//   node scripts/marta/post-intro.js [--kind=bus|train|alerts] [--dry-run] [--force]
//   node scripts/marta/post-intro.js --starter-pack https://bsky.app/starter-pack/...

require('dotenv').config({
  path: require('node:path').join(__dirname, '..', '..', '.env'),
});

const fs = require('node:fs');
const path = require('node:path');
const argv = require('minimist')(process.argv.slice(2), {
  boolean: ['dry-run', 'force'],
  string: ['starter-pack'],
});
const { login } = require('../../src/marta/shared/bluesky');
const { credsFor, selectAccounts } = require('./lib/bot-accounts');

const PACK_FILE = path.join(__dirname, '..', '..', 'data', 'marta', 'starter-pack.json');
const SITE_DOMAIN = 'atlantatransitalerts.app';
const SITE_URL = 'https://atlantatransitalerts.app';

// Per-account intro copy, following the CTA template: who I am + what I post,
// what it feeds (the site domain becomes a clickable facet), "Other accounts 👇"
// (the starter-pack card sits below), and the affiliation disclaimer. Keep each
// ≤ 300 graphemes — Bluesky's hard cap.
const INTROS = {
  bus: [
    '🚌 This is MARTA Bus Insights — live bus bunching, gaps, ghost buses & hourly speedmaps.',
    '',
    `It feeds ${SITE_DOMAIN} — a searchable, filterable record of MARTA service quality, live + historical.`,
    '',
    'Other accounts 👇',
    '',
    'Not affiliated with MARTA.',
  ].join('\n'),
  train: [
    '🚆 This is MARTA Train Insights — live rail & streetcar bunching, gaps, ghost trains, speedmaps & system snapshots.',
    '',
    `It feeds ${SITE_DOMAIN} — a searchable, filterable record of MARTA service quality, live + historical.`,
    '',
    'Other accounts 👇',
    '',
    'Not affiliated with MARTA.',
  ].join('\n'),
  alerts: [
    '⚠️ This is MARTA Alert Insights — major disruptions: suspended segments, shuttles & delays, with official alerts + bot-detected outages.',
    '',
    `It feeds ${SITE_DOMAIN} — a searchable, filterable record of MARTA service quality, live + historical.`,
    '',
    'Other accounts 👇',
    '',
    'Not affiliated with MARTA.',
  ].join('\n'),
};

// A richtext link facet over the first occurrence of the site domain in text.
// Offsets are UTF-8 byte indices (emoji earlier in the text are multi-byte).
function siteFacet(text) {
  const i = text.indexOf(SITE_DOMAIN);
  if (i < 0) return undefined;
  const byteStart = Buffer.byteLength(text.slice(0, i), 'utf8');
  const byteEnd = byteStart + Buffer.byteLength(SITE_DOMAIN, 'utf8');
  return [
    {
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: SITE_URL }],
    },
  ];
}

async function resolvePack() {
  let pack = {};
  if (fs.existsSync(PACK_FILE)) {
    try {
      pack = JSON.parse(fs.readFileSync(PACK_FILE, 'utf8'));
    } catch (_) {}
  }
  if (argv['starter-pack']) pack.url = argv['starter-pack'];
  else if (process.env.MARTA_STARTER_PACK_URL) pack.url = process.env.MARTA_STARTER_PACK_URL;

  if (!pack.uri || !pack.cid) {
    // Resolve uri/cid from the share URL via the public API.
    const url = pack.url;
    const m = url && /starter-pack\/([^/]+)\/([^/?#]+)/.exec(url);
    if (!m) return null;
    const api = `https://public.api.bsky.app/xrpc/app.bsky.graph.getStarterPack?starterPack=at://${m[1]}/app.bsky.graph.starterpack/${m[2]}`;
    const res = await fetch(api).then((r) => r.json());
    pack.uri = res?.starterPack?.uri;
    pack.cid = res?.starterPack?.cid;
  }
  return pack.uri && pack.cid ? pack : null;
}

// Prior intro posts by this account: own posts that embed the starter pack as a
// record, or (legacy) carry it as an external link card.
async function findIntroPosts(agent, did, pack) {
  try {
    const { data } = await agent.app.bsky.feed.getAuthorFeed({ actor: did, limit: 50 });
    return (data.feed || [])
      .filter((item) => item.post?.author?.did === did)
      .filter((item) => {
        const embed = item.post?.record?.embed;
        return embed?.record?.uri === pack.uri || embed?.external?.uri === pack.url;
      })
      .map((item) => ({
        uri: item.post.uri,
        cid: item.post.cid,
        text: item.post.record?.text || '',
      }));
  } catch (_) {
    return [];
  }
}

async function pinPost(agent, ref) {
  await agent.upsertProfile((existing) => ({
    ...existing,
    pinnedPost: { uri: ref.uri, cid: ref.cid },
  }));
}

async function postOne(account, pack) {
  const { identifier, password } = credsFor(account);
  if (!identifier || !password) {
    console.warn(`[${account.label}] no credentials in env, skipping`);
    return;
  }
  const text = INTROS[account.kind];

  console.log(`\n[${account.label}] ${account.handle}`);
  console.log(`  text:\n    ${text.replace(/\n/g, '\n    ')}`);
  console.log(`  facet -> ${SITE_URL}`);
  console.log(`  record embed -> ${pack.uri}`);

  if (argv['dry-run']) {
    console.log('  [dry-run] not posting');
    return;
  }

  const agent = await login(identifier, password);
  const did = agent.session.did;
  const existing = await findIntroPosts(agent, did, pack);

  // Already-current intro: keep it, just make sure it's pinned.
  const current = existing.find((p) => p.text === text);
  if (current && !argv.force) {
    await pinPost(agent, current);
    console.log('  intro already current — re-pinned, no repost');
    return;
  }

  // Replace: drop any prior intros (incl. legacy external-card ones) then post.
  for (const old of existing) {
    await agent.deletePost(old.uri);
    console.log(`  deleted prior intro ${old.uri.split('/').pop()}`);
  }

  const res = await agent.post({
    text,
    facets: siteFacet(text),
    embed: {
      $type: 'app.bsky.embed.record',
      record: { uri: pack.uri, cid: pack.cid },
    },
  });
  const rkey = res.uri.split('/').pop();
  const url = `https://bsky.app/profile/${did}/post/${rkey}`;
  await pinPost(agent, { uri: res.uri, cid: res.cid });
  console.log(`  ✓ posted + pinned ${url}`);
}

async function main() {
  const pack = await resolvePack();
  if (!pack) {
    throw new Error(
      'No starter pack ref. Run create-starter-pack.js first, or pass --starter-pack <url> / set MARTA_STARTER_PACK_URL.',
    );
  }

  const accounts = selectAccounts(argv.kind);
  for (const account of accounts) {
    try {
      await postOne(account, pack);
    } catch (e) {
      console.error(`[${account.label}] failed: ${e.stack || e.message}`);
      process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
