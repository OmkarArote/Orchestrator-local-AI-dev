'use strict';
// Dispatcher by kind / extension. Tool-backed extractors degrade with tool_missing; they never install anything.
const fs = require('node:fs');
const text = require('./text');
const csv = require('./csv');
const html = require('./html');
const office = require('./zip-office');
const pdf = require('./pdf');
const image = require('./image');

const OFFICE = new Set(['docx', 'xlsx', 'pptx', 'epub', 'odf']);

async function run(att, file, { scratchParent, binDir } = {}) {
  const ext = att.ext || '';
  const name = att.orig_name || '';
  try {
    if (OFFICE.has(ext)) {
      const r = office.extract(file, ext);
      if (r.empty) return { status: 'unsupported', tool: 'zip-office', reason: `no text in .${ext}` };
      return { status: 'ok', kind: ext === 'xlsx' ? 'summary' : 'text', tool: 'zip-office', text: r.text, truncated: r.truncated };
    }
    if (ext === 'pdf' || att.mime === 'application/pdf') return pdf.extract(file, { binDir, scratchParent });
    if (att.kind === 'image') return image.extract(file, { scratchParent });
    if (att.kind === 'audio' || att.kind === 'video') return { status: 'unsupported', tool: 'builtin', reason: `no extractor for ${att.kind} yet` };
    if (att.kind === 'text' || att.kind === 'data') {
      const dec = text.fromFile(file, att.meta && att.meta.encoding);
      if (ext === 'csv' || ext === 'tsv') {
        const s = csv.summarise(dec.text, { sep: ext === 'tsv' ? '\t' : ',' });
        return { status: 'ok', kind: 'summary', tool: 'csv', text: s.text, truncated: s.truncated || dec.truncated };
      }
      if (html.looksLikeHtml(dec.text, name)) {
        const h = html.toText(dec.text);
        if (h.error) return { status: 'error', tool: 'html', reason: h.error };
        return { status: 'ok', kind: 'text', tool: 'html', text: h.text, truncated: h.truncated || dec.truncated };
      }
      return { status: 'ok', kind: 'text', tool: 'builtin', text: dec.text, truncated: dec.truncated };
    }
    return { status: 'unsupported', tool: 'builtin', reason: `no text extractor for .${ext}` };
  } catch (e) {
    return { status: 'error', tool: 'builtin', reason: e.code || e.message };
  }
}

function readHead(file) { return fs.readFileSync(file); }

module.exports = { run, readHead };
