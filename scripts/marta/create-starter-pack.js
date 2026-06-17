#!/usr/bin/env node
// Creates a Bluesky starter pack bundling the three MARTA bots, owned by one of
// them (default: the bus account). A starter pack is three records: an
// app.bsky.graph.list (purpose referencelist) + one listitem per member + x the
// app.bsky.graph.starterpack pointing at that list. The resulting share URL is
// printed and written to data/marta/starter-pack.json so post-intro.js can link
// it.
//
// Idempotent guard: skips if the owner already has a starter pack with the same
// name (prints the existing URL) unless --force is passed.
//
// Usage:
//   node scripts/marta/create-starter-pack.js [--owner=bus|train|alerts] [--dry-run] [--force]

require('dotenv').config({
  path: require('node:path').join(__dirname, '..', '..', '.env'),
});

const fs = require('node:fs');
const path = require('node:path');
const argv = require('minimist')(process.argv.slice(2), {
  boolean: ['dry-run', 'force'],
});
const { login } = require('../../src/marta/shared/bluesky');
const { ACCOUNTS, credsFor, selectAccounts } = require('./lib/bot-accounts');

const PACK_NAME = 'MARTA Transit Insights';
const PACK_DESCRIPTION = [
  'Automated MARTA transit-tracking bots.',
  'Bus + rail/streetcar speedmaps, bunching, long gaps, ghost vehicles, and major service alerts.',
  '',
  'atlantatransitalerts.app · Not affiliated with MARTA.',
].join('\n');

const OUT_PATH = path.join(__dirname, '..', '..', 'data', 'marta', 'starter-pack.json');

function rkeyOf(uri) {
  return uri.split('/').pop();
}

function packUrl(handle, uri) {
  return `https://bsky.app/starter-pack/${handle}/${rkeyOf(uri)}`;
}

async function resolveDid(agent, handle) {
  const { data } = await agent.com.atproto.identity.resolveHandle({ handle });
  return data.did;
}

async function findExistingPack(agent, ownerDid) {
  try {
    const { data } = await agent.app.bsky.graph.getActorStarterPacks({
      actor: ownerDid,
      limit: 100,
    });
    return (data.starterPacks || []).find((p) => p.record?.name === PACK_NAME) || null;
  } catch (_) {
    return null;
  }
}

function persistUrl(url, uri, cid) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify({ url, uri, cid, name: PACK_NAME }, null, 2)}\n`);
  console.log(`\nWrote ${OUT_PATH}`);
}

async function main() {
  const owner = selectAccounts(argv.owner || 'bus')[0];
  const { identifier, password } = credsFor(owner);
  if (!identifier || !password) {
    throw new Error(`[${owner.label}] no credentials in env`);
  }

  console.log(`Owner: ${owner.label} (${owner.handle})`);
  console.log(`Members: ${ACCOUNTS.map((a) => `@${a.handle}`).join(', ')}`);
  console.log(`Pack name: ${PACK_NAME}`);

  if (argv['dry-run']) {
    console.log('\n[dry-run] would create list + listitems + starter pack');
    return;
  }

  const agent = await login(identifier, password);
  const ownerDid = agent.session.did;

  const existing = await findExistingPack(agent, ownerDid);
  if (existing && !argv.force) {
    const url = packUrl(owner.handle, existing.uri);
    console.log(`\nStarter pack already exists: ${url}`);
    console.log('Pass --force to create another.');
    persistUrl(url, existing.uri, existing.cid);
    return;
  }

  const memberDids = [];
  for (const a of ACCOUNTS) {
    memberDids.push(await resolveDid(agent, a.handle));
  }

  const now = new Date().toISOString();

  // 1. The reference list the starter pack points at.
  const list = await agent.com.atproto.repo.createRecord({
    repo: ownerDid,
    collection: 'app.bsky.graph.list',
    record: {
      $type: 'app.bsky.graph.list',
      purpose: 'app.bsky.graph.defs#referencelist',
      name: PACK_NAME,
      description: 'Members of the MARTA Transit Insights starter pack.',
      createdAt: now,
    },
  });
  const listUri = list.data.uri;
  console.log(`\nCreated list ${listUri}`);

  // 2. One listitem per member.
  for (const did of memberDids) {
    await agent.com.atproto.repo.createRecord({
      repo: ownerDid,
      collection: 'app.bsky.graph.listitem',
      record: {
        $type: 'app.bsky.graph.listitem',
        subject: did,
        list: listUri,
        createdAt: new Date().toISOString(),
      },
    });
    console.log(`  added member ${did}`);
  }

  // 3. The starter pack record itself.
  const pack = await agent.com.atproto.repo.createRecord({
    repo: ownerDid,
    collection: 'app.bsky.graph.starterpack',
    record: {
      $type: 'app.bsky.graph.starterpack',
      name: PACK_NAME,
      description: PACK_DESCRIPTION,
      list: listUri,
      feeds: [],
      createdAt: now,
      updatedAt: now,
    },
  });

  const url = packUrl(owner.handle, pack.data.uri);
  console.log(`\n✓ Starter pack created: ${url}`);
  persistUrl(url, pack.data.uri, pack.data.cid);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
