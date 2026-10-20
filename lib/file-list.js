'use strict';
// Pinned task files as typed in the form or pasted from a plan: "a.js; b.js", "`a.js`," or one per line.
// Tasks #30-#32 stored "src/x.js;" (trailing semicolon), which never matched a real file.

/** Split, trim quotes/backticks/trailing punctuation, drop "./", de-duplicate. Accepts an array or a string. */
function cleanFileList(input) {
  const raw = Array.isArray(input) ? input.flatMap((f) => String(f ?? '').split(/[\n,;]+/)) : String(input ?? '').split(/[\n,;]+/);
  const out = [];
  for (let f of raw) {
    const trimPunct = (s) => s.trim().replace(/[;,.:]+$/, '').trim();
    f = trimPunct(trimPunct(f).replace(/^[`'"]+|[`'"]+$/g, '')).replace(/^\.\//, '');
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

module.exports = { cleanFileList };
