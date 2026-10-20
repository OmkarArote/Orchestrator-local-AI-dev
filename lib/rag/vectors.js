'use strict';
// Float32 little-endian blobs. Cosine stays in JS.

function encode(vec) {
  const list = Array.isArray(vec) ? vec : [];
  const b = Buffer.alloc(list.length * 4);
  for (let i = 0; i < list.length; i++) b.writeFloatLE(Number(list[i]) || 0, i * 4);
  return b;
}

function decode(blob) {
  if (!blob) return [];
  const b = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const n = Math.floor(b.length / 4);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readFloatLE(i * 4);
  return out;
}

function cosine(a, b) {
  if (!a || !b || !a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

module.exports = { encode, decode, cosine };
