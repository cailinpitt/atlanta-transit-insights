const Fs = require('fs-extra');
const Os = require('node:os');
const Path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileP = promisify(execFile);

async function encodeFrames(
  frames,
  { prefix = 'marta-video', framerate = 16, holdSeconds = 1 } = {},
) {
  if (!frames || frames.length < 2) return null;
  const tmpDir = await Fs.mkdtemp(Path.join(Os.tmpdir(), `${prefix}-`));
  try {
    for (let i = 0; i < frames.length; i++) {
      await Fs.writeFile(Path.join(tmpDir, `frame_${String(i).padStart(3, '0')}.jpg`), frames[i]);
    }
    const holdFrames = Math.max(0, Math.round(framerate * holdSeconds));
    const lastIdx = frames.length - 1;
    const lastPath = Path.join(tmpDir, `frame_${String(lastIdx).padStart(3, '0')}.jpg`);
    for (let k = 1; k <= holdFrames; k++) {
      await Fs.copyFile(
        lastPath,
        Path.join(tmpDir, `frame_${String(lastIdx + k).padStart(3, '0')}.jpg`),
      );
    }

    const outPath = Path.join(tmpDir, 'out.mp4');
    await execFileP(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-framerate',
        String(framerate),
        '-i',
        Path.join(tmpDir, 'frame_%03d.jpg'),
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        outPath,
      ],
      { timeout: 60_000 },
    );
    return await Fs.readFile(outPath);
  } finally {
    await Fs.remove(tmpDir).catch(() => {});
  }
}

module.exports = { encodeFrames };
