'use strict';
// M6: attachment upload API, over HTTP against a real server (temp ORCH_DB, random port). Only synthetic bytes; no external tools needed.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { startServer } = require('./helpers/harness');
const M = require('./helpers/media-fixtures');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const walk = (d) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : [];

/** raw upload through node:http so every header is under test control. headers with value null are dropped. */
function up(S, body, { name, ct = 'application/octet-stream', headers = {}, chunked = false, pathname = '/api/attachments' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(S.url);
    const h = { 'Content-Type': ct, 'X-Orch-Upload': '1', ...(name !== undefined ? { 'X-Filename': encodeURIComponent(name) } : {}), ...headers };
    if (!chunked) h['Content-Length'] = body.length;
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    const r = http.request({ host: u.hostname, port: u.port, path: pathname, method: 'POST', headers: h }, (res) => {
      const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => { const text = Buffer.concat(parts).toString(); let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json, text }); });
    });
    r.on('error', reject);
    if (chunked) { r.write(body.subarray(0, Math.ceil(body.length / 2))); r.write(body.subarray(Math.ceil(body.length / 2))); r.end(); } else r.end(body);
  });
}

describe('M6 attachments API: sniffing, caps, dedupe, safety', () => {
  let S, ATT;
  before(async () => {
    S = await startServer({ env: { ORCH_UPLOAD_MAX_IMAGE_MB: '0.02', ORCH_UPLOAD_MAX_AUDIO_MB: '0.02', ORCH_UPLOAD_MAX_VIDEO_MB: '0.02', ORCH_UPLOAD_MAX_TEXT_MB: '0.01' } });
    ATT = path.join(S.base, 'data', 'attachments');
  });
  after(async () => { if (S) await S.stop(); });

  it('accepts and classifies every supported type from its bytes (client Content-Type is ignored)', async () => {
    const cases = [
      ['png', M.png(8, 6), 'image', 'image/png', { width: 8, height: 6 }], ['jpg', M.jpeg(9, 5, { exif: true }), 'image', 'image/jpeg', { width: 9, height: 5, has_exif: true }],
      ['gif', M.gif(3, 2), 'image', 'image/gif', { width: 3, height: 2 }], ['webp', M.webp(11, 7), 'image', 'image/webp', { width: 11, height: 7 }],
      ['pdf', M.pdf(), 'document', 'application/pdf'], ['docx', M.office('docx'), 'document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['xlsx', M.office('xlsx'), 'data', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['pptx', M.office('pptx'), 'document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      ['epub', M.office('epub'), 'document', 'application/epub+zip'], ['odf', M.office('odt'), 'document', 'application/vnd.oasis.opendocument'],
      ['wav', M.wav(), 'audio', 'audio/wav'], ['mp3', M.mp3(), 'audio', 'audio/mpeg'], ['ogg', M.ogg(), 'audio', 'audio/ogg'], ['flac', M.flac(), 'audio', 'audio/flac'], ['m4a', M.mp4('M4A '), 'audio', 'audio/mp4'],
      ['mp4', M.mp4(), 'video', 'video/mp4'], ['mov', M.mp4('qt  '), 'video', 'video/quicktime'], ['webm', M.webm(), 'video', 'video/webm'],
    ];
    for (const [ext, buf, kind, mime, meta] of cases) {
      const r = await up(S, buf, { name: `x.${ext}`, ct: 'text/html' }); // lying Content-Type header on purpose (only octet-stream is accepted at the gate, see below)
      assert.equal(r.status, 415, 'a non-octet-stream Content-Type is refused before anything is stored');
      const ok = await up(S, buf, { name: `x.${ext}` });
      assert.equal(ok.status, 201, `${ext}: ${ok.text}`);
      assert.equal(ok.json.kind, kind, ext); assert.equal(ok.json.mime, mime, ext); assert.equal(ok.json.ext, ext, ext);
      assert.equal(ok.json.sha256, sha(buf)); assert.equal(ok.json.size, buf.length);
      if (meta) for (const [k, v] of Object.entries(meta)) assert.equal(ok.json.meta[k], v, `${ext}.meta.${k}`);
      assert.ok(fs.existsSync(path.join(ATT, ok.json.sha256.slice(0, 2), ok.json.sha256)), 'blob stored under its hash');
    }
  });

  it('text: plain, utf-16 with BOM (not mistaken for mp3), csv/tsv/json refined by name only among text files', async () => {
    const t = await up(S, Buffer.from('héllo wörld\nline 2\n'), { name: 'notes.md' });
    assert.deepEqual([t.status, t.json.kind, t.json.mime], [201, 'text', 'text/plain']);
    const u16 = await up(S, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi there', 'utf16le')]), { name: 'u.txt' });
    assert.deepEqual([u16.status, u16.json.kind, u16.json.meta.encoding], [201, 'text', 'utf-16le']);
    const csv = await up(S, Buffer.from('a,b\n1,2\n'), { name: 'd.csv' });
    assert.deepEqual([csv.status, csv.json.kind, csv.json.mime], [201, 'data', 'text/csv']);
    const tsv = await up(S, Buffer.from('a\tb\n1\t2\n'), { name: 'd.tsv' });
    assert.deepEqual([tsv.status, tsv.json.kind], [201, 'data']);
    const json = await up(S, Buffer.from('{"a":1}'), { name: 'd.json' });
    assert.deepEqual([json.status, json.json.kind, json.json.mime], [201, 'data', 'application/json']);
    const badJson = await up(S, Buffer.from('{not json'), { name: 'd.json' });
    assert.deepEqual([badJson.status, badJson.json.kind], [201, 'text'], 'invalid json is just text');
    const csvName = await up(S, M.png(), { name: 'sneaky.csv' });
    assert.equal(csvName.json.kind, 'image', 'the extension never overrides the bytes');
  });

  it('MIME / extension spoofing: the bytes win, executables and look-alikes are rejected whatever they are called', async () => {
    const pngAsPdf = await up(S, M.png(5, 5, 7), { name: 'invoice.pdf' });
    assert.deepEqual([pngAsPdf.status, pngAsPdf.json.kind, pngAsPdf.json.mime, pngAsPdf.json.ext], [201, 'image', 'image/png', 'png']);
    for (const [label, buf, name] of [['elf', M.elf(), 'photo.png'], ['mach-o', M.macho(), 'doc.pdf'], ['exe', M.pe(), 'cat.jpg'], ['gzip', M.gzip(), 'notes.txt'],
      ['script', Buffer.from('#!/bin/sh\necho hi\n'), 'readme.txt'], ['svg', Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'logo.png'],
      ['svg2', Buffer.from('<svg onload="x()"></svg>'), 'a.png'], ['binary', crypto.randomBytes(2000).fill(0, 0, 8), 'x.txt']]) {
      const r = await up(S, buf, { name });
      assert.ok(r.status === 415, `${label} -> ${r.status} ${r.text}`);
      assert.ok(r.json.error && r.json.code, label);
    }
    assert.equal((await up(S, Buffer.from('MZ' + 'x'.repeat(50)), { name: 'plain.txt' })).status, 415, 'even a text-looking MZ header is an executable header');
    const generic = await up(S, M.zip([{ name: 'a.txt', data: Buffer.from('a') }]), { name: 'a.docx' });
    assert.deepEqual([generic.status, generic.json.code], [415, 'zip_generic']);
    assert.equal(S.child.exitCode, null, 'the server is still up');
  });

  it('gate: Content-Type, the X-Orch-Upload header, Origin and Host are all enforced; chunked / empty / garbage lengths are refused', async () => {
    const png = M.png(4, 4, 99); // unique bytes so the successful upload below is not a dedupe hit
    assert.equal((await up(S, png, { headers: { 'X-Orch-Upload': null } })).status, 403);
    assert.equal((await up(S, png, { headers: { 'X-Orch-Upload': '0' } })).status, 403);
    assert.equal((await up(S, png, { ct: 'application/json' })).status, 415);
    assert.equal((await up(S, png, { ct: 'text/plain' })).status, 415);
    assert.equal((await up(S, png, { headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await up(S, png, { headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await up(S, png, { headers: { Origin: S.url } })).status, 201, 'same-origin Origin is fine');
    const ch = await up(S, png, { chunked: true });
    assert.deepEqual([ch.status, ch.json.code], [411, 'length_required']);
    const empty = await up(S, Buffer.alloc(0));
    assert.deepEqual([empty.status, empty.json.code], [400, 'empty']);
    // routes other than the upload still demand JSON
    const r = await S.raw('POST', '/api/attachments/gc', undefined, { 'Content-Type': 'application/octet-stream' });
    assert.equal(r.status, 415);
    // no CORS grant: a preflight gets no Access-Control-Allow-* headers
    const pre = await fetch(S.url + '/api/attachments', { method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-orch-upload' } });
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
    assert.equal(pre.headers.get('access-control-allow-headers'), null);
  });

  it('caps: per-kind byte limits are enforced up front (413) and nothing is stored', async () => {
    const before = walk(ATT).length;
    const bigImg = await up(S, M.png(4, 4, 30000), { name: 'big.png' });
    assert.deepEqual([bigImg.status, bigImg.json.code, bigImg.json.kind], [413, 'too_large', 'image']);
    const bigAudio = await up(S, Buffer.concat([M.wav(), Buffer.alloc(30000)]), { name: 'big.wav' });
    assert.deepEqual([bigAudio.status, bigAudio.json.kind], [413, 'audio']);
    const bigVideo = await up(S, Buffer.concat([M.mp4(), Buffer.alloc(30000)]), { name: 'big.mp4' });
    assert.deepEqual([bigVideo.status, bigVideo.json.kind], [413, 'video']);
    const bigText = await up(S, Buffer.from('x'.repeat(20000)), { name: 'big.txt' });
    assert.equal(bigText.status, 413);
    assert.equal(walk(ATT).length, before, 'rejected uploads leave no file behind (not even in tmp/)');
    assert.deepEqual(walk(path.join(ATT, 'tmp')), []);
  });

  it('image dimension guard: a tiny file that DECLARES a huge picture is rejected (decompression bomb), corrupt headers too', async () => {
    const bomb = await up(S, M.png(60000, 60000), { name: 'bomb.png' });
    assert.deepEqual([bomb.status, bomb.json.code], [413, 'image_too_large']);
    const bombJ = await up(S, M.jpeg(30000, 30000), { name: 'bomb.jpg' });
    assert.deepEqual([bombJ.status, bombJ.json.code], [413, 'image_too_large']);
    const trunc = await up(S, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), { name: 't.png' });
    assert.deepEqual([trunc.status, trunc.json.code], [422, 'image_unreadable']);
  });

  it('zip safety: bombs (huge declared sizes / ratio / entry count), traversal names, nested archives, encryption are rejected without inflating anything', async () => {
    const t0 = Date.now();
    const cases = [
      ['entry too big', M.zip([{ name: '[Content_Types].xml', data: Buffer.from('<x/>') }, { name: 'word/document.xml', usize: 50 * 1048576, csize: 40000 }]), 'zip_bomb'],
      ['ratio bomb', M.zip([{ name: '[Content_Types].xml', data: Buffer.from('<x/>') }, { name: 'word/document.xml', usize: 15 * 1048576, csize: 100 }, { name: 'word/a.xml', usize: 15 * 1048576, csize: 100 }]), 'zip_bomb'],
      ['total too big', M.zip(Array.from({ length: 8 }, (_, i) => ({ name: `word/p${i}.xml`, usize: 15 * 1048576, csize: 15 * 1048576 }))), 'zip_bomb'],
      ['too many entries', M.zip(Array.from({ length: 2500 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from('a') }))), 'zip_entries'],
      ['traversal', M.zip([{ name: '[Content_Types].xml', data: Buffer.from('<x/>') }, { name: 'word/document.xml', data: Buffer.from('<x/>') }, { name: '../../evil.sh', data: Buffer.from('x') }]), 'zip_unsafe_name'],
      ['absolute', M.zip([{ name: '/etc/cron.d/x', data: Buffer.from('x') }]), 'zip_unsafe_name'],
      ['backslash traversal', M.zip([{ name: 'a\\..\\..\\b', data: Buffer.from('x') }]), 'zip_unsafe_name'],
      ['nested archive', M.zip([{ name: '[Content_Types].xml', data: Buffer.from('<x/>') }, { name: 'word/document.xml', data: Buffer.from('<x/>') }, { name: 'payload.zip', data: Buffer.from('PK') }]), 'zip_nested'],
      ['encrypted', M.zip([{ name: 'word/document.xml', data: Buffer.from('x'), flags: 1 }]), 'zip_encrypted'],
      ['no eocd', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(100)]), 'zip_corrupt'],
      ['cd out of bounds', (() => { const z = M.zip([{ name: 'a.xml', data: Buffer.from('x') }]); z.writeUInt32LE(0x7fffff00, z.length - 6); return z; })(), 'zip_corrupt'],
    ];
    for (const [label, buf, code] of cases) {
      const r = await up(S, buf, { name: 'x.docx' });
      assert.equal(r.status === 422 || r.status === 415, true, `${label} -> ${r.status} ${r.text}`);
      assert.equal(r.json.code, code, `${label}: ${r.text}`);
    }
    assert.ok(Date.now() - t0 < 10000, 'classification is header-only (fast): nothing was inflated');
    assert.equal(S.child.exitCode, null);
  });

  it('path traversal: hostile file names are only ever display strings; nothing is written outside the attachments dir', async () => {
    const before = new Set(walk(S.base).filter((f) => !f.startsWith(ATT) && !/[\\/](data|logs)[\\/]/.test(f)));
    const names = ['../../../../etc/passwd', '..%2f..%2fevil.txt', '/etc/cron.d/evil', 'C:\\Windows\\evil.txt', 'a\0b.txt', '....//....//x', '.hidden', 'x'.repeat(5000), '\u202egpj.txt', '', '%', '%E0%A4%A'];
    const seen = [];
    for (const [i, n] of names.entries()) {
      const body = Buffer.from(`hostile name test ${i}`);
      const raw = n.includes('%') || n === '' ? { headers: { 'X-Filename': n }, name: undefined } : { name: n };
      const r = await up(S, body, raw);
      assert.equal(r.status, 201, `${JSON.stringify(n.slice(0, 20))} -> ${r.text}`);
      assert.match(r.json.name, /^[^\\/\0]{1,120}$/u, 'sanitised display name');
      assert.ok(!r.json.name.startsWith('.'), 'no leading dot');
      assert.ok(!r.json.name.includes('..'), 'no dot-dot');
      assert.ok(fs.existsSync(path.join(ATT, r.json.sha256.slice(0, 2), r.json.sha256)), 'stored by hash, not by name');
      seen.push(r.json.name);
    }
    const files = walk(S.base);
    for (const f of files) assert.ok(!/(passwd|evil)/.test(path.basename(f)), `no file named after a hostile name: ${f}`);
    for (const f of walk(ATT)) assert.ok(/[\\/](tmp|[0-9a-f]{2})[\\/]/.test(f.slice(ATT.length)), `only tmp/ and hash dirs exist: ${f}`);
    const after = new Set(walk(S.base).filter((f) => !f.startsWith(ATT) && !/[\\/](data|logs)[\\/]/.test(f)));
    assert.deepEqual([...after].sort(), [...before].sort(), 'no stray files elsewhere in the sandbox');
  });

  it('dedupe: identical bytes upload once (200, same id), under any name', async () => {
    const body = Buffer.from('dedupe me ' + Math.random());
    const a = await up(S, body, { name: 'one.txt' }); const b = await up(S, body, { name: 'two.txt' });
    assert.deepEqual([a.status, a.json.deduped], [201, false]);
    assert.deepEqual([b.status, b.json.deduped, b.json.id], [200, true, a.json.id]);
    assert.equal(b.json.name, 'one.txt', 'the first name is kept');
    assert.equal(walk(path.join(ATT, a.json.sha256.slice(0, 2))).filter((f) => f.endsWith(a.json.sha256)).length, 1);
    assert.deepEqual(walk(path.join(ATT, 'tmp')), [], 'the duplicate temp file is removed');
  });

  it('aborted uploads leave nothing behind and the server keeps serving', async () => {
    const port = Number(new URL(S.url).port);
    const rowsBefore = (await S.get('/attachments')).totals.count;
    await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write(`POST /api/attachments HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/octet-stream\r\nX-Orch-Upload: 1\r\nContent-Length: 9000\r\n\r\n` + 'abc'.repeat(500));
        setTimeout(() => { s.destroy(); resolve(); }, 150);
      });
    });
    await S.waitFor(() => walk(path.join(ATT, 'tmp')).length === 0, { what: 'temp file of the aborted upload removed' });
    assert.equal((await S.get('/attachments')).totals.count, rowsBefore);
    assert.equal((await up(S, Buffer.from('still alive'), { name: 'ok.txt' })).status, 201);
  });

  it('read paths: list/get, raw only for images with hardening headers, unknown ids, non-numeric ids', async () => {
    const img = (await up(S, M.png(3, 3, 5), { name: 'pic.png' })).json;
    const txt = (await up(S, Buffer.from('plain'), { name: 'p.txt' })).json;
    const list = await S.get('/attachments');
    assert.ok(list.items.some((x) => x.id === img.id) && list.totals.count >= 2 && list.quota_bytes > 0 && list.limits.image === 20971);
    const one = await S.get(`/attachments/${img.id}`);
    assert.deepEqual([one.kind, one.links, one.derivations], ['image', [], []]);
    const raw = await fetch(`${S.url}/api/attachments/${img.id}/raw`);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get('content-type'), 'image/png');
    assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
    assert.match(raw.headers.get('content-security-policy'), /sandbox/);
    assert.deepEqual(Buffer.from(await raw.arrayBuffer()), M.png(3, 3, 5));
    assert.equal((await S.get(`/attachments/${txt.id}/raw`, { allowFail: true })).status, 403);
    assert.equal((await S.get('/attachments/999999', { allowFail: true })).status, 404);
    assert.equal((await S.get('/attachments/abc', { allowFail: true })).status, 404);
    assert.equal((await S.get('/attachments/1e3', { allowFail: true })).status, 404);
    assert.equal((await S.get('/attachments/..%2ftasks', { allowFail: true })).status, 404);
  });

  it('derive text, csv summary, pdf degrade + delete + gc', async () => {
    const t = (await up(S, Buffer.from('a,b\r\n1,2\r\n'), { name: 'd.csv' })).json;
    const d = await S.post(`/attachments/${t.id}/derive`);
    assert.equal(d.status, 'ok'); assert.ok(d.derivation.chars > 8); assert.equal(d.derivation.content, undefined, 'the API never returns derived text bodies in list/get either');
    assert.equal((await S.get(`/attachments/${t.id}`)).derivations.length, 1);
    const pdf = (await up(S, M.pdf('derive-test'), { name: 'a.pdf' })).json;
    const dp = await S.post(`/attachments/${pdf.id}/derive`, {}, { allowFail: true });
    assert.equal(dp.status, 422);
    assert.ok(['unsupported', 'tool_missing'].includes(dp.json.status), dp.json.status);
    const del = await S.post(`/attachments/${t.id}/delete`);
    assert.equal(del.ok, true);
    assert.equal(fs.existsSync(path.join(ATT, t.sha256.slice(0, 2), t.sha256)), false, 'blob removed with the row');
    assert.equal((await S.get(`/attachments/${t.id}`, { allowFail: true })).status, 404);
    const g = await S.post('/attachments/gc', { older_than_hours: 0 });
    assert.ok(g.removed.length >= 1);
    assert.equal((await S.get('/attachments')).totals.count, 0, 'nothing is linked, so gc(0) clears everything');
    assert.equal((await S.post('/attachments/gc', { older_than_hours: -1 }, { allowFail: true })).status, 400);
    for (const f of walk(ATT)) assert.fail(`blob left behind after gc: ${f}`);
  });

  it('GET /api/media/tools reports optional tools without running any', async () => {
    const r = await S.get('/media/tools');
    for (const k of ['tesseract', 'pdftotext', 'pdftoppm', 'ffmpeg', 'ffprobe', 'whisper']) { assert.equal(typeof r.tools[k].found, 'boolean', k); assert.ok(r.tools[k].install, k); }
  });
});

describe('M6 attachments API: storage quota', () => {
  let S;
  before(async () => { S = await startServer({ env: { ORCH_ATTACH_QUOTA_GB: '0.00002' } }); }); // ~21 KB
  after(async () => { if (S) await S.stop(); });
  it('refuses an upload that would exceed the quota (413 quota); deleting frees room', async () => {
    const a = await up(S, Buffer.from('q'.repeat(9000)), { name: 'a.txt' }); assert.equal(a.status, 201);
    const b = await up(S, Buffer.from('r'.repeat(9000)), { name: 'b.txt' }); assert.equal(b.status, 201);
    const c = await up(S, Buffer.from('s'.repeat(9000)), { name: 'c.txt' });
    assert.deepEqual([c.status, c.json.code], [413, 'quota']);
    await S.post(`/attachments/${a.json.id}/delete`);
    assert.equal((await up(S, Buffer.from('s'.repeat(9000)), { name: 'c.txt' })).status, 201);
  });
});
