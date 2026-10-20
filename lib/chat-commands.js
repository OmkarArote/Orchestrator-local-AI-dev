'use strict';
// Deterministic chat commands. The model is not asked to interpret these.

function parse(text) {
  const s = String(text || '').trim();
  let m = s.match(/^merge\s+task\s+(\d+)\s+into\s+(dev|uat|live)$/i);
  if (m) return { type: 'merge', id: Number(m[1]), role: m[2].toLowerCase(), confirm: false };
  m = s.match(/^confirm\s+merge\s+task\s+(\d+)\s+into\s+(dev|uat|live)$/i);
  if (m) return { type: 'merge', id: Number(m[1]), role: m[2].toLowerCase(), confirm: true };
  return null;
}

module.exports = { parse };
