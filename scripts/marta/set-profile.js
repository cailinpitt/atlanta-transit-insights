#!/usr/bin/env node
// Sets displayName, description, and avatar for the MARTA bot accounts from the
// declarative config in lib/bot-accounts.js + the generated avatars in
// assets/marta/. Idempotent: upsertProfile reads the current record and merges,
// so re-running only changes the three fields we manage. Run after
// generate-avatar.js.
//
// Usage:
//   node scripts/marta/set-profile.js [--kind=bus|train|alerts] [--dry-run]
//   node scripts/marta/set-profile.js --no-avatar   # text fields only

require('dotenv').config({
  path: require('node:path').join(__dirname, '..', '..', '.env'),
});

const fs = require('node:fs');
const path = require('node:path');
const argv = require('minimist')(process.argv.slice(2), {
  boolean: ['dry-run', 'no-avatar'],
});
const { login } = require('../../src/marta/shared/bluesky');
const { credsFor, selectAccounts } = require('./lib/bot-accounts');

const ASSET_DIR = path.join(__dirname, '..', '..', 'assets', 'marta');

async function applyOne(account) {
  const { identifier, password } = credsFor(account);
  if (!identifier || !password) {
    console.warn(`[${account.label}] no credentials in env, skipping`);
    return;
  }

  let avatarBuf = null;
  if (!argv['no-avatar']) {
    const avatarPath = path.join(ASSET_DIR, account.avatar);
    if (!fs.existsSync(avatarPath)) {
      throw new Error(
        `[${account.label}] missing ${avatarPath} — run scripts/marta/generate-avatar.js first`,
      );
    }
    avatarBuf = fs.readFileSync(avatarPath);
  }

  console.log(`\n[${account.label}] ${account.handle}`);
  console.log(`  displayName: ${account.displayName}`);
  console.log(`  description:\n    ${account.description.replace(/\n/g, '\n    ')}`);
  console.log(`  avatar: ${argv['no-avatar'] ? '(unchanged)' : account.avatar}`);

  if (argv['dry-run']) {
    console.log('  [dry-run] not writing profile');
    return;
  }

  const agent = await login(identifier, password);

  let avatarBlob;
  if (avatarBuf) {
    const upload = await agent.uploadBlob(avatarBuf, { encoding: 'image/png' });
    avatarBlob = upload.data.blob;
  }

  await agent.upsertProfile((existing) => ({
    ...existing,
    displayName: account.displayName,
    description: account.description,
    ...(avatarBlob ? { avatar: avatarBlob } : {}),
  }));

  console.log('  ✓ profile updated');
}

async function main() {
  const accounts = selectAccounts(argv.kind);
  for (const account of accounts) {
    try {
      await applyOne(account);
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
