#!/usr/bin/env node
// Each MARTA bot follows the other two, so the trio is mutually connected and a
// visitor landing on one finds the others. Ported from cta-insights
// scripts/cross-follow.js. Idempotent — re-following on AtProto is a no-op. Run
// after creating the accounts or whenever the follow graph drifts.
//
// Usage: node scripts/marta/cross-follow.js [--dry-run]

require('dotenv').config({
  path: require('node:path').join(__dirname, '..', '..', '.env'),
});

const argv = require('minimist')(process.argv.slice(2), { boolean: ['dry-run'] });
const { login } = require('../../src/marta/shared/bluesky');
const { ACCOUNTS, credsFor } = require('./lib/bot-accounts');

async function resolveDids(agent, handles) {
  const out = new Map();
  for (const handle of handles) {
    try {
      const { data } = await agent.com.atproto.identity.resolveHandle({ handle });
      out.set(handle, data.did);
    } catch (e) {
      console.warn(`  could not resolve ${handle}: ${e.message}`);
    }
  }
  return out;
}

async function followFromAccount(account, others) {
  const { identifier, password } = credsFor(account);
  if (!identifier || !password) {
    console.warn(`[${account.label}] no credentials in env, skipping`);
    return;
  }
  console.log(`\n[${account.label}] logging in as ${identifier}...`);
  const agent = await login(identifier, password);

  const didByHandle = await resolveDids(
    agent,
    others.map((o) => o.handle),
  );

  for (const target of others) {
    const did = didByHandle.get(target.handle);
    if (!did) {
      console.warn(`  no DID for ${target.handle}, skipping`);
      continue;
    }
    if (argv['dry-run']) {
      console.log(`  [dry-run] would follow ${target.handle} (${did})`);
      continue;
    }
    try {
      await agent.follow(did);
      console.log(`  followed ${target.handle}`);
    } catch (e) {
      console.warn(`  follow ${target.handle} failed: ${e.message}`);
    }
  }
}

async function main() {
  for (const account of ACCOUNTS) {
    const others = ACCOUNTS.filter((a) => a.label !== account.label);
    try {
      await followFromAccount(account, others);
    } catch (e) {
      console.error(`[${account.label}] failed: ${e.stack || e.message}`);
    }
  }
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
