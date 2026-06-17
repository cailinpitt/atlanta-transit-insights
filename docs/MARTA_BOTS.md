# MARTA bot accounts — profiles, starter pack, intro posts

One-time (and re-runnable) setup for the three MARTA Bluesky bots. These mirror
the launch setup the Chicago bots used; the original CTA scripts
(`generate-avatar.js`, `cross-follow.js`) were recovered from git history and the
profile/starter-pack/intro steps were rebuilt for MARTA.

| Account | Handle | Posts |
| --- | --- | --- |
| bus | `@martabusinsights.atlantatransitalerts.app` | bunching, gaps, ghost buses, hourly speedmaps |
| train | `@martatraininsights.atlantatransitalerts.app` | rail + Atlanta Streetcar insights + system snapshots |
| alerts | `@martaalertinsights.atlantatransitalerts.app` | official alerts + bot-detected outages |

All identity/copy lives in [`scripts/marta/lib/bot-accounts.js`](../scripts/marta/lib/bot-accounts.js);
credentials come from `.env` (`BLUESKY_{BUS,TRAIN,ALERTS}_IDENTIFIER` /
`_APP_PASSWORD`). Every script takes `--dry-run`; most take `--kind=bus|train|alerts`
to act on a single account.

## Run order

```bash
# 1. Generate the profile images (local, safe). Writes assets/marta/avatar-*.png.
#    Emoji-on-gradient like the CTA bots, but the background sweeps MARTA's
#    logo colors (cyan-blue -> gold -> orange).
npm run marta:gen-avatars

# 2. Set displayName + description + avatar on each account.
npm run marta:set-profile -- --dry-run     # preview
npm run marta:set-profile

# 3. (optional) Have the three bots follow each other.
npm run marta:cross-follow

# 4. Create the "MARTA Transit Insights" starter pack (owned by the bus account).
#    Prints the share URL and writes data/marta/starter-pack.json.
npm run marta:create-starter-pack -- --dry-run
npm run marta:create-starter-pack

# 5. Each account posts a one-time intro with a link card to the starter pack.
#    Reads the URL from data/marta/starter-pack.json by default.
npm run marta:post-intro -- --dry-run
npm run marta:post-intro
```

## Notes

- **Avatars** — `scripts/marta/generate-avatar.js` downloads the Twemoji SVG per
  kind (🚌 / 🚇 / ⚠) and composites it on a diagonal MARTA-logo-color gradient
  with a soft dark scrim for legibility. `assets/` is gitignored, so regenerate
  before re-uploading. Tune the palette via `MARTA_STOPS` in that file.
- **set-profile** is idempotent — `upsertProfile` merges, so only the three
  managed fields change. `--no-avatar` updates text only.
- **create-starter-pack** is guarded: it skips if the owner already has a pack
  named "MARTA Transit Insights" (printing the existing URL) unless `--force`.
  A starter pack is three record types — an `app.bsky.graph.list`
  (`referencelist`), one `listitem` per member, and the
  `app.bsky.graph.starterpack` itself. Change the owner with `--owner=train|alerts`.
- **post-intro** posts the per-account intro copy (in `INTROS`) and **pins it to
  the profile**. Like the CTA intros, each post links `atlantatransitalerts.app`
  as a clickable richtext **facet** and embeds the starter pack as a native card
  (`app.bsky.embed.record`, not an external link card). It's idempotent: if the
  current intro text already matches it's left in place and re-pinned; otherwise
  any prior intro (a post embedding or link-carding this starter pack) is deleted
  and replaced. `--force` always deletes + reposts — use it when only the embed
  or facet changed but the text didn't. Keep each intro ≤ 300 graphemes
  (Bluesky's hard cap). Needs the pack's `uri` + `cid`: read from
  `data/marta/starter-pack.json`, or resolved from `--starter-pack <url>` /
  `MARTA_STARTER_PACK_URL` via the public API.
