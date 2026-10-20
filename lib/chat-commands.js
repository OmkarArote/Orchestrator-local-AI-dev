'use strict';
// Deterministic chat commands. The model is not asked to interpret these.

function parse(text) {
  const s = String(text || '').trim();
  let m = s.match(/^merge\s+task\s+(\d+)\s+into\s+(dev|uat|live)$/i);
  if (m) return { type: 'merge', id: Number(m[1]), role: m[2].toLowerCase(), confirm: false };
  m = s.match(/^confirm\s+merge\s+task\s+(\d+)\s+into\s+(dev|uat|live)$/i);
  if (m) return { type: 'merge', id: Number(m[1]), role: m[2].toLowerCase(), confirm: true };
  m = s.match(/^on\s+task\s+(\d+),\s*change\s+([\s\S]+)$/i);
  if (m && m[2].trim()) return { type: 'followup', id: Number(m[1]), instruction: m[2].trim() };
  return null;
}

module.exports = { parse };
