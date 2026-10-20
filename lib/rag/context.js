'use strict';
// Fill a token budget with the highest-scoring chunks and stop.

function fill(chunks, budgetTokens, charsPerToken = 4) {
  const budget = Math.max(0, Math.floor(Number(budgetTokens) || 0));
  const budgetChars = budget * charsPerToken;
  const included = [];
  let chars = 0;
  for (const c of chunks || []) {
    if (c.score <= 0 && included.length) continue;
    const text = String(c.text || '');
    if (!text) continue;
    if (chars >= budgetChars) break;
    const room = budgetChars - chars;
    const piece = text.slice(0, room);
    if (!piece) break;
    included.push({
      path: c.path,
      chunk_key: c.chunk_key,
      kind: c.kind,
      name: c.name || null,
      start_line: c.start_line,
      end_line: c.start_line + piece.split('\n').length - 1,
      text: piece,
      score: c.score,
      why: c.why || '',
    });
    chars += piece.length;
    if (piece.length < text.length) break;
  }
  return {
    chunks: included,
    chars,
    tokenEstimate: Math.ceil(chars / charsPerToken),
    budgetTokens: budget,
  };
}

module.exports = { fill };
