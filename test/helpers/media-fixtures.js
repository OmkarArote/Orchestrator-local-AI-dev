'use strict';
// Synthetic, tiny, license-free file builders for the attachment tests. They produce just enough structure for header sniffing; nothing is a real media file.
const zlib = require('node:zlib');

const be32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const le16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const pad = (b, n) => (b.length >= n ? b : Buffer.concat([b, Buffer.alloc(n - b.length, 0x20)]));

const png = (w = 4, h = 4, extra = 0) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), be32(13), Buffer.from('IHDR'), be32(w), be32(h), Buffer.from([8, 2, 0, 0, 0]), be32(0), Buffer.alloc(extra, 1)]);
const jpeg = (w = 4, h = 4, { exif = false, extra = 0 } = {}) => Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  exif ? Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([0x00, 0x08]), Buffer.from('Exif\0\0')]) : Buffer.alloc(0),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]), Buffer.from([h >> 8, h & 255, w >> 8, w & 255]), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), Buffer.from([0xff, 0xd9]), Buffer.alloc(extra, 1),
]);
const gif = (w = 4, h = 4) => Buffer.concat([Buffer.from('GIF89a'), le16(w), le16(h), Buffer.alloc(8)]);
const webp = (w = 4, h = 4) => Buffer.concat([Buffer.from('RIFF'), le32(30), Buffer.from('WEBPVP8X'), le32(10), Buffer.from([0, 0, 0, 0]), Buffer.from([(w - 1) & 255, ((w - 1) >> 8) & 255, ((w - 1) >> 16) & 255, (h - 1) & 255, ((h - 1) >> 8) & 255, ((h - 1) >> 16) & 255]), Buffer.alloc(8)]);
const pdf = (extra = '') => Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n${extra}`);
const wav = () => Buffer.concat([Buffer.from('RIFF'), le32(36), Buffer.from('WAVEfmt '), Buffer.alloc(40)]);
const mp3 = () => Buffer.concat([Buffer.from('ID3'), Buffer.alloc(60)]);
const ogg = () => Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60)]);
const flac = () => Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(60)]);
const mp4 = (brand = 'isom') => Buffer.concat([be32(24), Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(12)]);
const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60)]);
const elf = () => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60, 1)]);
const macho = () => Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(60, 1)]);
const pe = () => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(60, 1)]);
const gzip = () => zlib.gzipSync(Buffer.from('hello hello hello'));

/**
 * Build a zip. entries: {name, data?: Buffer, usize?, csize?, flags?}. With `data` the entry is stored (method 0) with a real CRC; without it the
 * central directory simply DECLARES usize/csize (used to forge zip bombs without allocating anything).
 */
function zip(entries, { eocdEntries } = {}) {
  const local = []; const central = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.data || Buffer.alloc(0);
    const usize = e.usize ?? data.length, csize = e.csize ?? data.length;
    const crc = e.data ? zlib.crc32(data) : 0;
    const lh = Buffer.concat([le32(0x04034b50), le16(20), le16(e.flags || 0), le16(0), le16(0), le16(0), le32(crc), le32(csize), le32(usize), le16(name.length), le16(0), name]);
    local.push(lh, data);
    central.push(Buffer.concat([le32(0x02014b50), le16(20), le16(20), le16(e.flags || 0), le16(0), le16(0), le16(0), le32(crc), le32(csize), le32(usize), le16(name.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(off), name]));
    off += lh.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([le32(0x06054b50), le16(0), le16(0), le16(eocdEntries ?? entries.length), le16(eocdEntries ?? entries.length), le32(cd.length), le32(off), le16(0)]);
  return Buffer.concat([...local, cd, eocd]);
}
const X = Buffer.from('<x/>');
const office = (type) => zip(type === 'docx' ? [{ name: '[Content_Types].xml', data: X }, { name: 'word/document.xml', data: X }]
  : type === 'xlsx' ? [{ name: '[Content_Types].xml', data: X }, { name: 'xl/workbook.xml', data: X }]
    : type === 'pptx' ? [{ name: '[Content_Types].xml', data: X }, { name: 'ppt/presentation.xml', data: X }]
      : type === 'epub' ? [{ name: 'mimetype', data: Buffer.from('application/epub+zip') }, { name: 'META-INF/container.xml', data: X }]
        : [{ name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.text') }, { name: 'content.xml', data: X }]);

module.exports = { png, jpeg, gif, webp, pdf, wav, mp3, ogg, flac, mp4, webm, elf, macho, pe, gzip, zip, office, pad };
