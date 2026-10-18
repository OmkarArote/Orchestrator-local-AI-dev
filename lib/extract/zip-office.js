'use strict';
// Office / EPUB / ODT text from the zip central directory. Entries are inflated in memory with a hard output cap
// and never written to disk. vbaProject.bin is skipped and flagged.
const fs = require('node:fs');
const zlib = require('node:zlib');
const { MAX_CHARS } = require('./text');

const MAX_ENTRY = 20 * 1048576;
const MAX_TOTAL = 100 * 1048576;
const MAX_ENTRIES = 2000;
const MAX_RATIO = 100;

class ZipError extends Error { constructor(code, message) { super(message); this.code = code; } }

function inflate(method, comp, usize) {
  const cap = Math.min(MAX_ENTRY, Math.max(1, usize > 0 ? usize : MAX_ENTRY));
  if (method === 0) {
    if (comp.length > cap) throw new ZipError('zip_bomb', 'stored entry exceeds the output cap');
    return comp;
  }
  if (method !== 8) throw new ZipError('zip_method', `compression method ${method} is not supported`);
  let out;
  try { out = zlib.inflateRawSync(comp, { maxOutputLength: cap }); }
  catch (e) {
    if (e.code === 'ERR_BUFFER_TOO_LARGE') throw new ZipError('zip_bomb', 'inflated entry exceeds the output cap');
    throw new ZipError('zip_corrupt', 'deflate stream is corrupt');
  }
  if (comp.length > 1024 && out.length / comp.length > MAX_RATIO) throw new ZipError('zip_bomb', `entry compression ratio is above ${MAX_RATIO}:1`);
  return out;
}

function listAndRead(file, wanted) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new ZipError('zip_corrupt', 'no central directory');
    const n = tail.readUInt16LE(e + 10);
    const cdSize = tail.readUInt32LE(e + 12);
    const cdOff = tail.readUInt32LE(e + 16);
    if (n > MAX_ENTRIES) throw new ZipError('zip_entries', 'too many entries');
    if (cdOff + cdSize > size) throw new ZipError('zip_corrupt', 'central directory is out of bounds');
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const want = wanted ? new Set(wanted) : null;
    const out = []; let total = 0; let p = 0; let macros = false;
    for (let k = 0; k < n; k++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new ZipError('zip_corrupt', 'central directory is malformed');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nl = cd.readUInt16LE(p + 28);
      const xl = cd.readUInt16LE(p + 30);
      const cl = cd.readUInt16LE(p + 32);
      const localOff = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nl);
      p += 46 + nl + xl + cl;
      if (/(^|\/)vbaProject\.bin$/i.test(name)) { macros = true; continue; }
      if (name.endsWith('/')) continue;
      if (want && !want.has(name) && !wanted.some((w) => w instanceof RegExp && w.test(name))) continue;
      if (flags & 1) throw new ZipError('zip_encrypted', 'encrypted entry');
      if (name.split(/[\\/]/).includes('..')) throw new ZipError('zip_unsafe_name', name);
      const lh = Buffer.alloc(30);
      if (localOff + 30 > size) throw new ZipError('zip_corrupt', 'local header is out of bounds');
      fs.readSync(fd, lh, 0, 30, localOff);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new ZipError('zip_corrupt', 'bad local header');
      const ln = lh.readUInt16LE(26); const le = lh.readUInt16LE(28);
      const dataOff = localOff + 30 + ln + le;
      if (csize > MAX_ENTRY || dataOff + csize > size) throw new ZipError('zip_bomb', 'compressed entry is too large');
      const comp = Buffer.alloc(csize);
      fs.readSync(fd, comp, 0, csize, dataOff);
      const data = inflate(method, comp, usize);
      total += data.length;
      if (total > MAX_TOTAL) throw new ZipError('zip_bomb', 'uncompressed total exceeds the cap');
      out.push({ name, data });
    }
    return { entries: out, macros };
  } finally { fs.closeSync(fd); }
}

function xmlTexts(xml, tags) {
  if (/<!ENTITY/i.test(xml)) throw new ZipError('xml_entity', 'XML entity declarations are not expanded');
  const parts = [];
  for (const tag of tags) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
    let m;
    while ((m = re.exec(xml))) {
      parts.push(m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))));
      if (parts.join('\n').length > MAX_CHARS) return { text: parts.join('\n').slice(0, MAX_CHARS), truncated: true };
    }
  }
  return { text: parts.join('\n'), truncated: false };
}

function extract(file, ext) {
  const re = {
    docx: [/^word\/document\.xml$/, /^word\/header\d*\.xml$/, /^word\/footer\d*\.xml$/],
    pptx: [/^ppt\/slides\/slide\d+\.xml$/],
    xlsx: [/^xl\/sharedStrings\.xml$/, /^xl\/worksheets\/sheet\d+\.xml$/],
    epub: [/\.x?html?$/i],
    odf: [/^content\.xml$/],
  }[ext];
  if (!re) throw new ZipError('unsupported', `no office reader for .${ext}`);
  const { entries, macros } = listAndRead(file, re);
  let text = ''; let truncated = false;
  if (ext === 'xlsx') text = xlsxText(entries);
  else if (ext === 'epub') {
    const html = require('./html');
    text = entries.map((en) => html.toText(en.data.toString('utf8')).text).filter(Boolean).join('\n\n');
  } else {
    const tags = ext === 'docx' ? ['w:t'] : ext === 'pptx' ? ['a:t'] : ['text:p', 'text:h'];
    const chunks = [];
    for (const en of entries) {
      const r = xmlTexts(en.data.toString('utf8'), tags);
      chunks.push(r.text);
      if (r.truncated) truncated = true;
    }
    text = chunks.filter(Boolean).join('\n');
  }
  if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); truncated = true; }
  if (macros) text = `[macros present; not executed]\n${text}`;
  return { text: text.trim(), truncated, macros, empty: !text.trim() };
}

function xlsxText(entries) {
  const shared = [];
  const ss = entries.find((e) => e.name === 'xl/sharedStrings.xml');
  if (ss) {
    const xml = ss.data.toString('utf8');
    if (/<!ENTITY/i.test(xml)) throw new ZipError('xml_entity', 'XML entity declarations are not expanded');
    const re = /<si\b[^>]*>([\s\S]*?)<\/si>/gi;
    let m;
    while ((m = re.exec(xml))) shared.push(m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<'));
  }
  const lines = [`shared strings: ${shared.length}`];
  let rows = 0; let shown = 0;
  for (const en of entries.filter((e) => /sheet\d+\.xml$/.test(e.name))) {
    lines.push(`# ${en.name}`);
    const xml = en.data.toString('utf8');
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/gi;
    let rm;
    while ((rm = rowRe.exec(xml))) {
      rows++;
      if (shown >= 20) continue;
      const cells = [];
      const cre = /<c\b([^>]*)>([\s\S]*?)<\/c>/gi;
      let cm;
      while ((cm = cre.exec(rm[1]))) {
        const t = /t="([^"]+)"/.exec(cm[1]);
        const v = /<v>([\s\S]*?)<\/v>/.exec(cm[2]);
        let val = v ? v[1] : '';
        if (t && t[1] === 's') val = shared[Number(val)] || '';
        else if (t && t[1] === 'inlineStr') val = (cm[2].match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '';
        cells.push(String(val).replace(/\s+/g, ' ').slice(0, 80));
      }
      lines.push(cells.join(' | '));
      shown++;
    }
  }
  lines.splice(1, 0, `rows: ${rows}`);
  if (rows > 20) lines.push(`… ${rows - 20} further rows omitted`);
  return lines.join('\n');
}

module.exports = { extract, listAndRead, inflate, ZipError, MAX_ENTRY };
