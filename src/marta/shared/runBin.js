// Entrypoint scaffolding for MARTA detect→post bins. Ported from cta-insights
// src/shared/runBin.js, minus the web-push flush (the public site isn't wired
// yet). `setup()` prunes stale dry-run assets and rolls off both the
// observation window and the incident cooldowns/meta-signals.
const Fs = require('fs-extra');
const Path = require('node:path');
const { pruneOldAssets } = require('../../shared/cleanup');
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
    .then(() => {})
    .catch((e) => {
      console.error(e.stack || e);
      process.exit(1);
    });
}

module.exports = { setup, writeDryRunAsset, runBin };
