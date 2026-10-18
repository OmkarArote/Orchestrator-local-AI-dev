'use strict';
// Optional command-line tools for the media pipeline. Detection stays cheap (stat only).
// runTool() is the ONLY spawner of tesseract / ffmpeg / ffprobe / poppler / whisper / textutil / swiftc:
// argv arrays, a hard timeout, an output cap, and `nice` when it exists. A missing tool is reported, never installed.
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./proc');

const TOOLS = {
  tesseract: { bins: ['tesseract'], purpose: 'OCR for images and scanned PDFs', install: 'brew install tesseract' },
  pdftotext: { bins: ['pdftotext'], purpose: 'text from PDFs (poppler, preferred)', install: 'brew install poppler' },
  pdftoppm: { bins: ['pdftoppm'], purpose: 'render PDF pages to images (poppler)', install: 'brew install poppler' },
  ffmpeg: { bins: ['ffmpeg'], purpose: 'extract frames and audio from video, convert audio', install: 'brew install ffmpeg' },
  ffprobe: { bins: ['ffprobe'], purpose: 'media duration / stream info', install: 'brew install ffmpeg' },
  whisper: { bins: ['whisper-cli', 'whisper-cpp'], purpose: 'speech-to-text (optional; audio is detect-and-degrade without it)', install: 'brew install whisper-cpp (plus a ggml model file)' },
  textutil: { bins: ['textutil'], purpose: 'DOC/RTF/ODT to text (macOS built-in)', install: 'macOS only', platform: 'darwin' },
  swiftc: { bins: ['swiftc'], purpose: 'builds the optional PDFKit helper when poppler is absent (macOS)', install: 'xcode-select --install', platform: 'darwin' },
};

const searchDirs = () => [...new Set([...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean))];
function which(bin, dirs = searchDirs()) {
  for (const d of dirs) {
    const p = path.join(d, bin);
    try { const st = fs.statSync(p); if (st.isFile()) { fs.accessSync(p, fs.constants.X_OK); return p; } } catch { /* not here */ }
  }
  return null;
}

/** { name: {found, path, purpose, install, applicable} } for every optional tool. Cheap (stat calls only); safe to call per request. */
function detect(dirs) {
  const out = {};
  for (const [name, t] of Object.entries(TOOLS)) {
    const applicable = !t.platform || t.platform === process.platform;
    let found = null;
    if (applicable) for (const b of t.bins) { found = which(b, dirs); if (found) break; }
    out[name] = { found: !!found, path: found, purpose: t.purpose, install: t.install, applicable };
  }
  return out;
}

/**
 * Run one detected tool. `args` is an argv array (no shell). Resolves; never throws for a missing binary.
 * Returns { ok, code, text, timedOut, install, path }.
 */
async function runTool(name, args, { cwd, timeoutMs = 30000, maxBytes = 2 * 1048576 } = {}) {
  const spec = TOOLS[name];
  if (!spec) return { ok: false, code: 'unknown_tool', text: '', install: '' };
  const found = detect()[name];
  if (!found || !found.found || !found.path) return { ok: false, code: 'tool_missing', text: '', install: spec.install, path: null };
  const nice = which('nice');
  const cmd = nice || found.path;
  const argv = nice ? ['-n', '15', found.path, ...args] : args;
  const lines = [];
  let bytes = 0; let capped = false; let killer = null;
  const r = await run(cmd, argv, {
    cwd, timeoutMs, onSpawn: (kill) => { killer = kill; },
    onLine: (line) => {
      bytes += line.length + 1;
      if (bytes > maxBytes) { capped = true; if (killer) killer(); return; }
      lines.push(line);
    },
  });
  const text = lines.join('\n');
  const ok = r.code === 0 && !r.timedOut;
  return { ok, code: r.timedOut ? 'timeout' : (ok ? 'ok' : 'error'), text, timedOut: !!r.timedOut, capped, install: spec.install, path: found.path, exit: r.code };
}

/** Run an absolute binary we compiled ourselves (the PDFKit helper). Same caps as runTool. The path must sit inside `root`. */
async function runPath(absPath, args, { cwd, root, timeoutMs = 30000, maxBytes = 2 * 1048576 } = {}) {
  const pathMod = path;
  if (!absPath || !pathMod.isAbsolute(absPath)) return { ok: false, code: 'bad_path', text: '' };
  if (root && !absPath.startsWith(root.endsWith(pathMod.sep) ? root : root + pathMod.sep) && pathMod.dirname(absPath) !== root) return { ok: false, code: 'bad_path', text: '' };
  const lines = [];
  let bytes = 0; let killer = null;
  const r = await run(absPath, args, {
    cwd, timeoutMs, onSpawn: (kill) => { killer = kill; },
    onLine: (line) => {
      bytes += line.length + 1;
      if (bytes > maxBytes) { if (killer) killer(); return; }
      lines.push(line);
    },
  });
  return { ok: r.code === 0 && !r.timedOut, code: r.timedOut ? 'timeout' : 'ok', text: lines.join('\n'), timedOut: !!r.timedOut };
}

module.exports = { detect, which, TOOLS, runTool, runPath };
