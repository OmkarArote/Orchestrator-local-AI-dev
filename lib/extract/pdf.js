'use strict';
// PDF text. Prefer poppler (`pdftotext -layout`). Otherwise the cached PDFKit helper (macOS, swiftc, once).
// Otherwise a labelled low-fidelity scan of literal Tj strings. Page cap 200. Nothing is rendered.
const fs = require('node:fs');
const path = require('node:path');
const media = require('../media-tools');
const { withScratch } = require('./scratch');
const { MAX_CHARS } = require('./text');

const PAGE_CAP = 200;
const INSTALL = 'brew install poppler';

const SWIFT = `import Foundation
import PDFKit
let args = CommandLine.arguments
if args.count < 2 { fputs("path required\\n", stderr); exit(2) }
let url = URL(fileURLWithPath: args[1])
guard let doc = PDFDocument(url: url) else { fputs("unreadable\\n", stderr); exit(3) }
let n = min(doc.pageCount, ${PAGE_CAP})
var parts: [String] = []
for i in 0..<n {
  if let page = doc.page(at: i), let s = page.string, !s.isEmpty { parts.append(s) }
}
print(parts.joined(separator: "\\n"))
`;

function lowFi(buf) {
  const s = buf.toString('latin1');
  const end = s.indexOf('%%EOF');
  const body = end >= 0 ? s.slice(0, end) : s;
  const parts = [];
  const re = /\(((?:\\\)|\\.|[^\\)])*)\)\s*Tj/g;
  let m; let pages = 0;
  const pageRe = /\/Type\s*\/Page(?!s)/g;
  while (pageRe.exec(body)) pages++;
  while ((m = re.exec(body))) {
    parts.push(m[1].replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\([()\\])/g, '$1'));
    if (parts.join('\n').length > MAX_CHARS) break;
  }
  let text = parts.join('\n').trim();
  const truncated = text.length > MAX_CHARS || pages > PAGE_CAP;
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);
  return { text, truncated, pages };
}

async function pdfKit(file, binDir, scratchParent) {
  const bin = path.join(binDir, 'pdfkit-text');
  return withScratch(scratchParent, async (dir) => {
    if (!fs.existsSync(bin)) {
      fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
      const src = path.join(dir, 'pdfkit.swift');
      fs.writeFileSync(src, SWIFT, { mode: 0o600 });
      const compiled = await media.runTool('swiftc', ['-O', '-o', bin, src], { cwd: dir, timeoutMs: 90000, maxBytes: 200000 });
      if (!compiled.ok) return { ok: false, install: compiled.install, error: compiled.text || 'swiftc failed' };
      try { fs.chmodSync(bin, 0o700); } catch { /* best effort */ }
    }
    const out = await media.runPath(bin, [file], { cwd: dir, root: binDir, timeoutMs: 30000, maxBytes: 2 * 1048576 });
    if (!out.ok) return { ok: false, error: 'pdfkit helper failed' };
    return { ok: true, text: out.text };
  });
}

async function extract(file, { binDir, scratchParent } = {}) {
  const buf = fs.readFileSync(file);
  const pop = await media.runTool('pdftotext', ['-layout', '-f', '1', '-l', String(PAGE_CAP), '-enc', 'UTF-8', file, '-'], { cwd: scratchParent, timeoutMs: 60000, maxBytes: 2 * 1048576 });
  if (pop.code !== 'tool_missing') {
    if (pop.ok && pop.text.trim()) {
      let text = pop.text.trim();
      const truncated = pop.capped || text.length > MAX_CHARS;
      if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);
      return { status: 'ok', tool: 'pdftotext', text, truncated, fidelity: 'poppler' };
    }
    if (!pop.ok && pop.code !== 'tool_missing') return { status: 'error', tool: 'pdftotext', reason: pop.timedOut ? 'timeout' : 'pdftotext failed', install: INSTALL };
  }
  const swift = media.detect().swiftc;
  const worthKit = buf.includes(Buffer.from('/Font')) || buf.length > 2048;
  if (swift && swift.found && worthKit && binDir && scratchParent) {
    const kit = await pdfKit(file, binDir, scratchParent);
    if (kit.ok && kit.text && kit.text.trim()) {
      let text = kit.text.trim();
      const truncated = text.length > MAX_CHARS;
      if (truncated) text = text.slice(0, MAX_CHARS);
      return { status: 'ok', tool: 'pdfkit', text, truncated, fidelity: 'pdfkit' };
    }
  }
  const low = lowFi(buf);
  if (low.text) return { status: 'ok', tool: 'lowfi', text: `[low fidelity]\n${low.text}`, truncated: low.truncated, fidelity: 'low' };
  return { status: 'tool_missing', tool: 'pdftotext', reason: 'no text layer found; install poppler for reliable PDF text', install: INSTALL };
}

module.exports = { extract, lowFi, PAGE_CAP, INSTALL };
