'use strict';
// BM25 over chunk text. Same formula as lib/prompt-compact.js, which still returns a top-k for chat.

function tokens(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9_]{3,}/g) || [];
}

/** Score every chunk. Each result keeps the chunk fields and adds `bm25`. */
function score(chunks, query) {
  const docs = chunks.map((c) => tokens(c.text));
  const df = new Map();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) || 0) + 1);
  const q = tokens(query);
  const avg = docs.reduce((a, d) => a + d.length, 0) / (docs.length || 1);
  return chunks.map((c, i) => {
    const tf = new Map();
    for (const w of docs[i]) tf.set(w, (tf.get(w) || 0) + 1);
    let s = 0;
    for (const w of q) {
      const f = tf.get(w) || 0;
      if (!f) continue;
      const n = df.get(w) || 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * docs[i].length / (avg || 1)));
    }
    return { ...c, bm25: s };
  });
}

module.exports = { score, tokens };
