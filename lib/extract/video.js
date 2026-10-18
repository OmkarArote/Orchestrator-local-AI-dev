'use strict';
// Video: up to 16 frames (scene change plus a uniform sample), 768px, metadata stripped. No model is downloaded.
const path = require('node:path');
const media = require('../media-tools');
const lane = require('./lane');
const { withScratch } = require('./scratch');
const { inside } = require('./audio');

const MAX_SECONDS = 10 * 60;
const MAX_FRAMES = 16;

async function durationSeconds(file, cwd) {
  const r = await media.runTool('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { cwd, timeoutMs: 20000, maxBytes: 4096 });
  const n = Number(String(r.text || '').trim());
  return Number.isFinite(n) ? n : null;
}

function frameArgs(file, filter, count, pattern) {
  return ['-nostdin', '-protocol_whitelist', 'file', '-i', file, '-vf', filter, '-frames:v', String(count), '-map_metadata', '-1', pattern];
}

async function extract(file, { scratchParent, root } = {}) {
  if (!root || !inside(file, root)) return { status: 'error', tool: 'ffmpeg', reason: 'input is outside the attachments directory' };
  if (!media.detect().ffmpeg.found) return { status: 'tool_missing', tool: 'ffmpeg', reason: 'ffmpeg is not installed', install: 'brew install ffmpeg' };
  return lane.occupy(() => withScratch(scratchParent, async (dir) => {
    const seconds = await durationSeconds(file, dir);
    if (seconds != null && seconds > MAX_SECONDS) return { status: 'error', tool: 'ffmpeg', reason: `video is longer than ${MAX_SECONDS / 60} minutes` };
    const half = MAX_FRAMES / 2;
    const scale = 'scale=768:768:force_original_aspect_ratio=decrease';
    await media.runTool('ffmpeg', frameArgs(file, `select='gt(scene,0.4)',${scale}`, half, path.join(dir, 'scene-%02d.jpg')), { cwd: dir, timeoutMs: 60000, maxBytes: 65536 });
    await media.runTool('ffmpeg', frameArgs(file, `fps=1,${scale}`, half, path.join(dir, 'uniform-%02d.jpg')), { cwd: dir, timeoutMs: 60000, maxBytes: 65536 });
    const fs = require('node:fs');
    const frames = fs.readdirSync(dir).filter((n) => n.endsWith('.jpg'));
    if (!frames.length) return { status: 'unsupported', tool: 'ffmpeg', reason: 'no frames extracted' };
    const lines = frames.slice(0, MAX_FRAMES).map((n, i) => `frame ${i + 1}: ${n} (768px, metadata stripped)`);
    return { status: 'ok', kind: 'summary', tool: 'ffmpeg', text: lines.join('\n'), frames: frames.length };
  }));
}

module.exports = { extract, MAX_SECONDS, MAX_FRAMES };
