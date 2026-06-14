const { acquireCooldown, clearCooldown } = require('./state');

// Returns { agent, primary } on post, null on cooldown-race loss.
//
// `forceClearCooldown`: caller has decided this candidate dominates whatever set
// the existing cooldown (severity escalation) and should bypass the atomic
// cooldown gate. We clear the keys first so acquireCooldown can re-stamp them
// with this post's own ts — without this the severity-override path passes the
// pre-check but loses the atomic acquire, silently dropping the escalation.
async function commitAndPost({
  cooldownKeys,
  cooldownTtlMs,
  forceClearCooldown = false,
  recordSkip,
  agentLogin,
  image,
  text,
  alt,
  recordPosted,
  postWithImage,
  postText,
}) {
  if (forceClearCooldown) clearCooldown(cooldownKeys);
  if (!acquireCooldown(cooldownKeys, Date.now(), cooldownTtlMs || null)) {
    console.log('Lost cooldown race to another instance, skipping post');
    recordSkip();
    return null;
  }
  const agent = await agentLogin();
  const primary = image
    ? await postWithImage(agent, text, image, alt)
    : await postText(agent, text);
  recordPosted(primary);
  console.log(`Posted: ${primary.url}`);
  return { agent, primary };
}

module.exports = { commitAndPost };
