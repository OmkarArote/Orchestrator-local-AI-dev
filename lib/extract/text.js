'use strict';
// Plain-text derivation (the M6 path): UTF-8 / UTF-16, BOM stripped, newlines normalised. No tools.
const fs = require('node:fs');

const MAX_CHARS = 200000;

function decode(buf, encoding) {
  let text = encoding === 'utf-16le' ? buf.toString('utf16le') : encoding === 'utf-16be' ? Buffer.from(buf).swap16().toString('utf16le') : buf.toString('utf8');
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const truncated = text.length > MAX_CHARS;
  if (truncated) text = text.slice(0, MAX_CHARS);
  return { text, truncated };
}

function fromFile(file, encoding) {
  return decode(fs.readFileSync(file), encoding);
}

module.exports = { decode, fromFile, MAX_CHARS };
