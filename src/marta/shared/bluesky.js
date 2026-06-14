// Bluesky posting for the MARTA bots. Ported from cta-insights
// src/shared/bluesky.js + the per-account login wrappers (src/bus/bluesky.js
// etc.). Dropped for this slice: web-push triggers and the transitchicago.com
// link facet (image posts carry no links — facet support returns with the
// alerts poster), plus the video upload path (video is deferred).
//
// Accounts: the user points the BUS and TRAIN handles at the same
// `martainsights` account and ALERTS at `martaalertinsights`. Keeping three
// identifiers mirrors the CTA reference and keeps bus/rail code parallel.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AtpAgent } = require('@atproto/api');

// Persist session JWTs to disk and resume on subsequent runs so each cron tick
// doesn't call agent.login() fresh (Bluesky caps createSession ~300/day +
// 30/5min). login() is only hit on first use or after a refresh-token expiry.
const SESSION_DIR =
  process.env.BLUESKY_SESSION_DIR ||
  path.join(__dirname, '..', '..', '..', 'data', 'bluesky-sessions');

function sessionPath(identifier) {
  const key = crypto.createHash('sha1').update(identifier).digest('hex').slice(0, 16);
  return path.join(SESSION_DIR, `${key}.json`);
}

function loadSession(identifier) {
  try {
    return JSON.parse(fs.readFileSync(sessionPath(identifier), 'utf8'));
  } catch (_) {
    return null;
  }
}

function saveSession(identifier, session) {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(sessionPath(identifier), JSON.stringify(session), { mode: 0o600 });
  } catch (e) {
    console.warn(`bluesky: failed to persist session: ${e.message}`);
  }
}

function clearSession(identifier) {
  try {
    fs.unlinkSync(sessionPath(identifier));
  } catch (_) {}
}

async function login(identifier, password) {
  const persistSession = (evt, session) => {
    if (evt === 'create' || evt === 'update') {
      if (session) saveSession(identifier, session);
    } else if (evt === 'expired') {
      clearSession(identifier);
    }
  };
  const agent = new AtpAgent({
    service: process.env.BLUESKY_SERVICE || 'https://bsky.social',
    persistSession,
  });
  const cached = loadSession(identifier);
  if (cached) {
    try {
      await agent.resumeSession(cached);
      if (agent.session?.accessJwt) return agent;
    } catch (_) {
      clearSession(identifier);
    }
  }
  await agent.login({ identifier, password });
  return agent;
}

function loginBus() {
  return login(process.env.BLUESKY_BUS_IDENTIFIER, process.env.BLUESKY_BUS_APP_PASSWORD);
}

function loginTrain() {
  return login(process.env.BLUESKY_TRAIN_IDENTIFIER, process.env.BLUESKY_TRAIN_APP_PASSWORD);
}

function loginAlerts() {
  return login(process.env.BLUESKY_ALERTS_IDENTIFIER, process.env.BLUESKY_ALERTS_APP_PASSWORD);
}

function postUrl(result) {
  const rkey = result.uri.split('/').pop();
  const did = result.uri.split('/')[2];
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

async function postWithImage(agent, text, imageBuffer, altText, replyRef = null) {
  const upload = await agent.uploadBlob(imageBuffer, { encoding: 'image/jpeg' });
  const result = await agent.post({
    text,
    ...(replyRef && { reply: replyRef }),
    embed: {
      $type: 'app.bsky.embed.images',
      images: [{ image: upload.data.blob, alt: altText }],
    },
  });
  return { url: postUrl(result), uri: result.uri, cid: result.cid };
}

async function postText(agent, text, replyRef = null) {
  const result = await agent.post({
    text,
    ...(replyRef && { reply: replyRef }),
  });
  return { url: postUrl(result), uri: result.uri, cid: result.cid };
}

module.exports = {
  login,
  loginBus,
  loginTrain,
  loginAlerts,
  postWithImage,
  postText,
};
