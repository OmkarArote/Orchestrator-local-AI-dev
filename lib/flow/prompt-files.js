'use strict';
// Which files a prompt asks to edit. Task #33 counted identifiers such as `visit.outcome` / `CheckOutDto.outcome` and a
// "(style reference only, do not edit)" file as edit targets, and was split into 3 parts instead of running once.
// Pure apart from the injected `exists(path)`.

const SOURCE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'py', 'go', 'rb', 'java', 'kt', 'swift', 'rs', 'c', 'h', 'cpp', 'cs', 'php',
  'vue', 'svelte', 'css', 'scss', 'less', 'html', 'md', 'yml', 'yaml', 'toml', 'sql', 'sh', 'graphql', 'gql', 'prisma', 'proto', 'xml', 'txt', 'env']);
const TOKEN_RE = /(?:^|[\s`'"(\[,])((?:\.{0,2}\/)?(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@-][A-Za-z0-9_@.-]*)(?=$|[\s`'"),\]:;])/g;
const READ_ONLY_RE = /\b(?:reference|read[- ]?only|do not edit|don't edit|not to be edited|context only|for style)\b/i;
const NEW_RE = /\((?:new|new file|create)\)|\bnew file\b/i;
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*)$/;
const FILES_HEAD_RE = /^\s{0,3}(?:#{1,6}\s*)?(?:files(?:\s+to\s+(?:change|edit|touch))?|changed files|files involved)\s*:?\s*$/i;

/** A token that looks like a path: contains '/' or ends in a known source extension. `visit.outcome` does not. */
function looksLikePath(tok) {
  const t = String(tok || '').replace(/^\.\//, '');
  if (!t || /^[./]+$/.test(t) || /^https?:/i.test(t)) return false;
  const ext = (/\.([A-Za-z0-9]{1,10})$/.exec(t) || [])[1];
  if (ext && SOURCE_EXT.has(ext.toLowerCase())) return true;
  return t.includes('/') && !t.endsWith('/') && /[A-Za-z]/.test(t) && !/^\//.test(t);
}

function tokens(line) {
  const out = [];
  for (const m of String(line).matchAll(TOKEN_RE)) {
    const t = m[1].replace(/^\.\//, '').replace(/[.]+$/, '');
    if (looksLikePath(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Lines of a "## Files" / "Files:" section, or null when the prompt has none. */
function filesSection(prompt) {
  const lines = String(prompt || '').split('\n');
  const start = lines.findIndex((l) => FILES_HEAD_RE.test(l));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i]) || (/^\S.*:\s*$/.test(lines[i]) && !/^\s*[-*]/.test(lines[i]) && out.some((x) => x.trim()))) break;
    out.push(lines[i]);
  }
  return out;
}

/**
 * @param {string} prompt
 * @param {{ exists?: (p: string) => boolean }} [opts]
 * @returns {{ edit: string[], read: string[], created: string[], section: boolean }}
 */
function parsePromptFiles(prompt, { exists = () => true } = {}) {
  const section = filesSection(prompt);
  const lines = section || String(prompt || '').split('\n');
  const edit = [], read = [], created = [];
  for (const line of lines) {
    const ro = READ_ONLY_RE.test(line);
    const isNew = NEW_RE.test(line);
    for (const t of tokens(line)) {
      if (ro) { if (!read.includes(t) && exists(t)) read.push(t); continue; }
      if (!isNew && !exists(t)) continue;
      if (!edit.includes(t)) edit.push(t);
      if (isNew && !exists(t) && !created.includes(t)) created.push(t);
    }
  }
  return { edit: edit.filter((f) => !read.includes(f)), read, created, section: !!section };
}

module.exports = { parsePromptFiles, looksLikePath, filesSection, SOURCE_EXT };
