'use strict';
// Per-part prompt for a v2 split sequence. The full original stays on the parent.
// A part gets its goal, steps, editable files, read-only references, and only the
// Required behavior bullets that name those files. Earlier-part summary is added when the part starts.

const path = require('node:path');

const BUDGET = 6000;
const MARK = '## Earlier parts';

function goalOf(prompt) {
  const h = String(prompt || '').split('\n').find((l) => /^#\s+/.test(l));
  return h ? h.replace(/^#\s+/, '').trim() : 'Complete this part of the task';
}

function sectionBody(prompt, title) {
  const lines = String(prompt || '').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^#{1,6}\\s+${title}\\s*$`, 'i').test(l.trim()));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

/** Top-level bullets under a heading, each with the indented lines that follow it. */
function bulletBlocks(prompt, title) {
  const blocks = [];
  let cur = null;
  for (const line of sectionBody(prompt, title)) {
    if (/^\s*[-*]\s+/.test(line) && !/^\s{2,}/.test(line)) {
      if (cur) blocks.push(cur);
      cur = [line];
    } else if (cur && (line.trim() === '' || /^\s+/.test(line))) cur.push(line);
    else if (cur) { blocks.push(cur); cur = null; }
  }
  if (cur) blocks.push(cur);
  return blocks.map((b) => b.join('\n').trimEnd()).filter(Boolean);
}

const stemName = (file) => path.posix.basename(file).replace(/\.[^.]+$/, '').replace(/\.(enum|dto|schema|model|service|types?)$/i, '')
  .split(/[-_.]/).filter((w) => w.length > 2).map((w) => w[0].toUpperCase() + w.slice(1)).join('');

function namesIn(text) {
  const out = new Set();
  const src = String(text || '');
  for (const m of src.matchAll(/\b(?:export\s+)?(?:class|interface|enum|type|function|const)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (m[1].length >= 6) out.add(m[1]);
  }
  for (const m of src.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/g)) {
    if (m[1].length >= 6) out.add(m[1]);
  }
  return [...out];
}

function keysFor(file, readFile) {
  const keys = new Set();
  const pascal = stemName(file);
  if (pascal.length >= 6) keys.add(pascal);
  const role = (String(file).match(/\.(enum|dto|schema|service)\.[a-z]+$/i) || [])[1];
  if (role) keys.add(role);
  for (const n of namesIn(readFile ? readFile(file) : '')) keys.add(n);
  return [...keys];
}

function blockMatches(block, files, readFile) {
  for (const f of files) {
    const base = path.posix.basename(f).toLowerCase();
    if (block.toLowerCase().includes(f.toLowerCase()) || block.toLowerCase().includes(base)) return true;
    for (const k of keysFor(f, readFile)) {
      if (new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(block)) return true;
    }
  }
  return false;
}

function relevantBullets(prompt, files, readFile) {
  return bulletBlocks(prompt, 'Required behavior').filter((b) => blockMatches(b, files, readFile));
}

function stubTokens(prompt) {
  return [...new Set(String(prompt || '').match(/\bSTUB_[A-Z0-9_]+/g) || [])];
}

/**
 * @returns {{ text: string, chars: number, budget: number, trimmed: boolean }}
 */
function buildPartPrompt({ prompt, files, readOnly = [], index = 1, total = 1, others = [], earlier = '', readFile = () => null, budget = BUDGET } = {}) {
  const goal = goalOf(prompt);
  const edit = [...new Set(files || [])];
  const bullets = relevantBullets(prompt, edit, readFile);
  const steps = edit.map((f, i) => {
    const hit = bullets.find((b) => blockMatches(b, [f], readFile));
    const intent = hit ? hit.split('\n')[0].replace(/^\s*[-*]\s+/, '') : 'Apply the required behavior for this file only.';
    return `${i + 1}. \`${f}\`: ${intent}`;
  });
  const fileLines = [
    ...edit.map((f) => `- \`${f}\``),
    ...[...new Set(readOnly || [])].filter((f) => !edit.includes(f)).map((f) => `- \`${f}\` (style reference only, do not edit)`),
  ];
  const sections = [
    `# Part ${index}/${total}: ${goal}`,
    `Goal: ${goal}`,
    steps.length ? `## Steps\n\n${steps.join('\n')}` : '',
    fileLines.length ? `## Files\n\n${fileLines.join('\n')}` : '',
    bullets.length ? `## Required behavior\n\n${bullets.join('\n\n')}` : '',
    others.length ? `Other parts edit: ${others.join(', ')}. Do not change those files.` : '',
    earlier ? `${MARK}\n\n${earlier.trim()}` : '',
  ].filter(Boolean);
  const stubs = stubTokens(prompt);
  if (stubs.length) sections.push(stubs.join(' '));
  let text = sections.join('\n\n').trim() + '\n';
  let trimmed = false;
  if (text.length > budget) {
    trimmed = true;
    const keep = earlier ? `\n\n${MARK}\n\n${earlier.trim()}\n` : '\n';
    text = text.slice(0, Math.max(0, budget - keep.length)).trimEnd() + keep;
    if (text.length > budget) text = text.slice(0, budget);
  }
  return { text, chars: text.length, budget, trimmed };
}

/** Add the earlier-part summary without repeating the rest of the prompt. Idempotent. */
function appendEarlier(prompt, note, budget = BUDGET) {
  const body = String(note || '').trim();
  if (!body) return { text: String(prompt || ''), chars: String(prompt || '').length, budget, trimmed: false };
  const block = `${MARK}\n\n${body}\n`;
  const base = String(prompt || '').replace(new RegExp(`\\n*${MARK}\\n[\\s\\S]*$`), '').trimEnd();
  let text = `${base}\n\n${block}`;
  let trimmed = false;
  if (text.length > budget) {
    trimmed = true;
    const room = Math.max(0, budget - block.length - 2);
    text = `${base.slice(0, room).trimEnd()}\n\n${block}`;
    if (text.length > budget) text = text.slice(0, budget);
  }
  return { text, chars: text.length, budget, trimmed };
}

module.exports = { BUDGET, buildPartPrompt, appendEarlier, relevantBullets, goalOf };
