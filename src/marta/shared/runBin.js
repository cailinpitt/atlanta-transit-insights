// Entrypoint scaffolding for MARTA detect→post bins. `setup()` prunes stale
// dry-run assets and rolls off both the observation window and the incident
// cooldowns/meta-signals. Successful Bluesky posts trigger a detached R2 data
// publish after main() resolves so the website does not wait for the */15 cron.
const Fs = require('fs-extra');
const Path = require('node:path');
const { pruneOldAssets } = require('../../shared/cleanup');
const { flushPendingWebPush } = require('../../shared/webPushTrigger');
const incidents = require('./incidents');
const storage = require('../storage');

const ASSETS_DIR = Path.join(__dirname, '..', '..', '..', 'assets');

function setup() {
  pruneOldAssets();
  incidents.rolloffOld();
  storage.rolloffOldObservations();
}

function writeDryRunAsset(buffer, filename) {
  const outPath = Path.join(ASSETS_DIR, filename);
  Fs.ensureDirSync(Path.dirname(outPath));
  Fs.writeFileSync(outPath, buffer);
  return outPath;
}

function runBin(main) {
  // --check verifies imports resolved (CI smoke test — no env vars / network).
  if (process.argv.includes('--check')) {
    console.log('OK: imports resolved');
    return;
  }
  main()
    .then(() => {
      process.env.PUSH_WEB_SCRIPT =
        process.env.PUSH_WEB_SCRIPT ||
        Path.join(__dirname, '..', '..', '..', 'bin', 'marta', 'push-web-data.sh');
      process.env.PUSH_WEB_LOG =
        process.env.PUSH_WEB_LOG ||
        Path.join(__dirname, '..', '..', '..', 'state', 'logs', 'push-web-data-trigger.log');
      flushPendingWebPush();
    })
    .catch((e) => {
      console.error(e.stack || e);
      try {
        process.env.PUSH_WEB_SCRIPT =
          process.env.PUSH_WEB_SCRIPT ||
          Path.join(__dirname, '..', '..', '..', 'bin', 'marta', 'push-web-data.sh');
        process.env.PUSH_WEB_LOG =
          process.env.PUSH_WEB_LOG ||
          Path.join(__dirname, '..', '..', '..', 'state', 'logs', 'push-web-data-trigger.log');
        flushPendingWebPush();
      } catch (_) {}
      process.exit(1);
    });
}

module.exports = { setup, writeDryRunAsset, runBin };
