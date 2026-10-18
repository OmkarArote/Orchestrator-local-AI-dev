'use strict';
// Image OCR via tesseract. Missing binary -> tool_missing plus the install hint. No extra languages are installed.
const fs = require('node:fs');
const path = require('node:path');
const media = require('../media-tools');
const { withScratch } = require('./scratch');
const { MAX_CHARS } = require('./text');

const INSTALL = 'brew install tesseract';

function confidence(tsv) {
  const nums = [];
  for (const line of String(tsv).split('\n').slice(1)) {
    const cols = line.split('\t');
    if (cols.length < 12) continue;
    const conf = Number(cols[10]);
    const word = cols[11];
    if (word && Number.isFinite(conf) && conf >= 0) nums.push(conf);
  }
  if (!nums.length) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

async function extract(file, { scratchParent } = {}) {
  const found = media.detect().tesseract;
  if (!found || !found.found) return { status: 'tool_missing', tool: 'tesseract', reason: 'OCR tool is not installed', install: INSTALL };
  if (!scratchParent) return { status: 'error', tool: 'tesseract', reason: 'no scratch directory' };
  return withScratch(scratchParent, async (dir) => {
    const r = await media.runTool('tesseract', [file, 'stdout', 'tsv'], { cwd: dir, timeoutMs: 60000, maxBytes: 2 * 1048576 });
    if (r.code === 'tool_missing') return { status: 'tool_missing', tool: 'tesseract', reason: 'OCR tool is not installed', install: INSTALL };
    if (!r.ok && !r.text) return { status: 'error', tool: 'tesseract', reason: r.timedOut ? 'timeout' : 'tesseract failed', install: INSTALL };
    const words = [];
    for (const line of r.text.split('\n').slice(1)) {
      const cols = line.split('\t');
      if (cols.length >= 12 && cols[11]) words.push(cols[11]);
    }
    let text = words.join(' ').replace(/\s+/g, ' ').trim();
    const truncated = r.capped || text.length > MAX_CHARS;
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);
    if (!text) return { status: 'unsupported', kind: 'ocr', tool: 'tesseract', reason: 'no text recognised', install: INSTALL, confidence: confidence(r.text) };
    return { status: 'ok', kind: 'ocr', tool: 'tesseract', text, truncated, confidence: confidence(r.text) };
  });
}

/** One JPEG for a vision model: longest side 768, metadata stripped. Missing ffmpeg returns tool_missing. Never downloads a model. */
async function prepareForVision(file, scratchDir) {
  const found = media.detect().ffmpeg;
  if (!found || !found.found) return { ok: false, code: 'tool_missing', install: 'brew install ffmpeg' };
  const out = path.join(scratchDir, 'vision.jpg');
  const r = await media.runTool('ffmpeg', ['-nostdin', '-protocol_whitelist', 'file', '-i', file, '-vf', 'scale=768:768:force_original_aspect_ratio=decrease', '-frames:v', '1', '-map_metadata', '-1', '-q:v', '5', out], { cwd: scratchDir, timeoutMs: 30000, maxBytes: 1048576 });
  if (!r.ok || !fs.existsSync(out)) return { ok: false, code: r.code || 'error', install: r.install || '' };
  const buf = fs.readFileSync(out);
  return { ok: true, base64: buf.toString('base64'), bytes: buf.length };
}

module.exports = { extract, confidence, prepareForVision, INSTALL };
