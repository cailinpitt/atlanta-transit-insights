// Shared tick-loop for the MARTA observe scripts. Cron's finest granularity is
// 1 minute, so to capture denser snapshots (rail speed comes from position
// deltas; bus ghost detection wants several polls/hour) a single cron firing can
// run multiple ticks spaced by `intervalMs`. Deps are injected so the loop
// unit-tests without sleeping or hitting the network.
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTicks(tick, { ticks = 1, intervalMs = 30_000, sleep = defaultSleep } = {}) {
  for (let i = 0; i < ticks; i++) {
    if (i > 0) await sleep(intervalMs);
    await tick(i);
  }
}

module.exports = { runTicks, defaultSleep };
