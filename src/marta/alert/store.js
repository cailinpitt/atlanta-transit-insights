// MARTA official-alert lifecycle storage (plan Phase 6).
//
// Official alerts are GTFS-rt ServiceAlerts (src/marta/alert/api.js). This is
// where a feed entity becomes a tracked incident: first/last seen, post URI,
// text-version history, and the feed-drop resolution lifecycle. It's the alert
// analog of src/marta/shared/incidents.js (bot detections) and is what the
// alerts bot AND the alerts.json export both read.
//
// Ported from the alert_posts/alert_versions subset of cta-insights
// src/shared/history.js, trimmed of the CTA/Metra single-train schedule
// machinery (cancellation/delay deadlines) MARTA's general service alerts don't
// have. MARTA-native fields added: `mode` (bus|rail|streetcar|general — the
// agency/mode tag the website export needs), plus the feed's `cause`, `effect`,
// and active-period bounds.
//
// Like incidents.js it shares the one MARTA SQLite file (via storage.getDb())
// and owns its own tables, created lazily on first use. There is ONE MARTA
// alerts account, so — unlike CTA's per-account `kind` filter — the lifecycle
// queries span every mode.
const storage = require('../storage');
const { markWebPushPending } = require('../../shared/webPushTrigger');

// Feed-drop resolution threshold: how many consecutive ticks an alert must be
// absent from the feed before we post a "resolved" reply. Flicker-safe; the
// recorded resolved_ts is backdated to the first missing tick (pending_resolved_ts)
// so it's independent of cron cadence. COUPLED to the alerts cron cadence — keep
// the wall-clock clear window (TICKS × cadence) in the ~5-10 min range.
const ALERT_CLEAR_TICKS = 3;
// An alert we already resolved that reappears after this gap is a fresh incident
// (new chapter under the same id), not a flicker.
const ALERT_FLICKER_RESET_MS = 30 * 60 * 1000;

let _initedDb = null;

// Shared MARTA DB handle with the alert tables ensured. The guard re-runs CREATE
// TABLE when the underlying handle changes (tests reopen via storage.closeDb()).
function getDb() {
  const db = storage.getDb();
  if (_initedDb !== db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS alert_posts (
        alert_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        routes TEXT,
        headline TEXT,
        description TEXT,
        cause TEXT,
        effect TEXT,
        active_start_ts INTEGER,
        active_end_ts INTEGER,
        first_seen_ts INTEGER NOT NULL,
        last_seen_ts INTEGER NOT NULL,
        post_uri TEXT,
        resolved_ts INTEGER,
        resolved_reply_uri TEXT,
        clear_ticks INTEGER NOT NULL DEFAULT 0,
        pending_resolved_ts INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_alert_posts_mode ON alert_posts(mode);
      CREATE INDEX IF NOT EXISTS idx_alert_posts_resolved ON alert_posts(resolved_ts);

      CREATE TABLE IF NOT EXISTS alert_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        headline TEXT,
        description TEXT,
        routes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_alert_versions_alert_ts
        ON alert_versions(alert_id, ts);
    `);
    _initedDb = db;
  }
  return db;
}

function getAlertPost(alertId) {
  return getDb().prepare('SELECT * FROM alert_posts WHERE alert_id = ?').get(alertId) || null;
}

// All alerts still considered active (no resolved_ts), across every mode.
function listUnresolvedAlerts() {
  return getDb().prepare('SELECT * FROM alert_posts WHERE resolved_ts IS NULL').all();
}

// Every version row for an alert, oldest first — the text-change timeline.
function getAlertVersions(alertId) {
  return getDb()
    .prepare('SELECT * FROM alert_versions WHERE alert_id = ? ORDER BY ts ASC, id ASC')
    .all(alertId);
}

// A "version" is the rider-visible text (headline + description) plus affected
// routes. We log a new version row when the incoming value is non-null and
// differs from what's stored — the UPDATEs use COALESCE(?, col), so a null
// incoming value preserves the column and must not count as a change.
function changed(incoming, stored) {
  return incoming != null && incoming !== stored;
}

// Record (or refresh) a sighting of an alert. Called twice per new alert: once
// pre-post (postUri:null) so a crash between posting and the post-post write is
// still detectable, once post-post with the URI (COALESCE preserves it on the
// null write). Mirrors the CTA invariant.
function recordAlertSeen(
  {
    alertId,
    mode,
    routes,
    headline,
    description,
    cause,
    effect,
    activeStartTs,
    activeEndTs,
    postUri,
  },
  now = Date.now(),
) {
  const rt = routes == null ? null : routes;
  const hd = headline == null ? null : headline;
  const ds = description == null ? null : description;
  const existing = getAlertPost(alertId);

  const isVersionChange =
    !existing ||
    changed(hd, existing.headline) ||
    changed(ds, existing.description) ||
    changed(rt, existing.routes);

  const insertVersion = () => {
    getDb()
      .prepare(`
        INSERT INTO alert_versions (alert_id, ts, headline, description, routes)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        alertId,
        now,
        hd ?? existing?.headline ?? null,
        ds ?? existing?.description ?? null,
        rt ?? existing?.routes ?? null,
      );
  };

  if (existing) {
    const wasResolved = existing.resolved_ts != null;
    // A genuinely new chapter under the same id: the post finally landed after a
    // premature resolution wiped resolved_ts before any post existed, or the feed
    // re-published the same id after long enough to count as a fresh incident.
    // New chapters start clean and log a version unconditionally so the timeline
    // shows the gap even when the text is unchanged.
    const newChapter =
      wasResolved &&
      ((postUri && !existing.post_uri) || now - existing.last_seen_ts > ALERT_FLICKER_RESET_MS);
    // A short flicker: the alert dropped long enough for us to resolve it, then
    // re-listed within the flicker window. Same incident — clear resolved_ts so
    // tracking resumes, but KEEP resolved_reply_uri so the bot doesn't post a
    // duplicate "resolved" reply when it re-resolves.
    const flickerReopen = wasResolved && !newChapter;
    const resolutionReset = newChapter
      ? ', resolved_ts = NULL, resolved_reply_uri = NULL, clear_ticks = 0'
      : flickerReopen
        ? ', resolved_ts = NULL, clear_ticks = 0'
        : '';
    if (newChapter || isVersionChange) insertVersion();
    getDb()
      .prepare(`
        UPDATE alert_posts
        SET last_seen_ts = ?, post_uri = COALESCE(?, post_uri),
            mode = COALESCE(?, mode),
            headline = COALESCE(?, headline), routes = COALESCE(?, routes),
            description = COALESCE(?, description),
            cause = COALESCE(?, cause), effect = COALESCE(?, effect),
            active_start_ts = COALESCE(?, active_start_ts),
            active_end_ts = COALESCE(?, active_end_ts)${resolutionReset}
        WHERE alert_id = ?
      `)
      .run(
        now,
        postUri || null,
        mode || null,
        hd,
        rt,
        ds,
        cause ?? null,
        effect ?? null,
        activeStartTs ?? null,
        activeEndTs ?? null,
        alertId,
      );
    // Republish only when the export actually changes: new text version, a
    // resolution reset (new chapter / flicker reopen), or the post URI first
    // landing. A plain last_seen_ts bump every poll must NOT kick the push.
    if (isVersionChange || newChapter || flickerReopen || (postUri && !existing.post_uri)) {
      markWebPushPending();
    }
    return;
  }

  insertVersion();
  getDb()
    .prepare(`
      INSERT INTO alert_posts
        (alert_id, mode, routes, headline, description, cause, effect,
         active_start_ts, active_end_ts, first_seen_ts, last_seen_ts, post_uri)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      alertId,
      mode || 'general',
      rt,
      hd,
      ds,
      cause ?? null,
      effect ?? null,
      activeStartTs ?? null,
      activeEndTs ?? null,
      now,
      now,
      postUri || null,
    );
  markWebPushPending(); // a newly tracked alert is a new website incident
}

// Mark an alert resolved. resolved_ts prefers pending_resolved_ts (the first
// missing tick) over `now` (the threshold tick) so the recorded end time is
// independent of cron cadence.
function recordAlertResolved({ alertId, replyUri }, now = Date.now()) {
  getDb()
    .prepare(`
      UPDATE alert_posts
      SET resolved_ts = COALESCE(pending_resolved_ts, ?),
          resolved_reply_uri = ?,
          pending_resolved_ts = NULL
      WHERE alert_id = ?
    `)
    .run(now, replyUri || null, alertId);
  markWebPushPending();
}

// Advance the absent-from-feed counter; returns the new tick count. Stamps
// pending_resolved_ts on the 0→1 transition only (COALESCE keeps an earlier
// value), so the eventual resolved_ts backdates to the first missing tick.
function incrementAlertClearTicks(alertId, now = Date.now()) {
  getDb()
    .prepare(`
      UPDATE alert_posts
      SET clear_ticks = clear_ticks + 1,
          pending_resolved_ts = COALESCE(pending_resolved_ts, ?)
      WHERE alert_id = ?
    `)
    .run(now, alertId);
  const row = getDb()
    .prepare('SELECT clear_ticks FROM alert_posts WHERE alert_id = ?')
    .get(alertId);
  return row ? row.clear_ticks : 0;
}

function resetAlertClearTicks(alertId) {
  getDb()
    .prepare(
      'UPDATE alert_posts SET clear_ticks = 0, pending_resolved_ts = NULL WHERE alert_id = ?',
    )
    .run(alertId);
}

module.exports = {
  getAlertPost,
  getAlertVersions,
  listUnresolvedAlerts,
  recordAlertSeen,
  recordAlertResolved,
  incrementAlertClearTicks,
  resetAlertClearTicks,
  ALERT_CLEAR_TICKS,
  ALERT_FLICKER_RESET_MS,
};
