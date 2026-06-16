// Cross-module signal: "this run changed the public web data, kick the
// pages-repo push so the dashboard isn't waiting on the periodic cron."
// Tracked as a single process-local flag; a caller sets it via
// markWebPushPending() when it writes something the web export reads.
//
// WHO arms it differs by agency:
//   - CTA: every post helper in src/shared/bluesky.js arms after a successful
//     post (the website data closely tracks what gets posted).
//   - MARTA: the incident-data writes arm it — the alert store and the
//     detector/roundup records in src/marta/shared/incidents.js — NOT the
//     Bluesky post helpers. So analytics posts (speedmaps, timelapses), which
//     never change the incident export, don't spawn a pointless publish.
//
// runBin calls `flushPendingWebPush()` after the script's main() resolves; if
// the flag was set the trigger spawns push-web-data.sh detached and lets it run
// in the background. The detached process keeps running after the bin exits.
// push-web-data.sh re-exports + diffs, so an arm that didn't actually change the
// data is a cheap no-op; a periodic cron run is the backstop for missed arms.
//
// We don't add a lock here: cron may invoke push-web-data.sh at the same
// minute boundary, and git's own .git/index.lock serializes concurrent
// commits. If a push races and loses the push-to-remote, the next cron
// tick (or the next detection) picks it up. The win is the typical case:
// a single detection now lands on the dashboard in ~30 s instead of
// waiting for the next */7 cron mark.

const Path = require('node:path');
const ChildProcess = require('node:child_process');
const Fs = require('node:fs');

const DEFAULT_SCRIPT = Path.resolve(__dirname, '..', '..', 'bin', 'push-web-data.sh');

let pending = false;

function markWebPushPending() {
  pending = true;
}

// Spawn push-web-data.sh detached. Stdout/stderr go to the same log file
// the cron entry uses (set via PUSH_WEB_LOG; defaults to a sibling of the
// script). On any setup error we swallow it — the next cron tick will run
// the same script, so a missed manual trigger isn't fatal.
function flushPendingWebPush() {
  if (!pending) return false;
  pending = false;
  try {
    const script = process.env.PUSH_WEB_SCRIPT || DEFAULT_SCRIPT;
    if (!Fs.existsSync(script)) {
      console.warn(`webPushTrigger: ${script} missing, cron will catch up`);
      return false;
    }
    const logPath =
      process.env.PUSH_WEB_LOG ||
      Path.resolve(__dirname, '..', '..', 'cron', 'push-web-data-trigger.log');
    let stdio = 'ignore';
    try {
      Fs.mkdirSync(Path.dirname(logPath), { recursive: true });
      const fd = Fs.openSync(logPath, 'a');
      stdio = ['ignore', fd, fd];
    } catch (_e) {
      // Log dir not writable — fall back to discarding output rather than
      // failing the trigger entirely.
    }
    const child = ChildProcess.spawn('/bin/sh', [script], {
      detached: true,
      stdio,
      env: {
        ...process.env,
        RCLONE_REMOTE: process.env.RCLONE_REMOTE || 'r2atlanta:atlanta-transit-alerts-data',
      },
    });
    child.unref();
    console.log(`webPushTrigger: spawned push-web-data.sh (pid=${child.pid})`);
    return true;
  } catch (e) {
    console.warn(`webPushTrigger: spawn failed: ${e.message}`);
    return false;
  }
}

module.exports = { markWebPushPending, flushPendingWebPush };
