'use strict';
// Audio to 16 kHz mono, then whisper if the user already has the binary and a model file. Nothing is installed or downloaded.
const fs = require('node:fs');
const path = require('node:path');
const media = require('../media-tools');
const lane = require('./lane');
const { withScratch } = require('./scratch');

const MAX_SECONDS = 60 * 60;
const INSTALL = 'brew install whisper-cpp';
const MODEL_HINT = 'Point ORCH_WHISPER_MODEL at a ggml file you already have. Nothing is downloaded.';

function inside(file, root) {
  const f = path.resolve(file), r = path.resolve(root);
  return f === r || f.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

async function durationSeconds(file, cwd) {
  const r = await media.runTool('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { cwd, timeoutMs: 20000, maxBytes: 4096 });
  const n = Number(String(r.text || '').trim());
  return Number.isFinite(n) ? n : null;
}

async function extract(file, { scratchParent, root, timeoutMs = 120000 } = {}) {
  if (!root || !inside(file, root)) return { status: 'error', tool: 'ffmpeg', reason: 'input is outside the attachments directory' };
  if (!media.detect().ffmpeg.found) return { status: 'tool_missing', tool: 'ffmpeg', reason: 'ffmpeg is not installed', install: 'brew install ffmpeg' };
  return lane.occupy(() => withScratch(scratchParent, async (dir) => {
    const seconds = await durationSeconds(file, dir);
    if (seconds != null && seconds > MAX_SECONDS) return { status: 'error', tool: 'ffmpeg', reason: `audio is longer than ${MAX_SECONDS / 60} minutes` };
    const wav = path.join(dir, 'speech.wav');
    const ff = await media.runTool('ffmpeg', ['-nostdin', '-protocol_whitelist', 'file', '-i', file, '-vn', '-ac', '1', '-ar', '16000', wav], { cwd: dir, timeoutMs: 60000, maxBytes: 65536 });
    if (!ff.ok) return { status: ff.code === 'tool_missing' ? 'tool_missing' : 'error', tool: 'ffmpeg', reason: ff.timedOut ? 'timeout' : 'could not extract audio', install: ff.install || '' };
    if (!media.detect().whisper.found || !process.env.ORCH_WHISPER_MODEL || !fs.existsSync(process.env.ORCH_WHISPER_MODEL)) {
      return { status: 'tool_missing', tool: 'whisper', reason: 'transcriber not installed', install: `${INSTALL}. ${MODEL_HINT}` };
    }
    const wr = await media.runTool('whisper', ['-m', process.env.ORCH_WHISPER_MODEL, '-f', wav, '-nt'], { cwd: dir, timeoutMs, maxBytes: 2 * 1048576 });
    if (wr.code === 'timeout') return { status: 'error', tool: 'whisper', reason: 'timeout' };
    if (!wr.ok && !wr.text) return { status: 'error', tool: 'whisper', reason: 'whisper failed', install: INSTALL };
    const text = String(wr.text || '').trim();
    if (!text) return { status: 'unsupported', tool: 'whisper', reason: 'no speech recognised' };
    return { status: 'ok', kind: 'transcript', tool: 'whisper', text };
  }));
}

module.exports = { extract, MAX_SECONDS, INSTALL, MODEL_HINT, inside };
