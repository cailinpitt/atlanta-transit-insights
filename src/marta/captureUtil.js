// Shared helpers for the MARTA feed-capture scripts. Raw captures land under
// /data (gitignored) so we keep a debuggable history of exactly what the feeds
// returned, separate from the trimmed fixtures committed under test/marta.
const Fs = require('node:fs');
const Path = require('node:path');

const CAPTURE_DIR = Path.join(__dirname, '..', '..', 'data', 'marta', 'captures');

// Filesystem-safe UTC stamp: 2026-06-13T19-17-09Z
function stamp(d = new Date()) {
  return d
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\.\d+Z$/, 'Z');
}

// Write `buf` to data/marta/captures/<name>-<stamp><ext> and refresh a stable
// <name>-latest<ext> copy so tooling can always find the newest without
// listing. Returns the timestamped path.
function saveCapture(name, ext, buf) {
  Fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  const tsPath = Path.join(CAPTURE_DIR, `${name}-${stamp()}${ext}`);
  Fs.writeFileSync(tsPath, buf);
  Fs.writeFileSync(Path.join(CAPTURE_DIR, `${name}-latest${ext}`), buf);
  return tsPath;
}

module.exports = { CAPTURE_DIR, saveCapture, stamp };
