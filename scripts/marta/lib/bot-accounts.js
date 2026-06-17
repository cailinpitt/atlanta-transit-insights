// Single source of truth for the three MARTA Bluesky bot accounts, shared by
// the one-off profile/starter-pack/cross-follow/intro setup scripts under
// scripts/marta/. Credentials come from .env (see .env.example); identity and
// copy live here so the scripts stay declarative.
//
//   bus    -> @martabusinsights    (bunching, gaps, ghost buses, speedmaps)
//   train  -> @martatraininsights  (rail + Atlanta Streetcar insights)
//   alerts -> @martaalertinsights  (official alerts + bot-detected outages)

const ACCOUNTS = [
  {
    label: 'bus',
    kind: 'bus',
    handle: 'martabusinsights.atlantatransitalerts.app',
    identifierEnv: 'BLUESKY_BUS_IDENTIFIER',
    passwordEnv: 'BLUESKY_BUS_APP_PASSWORD',
    avatar: 'avatar-bus.png',
    displayName: 'MARTA Bus Insights',
    description: [
      '🚌 MARTA bus transit, live.',
      'Bunching, long gaps, ghost buses + hourly speedmaps.',
      '',
      'atlantatransitalerts.app',
      '',
      'Not affiliated with MARTA.',
    ].join('\n'),
  },
  {
    label: 'train',
    kind: 'train',
    handle: 'martatraininsights.atlantatransitalerts.app',
    identifierEnv: 'BLUESKY_TRAIN_IDENTIFIER',
    passwordEnv: 'BLUESKY_TRAIN_APP_PASSWORD',
    avatar: 'avatar-train.png',
    displayName: 'MARTA Train Insights',
    description: [
      '🚆 MARTA rail + Atlanta Streetcar, live.',
      'Bunching, long gaps, ghost trains, hourly speedmaps + system snapshots.',
      '',
      'atlantatransitalerts.app',
      '',
      'Not affiliated with MARTA.',
    ].join('\n'),
  },
  {
    label: 'alerts',
    kind: 'alerts',
    handle: 'martaalertinsights.atlantatransitalerts.app',
    identifierEnv: 'BLUESKY_ALERTS_IDENTIFIER',
    passwordEnv: 'BLUESKY_ALERTS_APP_PASSWORD',
    avatar: 'avatar-alerts.png',
    displayName: 'MARTA Alert Insights',
    description: [
      'Major MARTA disruptions — suspended segments, shuttles, delays. Auto-detected outages + MARTA alerts.',
      '',
      'atlantatransitalerts.app',
      '',
      'github.com/cailinpitt/atlanta-transit-insights',
      '',
      'Not affiliated with MARTA.',
    ].join('\n'),
  },
];

function credsFor(account) {
  return {
    identifier: process.env[account.identifierEnv],
    password: process.env[account.passwordEnv],
  };
}

// Resolve --kind=bus|train|alerts (or a positional kind) to the account subset.
function selectAccounts(kind) {
  if (!kind) return ACCOUNTS;
  const wanted = ACCOUNTS.filter((a) => a.label === kind || a.kind === kind);
  if (wanted.length === 0) {
    throw new Error(`Unknown account kind: ${kind} (expected bus|train|alerts)`);
  }
  return wanted;
}

module.exports = { ACCOUNTS, credsFor, selectAccounts };
