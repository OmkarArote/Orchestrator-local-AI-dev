'use strict';
// Content sniffing for uploads (M6). The type of a file is decided ONLY from its bytes: the client's Content-Type and file extension are never trusted.
// Pure functions over Buffers / an open file descriptor. Nothing here inflates, decodes or executes content:
// zip archives are classified from their central directory (names + declared sizes) and never extracted.
const fs = require('node:fs');

const HEAD_BYTES = 4096;
const MAX_MEGAPIXELS = 50;               // decompression-bomb guard for images (declared dimensions)
const ZIP_MAX_ENTRIES = 2000;
const ZIP_MAX_CD_BYTES = 4 * 1048576;
const ZIP_MAX_ENTRY_BYTES = 20 * 1048576;   // declared uncompressed size of one entry
const ZIP_MAX_TOTAL_BYTES = 100 * 1048576;  // declared uncompressed total
const ZIP_MAX_RATIO = 100;                  // declared uncompressed / compressed (only enforced above 1 MiB total)

class Reject extends Error { constructor(code, message, status = 415) { super(message); this.code = code; this.status = status; } }

const eq = (b, off, bytes) => b.length >= off + bytes.length && bytes.every((x, i) => b[off + i] === x);
const ascii = (b, off, s) => b.length >= off + s.length && b.toString('latin1', off, off + s.length) === s;

// ---- formats that are never accepted (executables, archives, scripts-in-disguise)
const FORBIDDEN = [
  ['elf', (b) => eq(b, 0, [0x7f, 0x45, 0x4c, 0x46])],
  ['mach-o', (b) => eq(b, 0, [0xfe, 0xed, 0xfa, 0xce]) || eq(b, 0, [0xfe, 0xed, 0xfa, 0xcf]) || eq(b, 0, [0xce, 0xfa, 0xed, 0xfe]) || eq(b, 0, [0xcf, 0xfa, 0xed, 0xfe]) || eq(b, 0, [0xca, 0xfe, 0xba, 0xbe])],
  ['windows-executable', (b) => eq(b, 0, [0x4d, 0x5a])],
  ['gzip', (b) => eq(b, 0, [0x1f, 0x8b])],
  ['bzip2', (b) => ascii(b, 0, 'BZh')],
  ['xz', (b) => eq(b, 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])],
  ['7z', (b) => eq(b, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])],
  ['rar', (b) => ascii(b, 0, 'Rar!')],
  ['zstd', (b) => eq(b, 0, [0x28, 0xb5, 0x2f, 0xfd])],
  ['tar', (b) => ascii(b, 257, 'ustar')],
  ['shell-script', (b) => ascii(b, 0, '#!')],
];

/** binary formats recognised by magic bytes. Returns {ext, kind, mime, ...} or null. */
function sniffBinary(b) {
  if (eq(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: 'png', kind: 'image', mime: 'image/png' };
  if (eq(b, 0, [0xff, 0xd8, 0xff])) return { ext: 'jpg', kind: 'image', mime: 'image/jpeg' };
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return { ext: 'gif', kind: 'image', mime: 'image/gif' };
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return { ext: 'webp', kind: 'image', mime: 'image/webp' };
  if (ascii(b, 0, '%PDF-')) return { ext: 'pdf', kind: 'document', mime: 'application/pdf' };
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE')) return { ext: 'wav', kind: 'audio', mime: 'audio/wav' };
  if (ascii(b, 0, 'OggS')) return { ext: 'ogg', kind: 'audio', mime: 'audio/ogg' };
  if (ascii(b, 0, 'fLaC')) return { ext: 'flac', kind: 'audio', mime: 'audio/flac' };
  if (ascii(b, 0, 'FORM') && (ascii(b, 8, 'AIFF') || ascii(b, 8, 'AIFC'))) return { ext: 'aiff', kind: 'audio', mime: 'audio/aiff' };
  if (ascii(b, 0, 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { ext: 'mp3', kind: 'audio', mime: 'audio/mpeg' };
  if (eq(b, 0, [0x1a, 0x45, 0xdf, 0xa3])) return { ext: 'webm', kind: 'video', mime: 'video/webm' }; // matroska / webm
  if (ascii(b, 4, 'ftyp')) {
    const brand = b.toString('latin1', 8, 12);
    if (brand === 'M4A ' || brand === 'M4B ') return { ext: 'm4a', kind: 'audio', mime: 'audio/mp4' };
    if (brand === 'qt  ') return { ext: 'mov', kind: 'video', mime: 'video/quicktime' };
    return { ext: 'mp4', kind: 'video', mime: 'video/mp4' };
  }
  return null;
}

const hasBom16 = (b) => (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)));

/** text decoding check on a whole buffer (callers pass at most the text cap). Returns {encoding} or null when it is not text. */
function sniffText(buf) {
  const sample = buf.subarray(0, 8192);
  if (hasBom16(buf)) {
    // UTF-16 text: must decode without errors; NULs are legitimate there
    try { new TextDecoder(buf[0] === 0xff ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(buf); return { encoding: buf[0] === 0xff ? 'utf-16le' : 'utf-16be' }; } catch { return null; }
  }
  if (sample.includes(0)) return null;
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
  return { encoding: 'utf-8' };
}

/** SVG / script-capable markup is rejected: it can carry scripts and is served same-origin if ever shown. */
function looksLikeSvg(text) {
  const t = text.slice(0, 2048).replace(/^\uFEFF/, '').trimStart().toLowerCase();
  return t.startsWith('<svg') || (t.startsWith('<?xml') && t.includes('<svg')) || (t.startsWith('<!doctype svg')) ;
}

// ---- images: declared dimensions
function pngDims(b) { return b.length >= 24 && ascii(b, 12, 'IHDR') ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null; }
function gifDims(b) { return b.length >= 10 ? { width: b.readUInt16LE(6), height: b.readUInt16LE(8) } : null; }
function webpDims(b) {
  if (b.length < 30) return null;
  const f = b.toString('latin1', 12, 16);
  if (f === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (f === 'VP8L') { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
  if (f === 'VP8X') return { width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1, height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1 };
  return null;
}
function jpegInfo(b) {
  let i = 2; let exif = false;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    if (m === 0xd9 || m === 0xda) break;
    const len = b.readUInt16BE(i + 2);
    if (m === 0xe1 && ascii(b, i + 4, 'Exif\0\0')) exif = true;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (i + 9 > b.length) return null;
      return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5), has_exif: exif };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}
function imageInfo(ext, b) {
  const d = ext === 'png' ? pngDims(b) : ext === 'gif' ? gifDims(b) : ext === 'webp' ? webpDims(b) : jpegInfo(b);
  if (!d || !d.width || !d.height) throw new Reject('image_unreadable', 'cannot read the image dimensions (corrupt or truncated image)', 422);
  if ((d.width * d.height) / 1e6 > MAX_MEGAPIXELS) throw new Reject('image_too_large', `image is ${d.width}x${d.height} px; the limit is ${MAX_MEGAPIXELS} megapixels`, 413);
  return d;
}

// ---- zip (central directory only)
const ARCHIVE_EXT = /\.(zip|jar|war|apk|gz|tgz|bz2|xz|7z|rar|tar|zst|dmg|iso|docm|xlsm|pptm)$/i;
function zipList(fd, size) {
  const tailLen = Math.min(size, 65557);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let e = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Reject('zip_corrupt', 'zip archive without an end-of-central-directory record', 422);
  const disk = tail.readUInt16LE(e + 4), cdDisk = tail.readUInt16LE(e + 6), n = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
  if (disk !== 0 || cdDisk !== 0) throw new Reject('zip_multidisk', 'multi-disk zip archives are not supported', 422);
  if (n === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new Reject('zip64', 'zip64 archives are not supported', 422);
  if (n > ZIP_MAX_ENTRIES) throw new Reject('zip_entries', `archive has ${n} entries (limit ${ZIP_MAX_ENTRIES})`, 422);
  if (cdSize > ZIP_MAX_CD_BYTES || cdOff + cdSize > size) throw new Reject('zip_corrupt', 'zip central directory is out of bounds', 422);
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOff);
  const entries = []; let p = 0;
  for (let k = 0; k < n; k++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Reject('zip_corrupt', 'zip central directory is malformed', 422);
    const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
    const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
    if (p + 46 + nl > cd.length) throw new Reject('zip_corrupt', 'zip central directory is malformed', 422);
    const name = cd.toString('utf8', p + 46, p + 46 + nl);
    entries.push({ name, flags, method, csize, usize });
    p += 46 + nl + xl + cl;
  }
  return entries;
}
const unsafeName = (n) => n.includes('\0') || n.startsWith('/') || n.startsWith('\\') || /^[a-zA-Z]:/.test(n) || n.split(/[\\/]/).includes('..');

/** classify a zip as an office/ebook container or reject it; never inflates anything. */
function zipInfo(fd, size) {
  const entries = zipList(fd, size);
  let total = 0, ctotal = 0;
  const names = new Set();
  for (const en of entries) {
    if (unsafeName(en.name)) throw new Reject('zip_unsafe_name', 'archive contains an unsafe entry name (path traversal)', 422);
    if (en.flags & 1) throw new Reject('zip_encrypted', 'encrypted archives are not supported', 422);
    if (ARCHIVE_EXT.test(en.name)) throw new Reject('zip_nested', 'archives that contain archives are not accepted', 422);
    if (en.usize > ZIP_MAX_ENTRY_BYTES) throw new Reject('zip_bomb', `an archive entry declares ${en.usize} bytes uncompressed (limit ${ZIP_MAX_ENTRY_BYTES})`, 422);
    total += en.usize; ctotal += en.csize;
    names.add(en.name);
  }
  if (total > ZIP_MAX_TOTAL_BYTES) throw new Reject('zip_bomb', `archive declares ${total} bytes uncompressed (limit ${ZIP_MAX_TOTAL_BYTES})`, 422);
  if (total > 1048576 && total / Math.max(1, ctotal) > ZIP_MAX_RATIO) throw new Reject('zip_bomb', `archive compression ratio is above ${ZIP_MAX_RATIO}:1`, 422);
  const has = (n) => names.has(n);
  const any = (re) => entries.some((en) => re.test(en.name));
  const meta = { entries: entries.length, uncompressed: total, has_macros: any(/(^|\/)vbaProject\.bin$/i) };
  if (has('[Content_Types].xml') && has('word/document.xml')) return { ext: 'docx', kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', meta };
  if (has('[Content_Types].xml') && has('xl/workbook.xml')) return { ext: 'xlsx', kind: 'data', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', meta };
  if (has('[Content_Types].xml') && has('ppt/presentation.xml')) return { ext: 'pptx', kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', meta };
  if (has('mimetype') && has('META-INF/container.xml')) return { ext: 'epub', kind: 'document', mime: 'application/epub+zip', meta };
  if (has('mimetype') && has('content.xml')) return { ext: 'odf', kind: 'document', mime: 'application/vnd.oasis.opendocument', meta };
  throw new Reject('zip_generic', 'generic zip archives are not accepted (only Office, OpenDocument and EPUB containers)', 415);
}

/**
 * Decide what an uploaded file is. `fd` is the stored temp file, `head` its first HEAD_BYTES, `name` the (untrusted, only used to pick csv/tsv/json among text files).
 * Returns {ext, kind, mime, meta} or throws Reject.
 */
function classify({ fd, size, head, name = '', textCap = 5 * 1048576 }) {
  if (!size) throw new Reject('empty', 'the file is empty', 400);
  for (const [label, test] of FORBIDDEN) if (test(head)) throw new Reject('forbidden_type', `${label} files are not accepted`, 415);
  // UTF-16 text with a BOM must be recognised before the MP3 frame-sync heuristic (0xFF 0xFE looks like a frame sync)
  const bin = hasBom16(head) ? null : sniffBinary(head);
  if (bin) {
    const meta = {};
    if (bin.kind === 'image') {
      const b = Buffer.alloc(Math.min(size, 2 * 1048576)); fs.readSync(fd, b, 0, b.length, 0);
      const d = imageInfo(bin.ext, b);
      meta.width = d.width; meta.height = d.height; if (d.has_exif) meta.has_exif = true;
    }
    return { ...bin, meta };
  }
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05) && (head[3] === 0x04 || head[3] === 0x06)) return zipInfo(fd, size);
  // everything else must be text
  if (size > textCap) throw new Reject('too_large', `text files are limited to ${textCap} bytes`, 413);
  const buf = Buffer.alloc(size); fs.readSync(fd, buf, 0, size, 0);
  const t = sniffText(buf);
  if (!t) throw new Reject('unknown_binary', 'unrecognised binary file (not an image, PDF, Office/EPUB document, audio, video or text)', 415);
  const text = buf.toString(t.encoding === 'utf-8' ? 'utf8' : t.encoding === 'utf-16le' ? 'utf16le' : 'latin1');
  if (looksLikeSvg(text)) throw new Reject('svg', 'SVG files are not accepted (they can carry scripts)', 415);
  const ext = (String(name).match(/\.([A-Za-z0-9]{1,8})$/) || [])[1]?.toLowerCase() || '';
  if (ext === 'csv' || ext === 'tsv') return { ext, kind: 'data', mime: ext === 'csv' ? 'text/csv' : 'text/tab-separated-values', meta: { encoding: t.encoding } };
  if (ext === 'json') { try { JSON.parse(text.replace(/^\uFEFF/, '')); return { ext, kind: 'data', mime: 'application/json', meta: { encoding: t.encoding } }; } catch { /* plain text then */ } }
  return { ext: 'txt', kind: 'text', mime: 'text/plain', meta: { encoding: t.encoding } };
}

/** the earliest cap check: what kind will this be, judging from the first bytes only (null = decide later). */
function earlyKind(head) {
  if (hasBom16(head)) return 'text';
  for (const [, test] of FORBIDDEN) if (test(head)) return null;
  const bin = sniffBinary(head);
  if (bin) return bin.kind;
  if (head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b) return 'document';
  return 'text';
}

module.exports = { classify, earlyKind, sniffBinary, sniffText, zipList, zipInfo, imageInfo, Reject, HEAD_BYTES, MAX_MEGAPIXELS, ZIP_MAX_ENTRIES, ZIP_MAX_ENTRY_BYTES, ZIP_MAX_TOTAL_BYTES, ZIP_MAX_RATIO };
