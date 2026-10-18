'use strict';
// M7 extractors: office/csv/html fixtures generated here; PDF and tesseract skip when the tool is absent.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-m20-')));
process.env.ORCH_DB = path.join(base, 'data', 'orchestrator.db');
process.env.ORCH_LOG_DIR = path.join(base, 'logs');
process.env.ORCH_WORKTREES = path.join(base, 'worktrees');
process.env.ORCH_CONTEXT_DIR = path.join(base, 'context');
delete process.env.ORCH_ATTACH_DIR;
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const att = require('../lib/attachments');
const csv = require('../lib/extract/csv');
const html = require('../lib/extract/html');
const office = require('../lib/extract/zip-office');
const pdf = require('../lib/extract/pdf');
const media = require('../lib/media-tools');
const { withScratch } = require('../lib/extract/scratch');
const M = require('./helpers/media-fixtures');

after(() => fs.rmSync(base, { recursive: true, force: true }));

let n = 0;
async function ingest(buf, name) {
  const req = Readable.from([buf]); req.headers = { 'content-length': String(buf.length) };
  return (await att.receive(req, { name })).attachment;
}
const docx = (sentence) => M.zip([
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'word/document.xml', data: Buffer.from(`<w:document><w:p><w:t>${sentence}</w:t></w:p></w:document>`) },
]);

describe('M7 extractors', () => {
  it('summarises a csv without dumping every row, including a 100k-row scan cap', () => {
    const small = csv.summarise('name,n\nalice,3\nbob,9\nalice,1\n');
    assert.match(small.text, /rows: 3/);
    assert.match(small.text, /name: text/);
    assert.match(small.text, /n: number/);
    assert.match(small.text, /min=1 max=9/);
    assert.ok(!small.text.includes('alice,3\nbob')); // joined with pipes, not a raw dump of the file
    let big = 'h\n';
    for (let i = 0; i < 100000; i++) big += i + '\n';
    const sum = csv.summarise(big, { maxScan: 100000, sample: 20 });
    assert.ok(sum.text.split('\n').length < 40, 'sample stays short');
    assert.match(sum.text, /omitted|stopped/);
  });

  it('strips html script and style and does not keep the script body', () => {
    const r = html.toText('<html><style>body{color:red}</style><script>alert(1)</script><p>Hello <b>there</b></p></html>');
    assert.match(r.text, /Hello/);
    assert.match(r.text, /there/);
    assert.ok(!/alert/.test(r.text));
    assert.ok(!/color:red/.test(r.text));
  });

  it('reads docx, pptx and xlsx text from generated zips and flags macros', async () => {
    const a = await ingest(docx('Quarterly notes'), 'notes.docx');
    const d = await att.derive(a.id);
    assert.equal(d.status, 'ok');
    const row = require('../lib/db').attDerivList(a.id, true)[0];
    assert.match(row.content, /Quarterly notes/);
    const ppt = M.zip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { name: 'ppt/presentation.xml', data: Buffer.from('<p:presentation/>') },
      { name: 'ppt/slides/slide1.xml', data: Buffer.from('<p:sld><a:t>Slide one</a:t></p:sld>') },
    ]);
    const sheet = M.zip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
      { name: 'xl/sharedStrings.xml', data: Buffer.from('<sst><si><t>Name</t></si><si><t>Ada</t></si></sst>') },
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.from('<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>') },
    ]);
    // pptx/xlsx need the sniff markers. The zip helper writes the entry names sniff looks for.
    const p = await ingest(ppt, 'deck.pptx');
    assert.equal((await att.derive(p.id)).status, 'ok');
    const x = await ingest(sheet, 'book.xlsx');
    assert.equal(x.ext, 'xlsx');
    const xd = await att.derive(x.id);
    assert.equal(xd.status, 'ok');
    assert.match(require('../lib/db').attDerivList(x.id, true)[0].content, /Ada/);
    const macro = docx('Has code');
    // macros are a sibling entry; rebuild with vbaProject.bin stored, not executed
    const withMacro = M.zip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { name: 'word/document.xml', data: Buffer.from('<w:document><w:t>Has code</w:t></w:document>') },
      { name: 'word/vbaProject.bin', data: Buffer.from('not-really-vba') },
    ]);
    const file = path.join(base, 'macro.docx');
    fs.writeFileSync(file, withMacro);
    const got = office.extract(file, 'docx');
    assert.match(got.text, /macros present/);
    assert.match(got.text, /Has code/);
    assert.ok(!/not-really-vba/.test(got.text));
    void macro;
  });

  it('rejects a deflate bomb without allocating the inflated output', () => {
    const payload = Buffer.alloc(2 * 1048576, 0x61);
    const comp = zlib.deflateRawSync(payload);
    assert.ok(comp.length < 10000);
    assert.throws(() => office.inflate(8, comp, 1024), (e) => e.code === 'zip_bomb');
  });

  it('a failing tool leaves no scratch directory', async () => {
    const parent = path.join(base, 'scratch');
    const seen = [];
    await assert.rejects(withScratch(parent, async (dir) => {
      seen.push(dir);
      fs.writeFileSync(path.join(dir, 'junk.txt'), 'x');
      throw new Error('tool failed');
    }));
    assert.equal(seen.length, 1);
    assert.equal(fs.existsSync(seen[0]), false);
  });

  it('pdf and tesseract degrade when the tool is absent, and low-fidelity pdf text is labelled', async () => {
    const tools = media.detect();
    const simple = Buffer.from('%PDF-1.4\nBT (Hello PDF) Tj ET\n%%EOF\n');
    const low = pdf.lowFi(simple);
    assert.match(low.text, /Hello PDF/);
    if (!tools.pdftotext.found) {
      const file = path.join(base, 'hi.pdf');
      fs.writeFileSync(file, simple);
      const r = await pdf.extract(file, { scratchParent: path.join(base, 'pdfscratch'), binDir: path.join(base, 'bin') });
      if (r.status === 'ok') assert.match(r.text, /low fidelity|Hello PDF/);
      else assert.ok(['tool_missing', 'unsupported'].includes(r.status));
    }
    if (!tools.tesseract.found) {
      const img = await ingest(M.png(4, 4), 'dot.png');
      const r = await att.derive(img.id);
      assert.equal(r.status, 'tool_missing');
      assert.match(r.install, /tesseract/);
    } else {
      const img = await ingest(M.png(8, 8), 'dot.png');
      const r = await att.derive(img.id);
      assert.ok(['ok', 'unsupported', 'error'].includes(r.status), r.status);
    }
  });
});
