'use strict';
// RFC-4180 reader that never dumps a big table: header, row count, per-column type / min / max / top values, and the first rows.
const { MAX_CHARS } = require('./text');

function parseRows(text, { maxScan = 100000, sep = ',' } = {}) {
  const rows = [];
  let row = []; let cell = ''; let q = false; let scanned = 0; let stopped = false;
  const pushCell = () => { row.push(cell); cell = ''; };
  const pushRow = () => { if (row.length > 1 || row[0] !== '' || scanned === 0) { rows.push(row); scanned++; } row = []; };
  const s = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
      continue;
    }
    if (c === '"') { q = true; continue; }
    if (c === sep) { pushCell(); continue; }
    if (c === '\n') {
      pushCell(); pushRow();
      if (scanned >= maxScan) { stopped = true; break; }
      continue;
    }
    cell += c;
  }
  if (!stopped && (cell !== '' || row.length)) { pushCell(); pushRow(); }
  return { rows, stopped };
}

function kindOf(values) {
  const v = values.filter((x) => x !== '');
  if (!v.length) return 'empty';
  if (v.every((x) => /^-?\d+(\.\d+)?$/.test(x))) return 'number';
  if (v.every((x) => /^\d{4}-\d{2}-\d{2}/.test(x))) return 'date';
  return 'text';
}

function summarise(text, { maxScan = 100000, sample = 20, sep } = {}) {
  const delimiter = sep || (String(text).slice(0, 2000).split('\n')[0] || '').includes('\t') && !String(text).includes(',') ? '\t' : ',';
  const { rows, stopped } = parseRows(text, { maxScan, sep: delimiter });
  if (!rows.length) return { text: '(empty table)', truncated: false, rows: 0 };
  const header = rows[0];
  const body = rows.slice(1);
  const width = Math.max(header.length, ...body.slice(0, 50).map((r) => r.length));
  const lines = [`rows: ${body.length}${stopped ? '+' : ''}`, `columns: ${width}`];
  for (let c = 0; c < width; c++) {
    const name = header[c] || `col${c + 1}`;
    const vals = [];
    for (const r of body) if (r[c] != null && r[c] !== '') vals.push(r[c]);
    const k = kindOf(vals);
    let extra = '';
    if (k === 'number' && vals.length) {
      const nums = vals.map(Number);
      extra = ` min=${Math.min(...nums)} max=${Math.max(...nums)}`;
    } else if (vals.length) {
      const counts = new Map();
      for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v, n]) => `${v} (${n})`).join(', ');
      extra = ` top=${top}`;
    }
    lines.push(`- ${name}: ${k}${extra}`);
  }
  lines.push('sample:');
  const shown = [header, ...body.slice(0, sample)];
  for (const r of shown) lines.push(r.map((c) => String(c).replace(/[\r\n]+/g, ' ').slice(0, 80)).join(' | '));
  if (body.length > sample || stopped) lines.push(`… ${stopped ? 'scan stopped at ' + maxScan + ' rows; ' : ''}${Math.max(0, body.length - sample)} further rows omitted`);
  let out = lines.join('\n');
  const truncated = stopped || out.length > MAX_CHARS;
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS);
  return { text: out, truncated, rows: body.length };
}

module.exports = { parseRows, summarise };
