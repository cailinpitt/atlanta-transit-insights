#!/usr/bin/env node
// MARTA bot profile-image generator. Ported from cta-insights
// scripts/generate-avatar.js — same emoji-on-radial-gradient look as the CTA
// bots, retargeted to the three MARTA accounts. Twemoji SVGs are downloaded so
// the emoji renders identically regardless of host font — macOS and Ubuntu
// glyphs differ and we want dev/prod parity.
//
// Usage: node scripts/marta/generate-avatar.js [--kind=bus|train|alerts]
// Output: assets/marta/avatar-<kind>.png (assets/ is gitignored — regenerate
// as needed, then upload with scripts/marta/set-profile.js).

const Fs = require('fs-extra');
const Path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const argv = require('minimist')(process.argv.slice(2));

const W = 1024;
const H = 1024;
// Bluesky crops profile pictures to a circle. We render the gradient inside an
// explicit circle (transparent corners) and shrink the emoji to ~64% of the
// canvas so it sits comfortably inside the circular crop with breathing room
// on every side, not just left/right.
const CIRCLE_R = 500; // 24 px ring of safety against the bounding box
const EMOJI_SIZE = 600;

// A diagonal sweep across the three colors of MARTA's logo stripe (cyan-blue →
// gold → orange, left-to-right as in the wordmark) backs all three avatars, so
// the trio reads as one MARTA-branded set; only the emoji distinguishes them.
const MARTA_STOPS = [
  { offset: '0%', color: '#00aeef' }, // logo blue (cyan)
  { offset: '50%', color: '#ffc20e' }, // logo gold/yellow
  { offset: '100%', color: '#f58025' }, // logo orange
];

const CONFIGS = {
  bus: {
    codepoint: '1f68c', // 🚌
    out: 'avatar-bus.png',
  },
  train: {
    codepoint: '1f687', // 🚇 (metro)
    out: 'avatar-train.png',
  },
  alerts: {
    codepoint: '26a0', // ⚠
    out: 'avatar-alerts.png',
  },
};

async function renderOne(kind) {
  const cfg = CONFIGS[kind];
  if (!cfg) throw new Error(`Unknown avatar kind: ${kind}`);
  const url = `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg/${cfg.codepoint}.svg`;
  console.log(`[${kind}] fetching ${url}...`);
  const { data: svg } = await axios.get(url, { responseType: 'text', timeout: 30000 });

  // Disc on a transparent square so the avatar reads correctly even on
  // platforms that don't crop to a circle.
  const cx = W / 2;
  const cy = H / 2;
  const stops = MARTA_STOPS.map((s) => `<stop offset="${s.offset}" stop-color="${s.color}"/>`).join(
    '\n        ',
  );
  // A soft dark radial scrim under the emoji keeps it legible everywhere the
  // multicolor gradient runs light (e.g. the gold band behind the ⚠).
  const composite = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        ${stops}
      </linearGradient>
      <radialGradient id="scrim" cx="50%" cy="50%" r="42%">
        <stop offset="0%" stop-color="rgba(0,0,0,0.22)"/>
        <stop offset="45%" stop-color="rgba(0,0,0,0.10)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
      </radialGradient>
    </defs>
    <circle cx="${cx}" cy="${cy}" r="${CIRCLE_R}" fill="url(#bg)"/>
    <circle cx="${cx}" cy="${cy}" r="${CIRCLE_R}" fill="url(#scrim)"/>
    <circle cx="${cx}" cy="${cy}" r="${CIRCLE_R - 6}" fill="none"
            stroke="rgba(255,255,255,0.22)" stroke-width="3"/>
  </svg>`;

  const outPath = Path.join(__dirname, '..', '..', 'assets', 'marta', cfg.out);
  Fs.ensureDirSync(Path.dirname(outPath));

  // Default sharp density for SVGs with explicit width/height — overriding
  // would scale the canvas without scaling the emoji composited on top.
  const bgBuffer = await sharp(Buffer.from(composite)).png().toBuffer();
  // .trim() removes Twemoji's built-in transparent padding so center alignment works.
  const emojiBuffer = await sharp(Buffer.from(svg), { density: 600 })
    .png()
    .trim()
    .resize(EMOJI_SIZE, EMOJI_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  await sharp(bgBuffer)
    .composite([{ input: emojiBuffer, gravity: 'center' }])
    .png()
    .toFile(outPath);

  console.log(`[${kind}] wrote ${outPath}`);
}

async function main() {
  const kinds = argv.kind ? [argv.kind] : Object.keys(CONFIGS);
  for (const k of kinds) await renderOne(k);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
