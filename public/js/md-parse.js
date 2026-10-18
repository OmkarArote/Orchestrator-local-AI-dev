// Minimal, SAFE markdown parser for chat answers. Pure functions (no DOM) so Node can unit-test them; chat.js turns the tree into DOM nodes with
// textContent only - nothing here ever produces HTML. Supported: fenced code (an unclosed fence while streaming is `open`), # headings, -/*/1. lists,
// > quotes, ---, paragraphs, `code`, **bold**, *italic*, [text](http(s) url). Everything else stays literal text (tables, images, raw HTML).

export function parseInline(s) {
  const out = []; let buf = ''; let i = 0;
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
  while (i < s.length) {
    const ch = s[i];
    if (ch === '`') { const j = s.indexOf('`', i + 1); if (j > i + 1) { flush(); out.push({ t: 'code', v: s.slice(i + 1, j) }); i = j + 1; continue; } }
    if (ch === '*' && s[i + 1] === '*') { const j = s.indexOf('**', i + 2); if (j > i + 2) { flush(); out.push({ t: 'strong', c: parseInline(s.slice(i + 2, j)) }); i = j + 2; continue; } }
    if (ch === '*' && s[i + 1] && s[i + 1] !== ' ' && s[i + 1] !== '*') { const j = s.indexOf('*', i + 1); if (j > i + 1 && s[j - 1] !== ' ') { flush(); out.push({ t: 'em', c: parseInline(s.slice(i + 1, j)) }); i = j + 1; continue; } }
    if (ch === '[') { const m = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/.exec(s.slice(i, i + 600)); if (m) { flush(); out.push({ t: 'link', href: m[2], c: [{ t: 'text', v: m[1] }] }); i += m[0].length; continue; } }
    buf += ch; i++;
  }
  flush();
  return out;
}

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/;
const LIST = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
const HEAD = /^(#{1,4})\s+(.*)$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const startsBlock = (l) => FENCE.test(l) || HEAD.test(l) || LIST.test(l) || QUOTE.test(l) || HR.test(l);

export function parseMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n'); const blocks = []; let i = 0;
  while (i < lines.length) {
    const line = lines[i]; let m;
    if ((m = FENCE.exec(line))) {
      const body = []; let closed = false; i++;
      while (i < lines.length) { if (/^\s*```\s*$/.test(lines[i])) { closed = true; i++; break; } body.push(lines[i]); i++; }
      blocks.push({ type: 'code', lang: m[1] || '', text: body.join('\n'), open: !closed }); continue;
    }
    if (!line.trim()) { i++; continue; }
    if ((m = HEAD.exec(line))) { blocks.push({ type: 'heading', level: m[1].length, c: parseInline(m[2]) }); i++; continue; }
    if (HR.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }
    if (LIST.test(line)) {
      const ordered = /^\s*\d/.test(line); const items = [];
      while (i < lines.length && (m = LIST.exec(lines[i])) && /^\s*\d/.test(lines[i]) === ordered) { items.push(parseInline(m[2])); i++; }
      blocks.push({ type: ordered ? 'ol' : 'ul', items }); continue;
    }
    if (QUOTE.test(line)) {
      const q = [];
      while (i < lines.length && (m = QUOTE.exec(lines[i]))) { q.push(m[1]); i++; }
      blocks.push({ type: 'quote', c: parseInline(q.join('\n')) }); continue;
    }
    const p = [];
    while (i < lines.length && lines[i].trim() && !(p.length && startsBlock(lines[i]))) { p.push(lines[i]); i++; }
    blocks.push({ type: 'p', c: parseInline(p.join('\n')) });
  }
  return blocks;
}

/** Incremental SSE parser for fetch() streams: feed(text) -> [{event, data}] (complete events only; comments/keepalives skipped, bad JSON dropped). */
export function sseParser() {
  let buf = '';
  return {
    feed(chunk) {
      buf += chunk; const out = [];
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block), data = /^data: (.+)$/m.exec(block);
        if (!ev || !data) continue;
        try { out.push({ event: ev[1], data: JSON.parse(data[1]) }); } catch { /* ignore */ }
      }
      return out;
    },
  };
}
