'use strict';
// Detection of the optional command-line tools the media pipeline can use (M6: DETECT ONLY, nothing is spawned here).
// Later milestones add the extractors that run them (through lib/proc.js, argument arrays, hard timeouts). Everything degrades when a tool is absent.
const fs = require('node:fs');
const path = require('node:path');

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

module.exports = { detect, which, TOOLS };
