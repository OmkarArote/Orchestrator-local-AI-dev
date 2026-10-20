'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '..', 'evals', 'results');

function list() {
  if (!fs.existsSync(DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(DIR)) {
    if (!name.endsWith('.json')) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
      out.push({ id: doc.id || name.replace(/\.json$/, ''), flags: doc.flags || {}, summary: doc.summary || {}, file: name });
    } catch { /* skip a torn write */ }
  }
  out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return out;
}

module.exports = { list, DIR };
