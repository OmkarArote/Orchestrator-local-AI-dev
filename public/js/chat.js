// Chat page: conversation list | thread | model card. Talks to the local model only (no tools, no file access). Answers stream over a POST + SSE:
// fetch() reads the body, and aborting the fetch (Stop button / leaving the page) aborts the upstream Ollama request on the server.
import { el, clear, api, badge, chip, bytes, ago, empty, select, toast, toastError, confirmDialog, promptDialog, busy } from './ui.js';
import { icon } from './icons.js';
import { uploadFile, chipRow } from './attachments.js';
import { parseMarkdown, sseParser, mentionAt } from './md-parse.js';

// ---------------------------------------------------------------- markdown -> DOM (textContent only)
function inlineNodes(tokens) {
  return tokens.map((t) => {
    if (t.t === 'code') return el('code', { textContent: t.v });
    if (t.t === 'strong') return el('strong', {}, ...inlineNodes(t.c));
    if (t.t === 'em') return el('em', {}, ...inlineNodes(t.c));
    if (t.t === 'link') return el('a', { href: t.href, target: '_blank', rel: 'noopener noreferrer' }, ...inlineNodes(t.c));
    return document.createTextNode(t.v);
  });
}
export function renderMarkdown(text) {
  const root = el('div', { className: 'md' });
  for (const b of parseMarkdown(text)) {
    if (b.type === 'code') root.append(el('pre', { className: 'md-code' }, b.lang ? el('div', { className: 'md-lang', textContent: b.lang }) : null, el('code', { textContent: b.text })));
    else if (b.type === 'heading') root.append(el(`h${Math.min(6, b.level + 2)}`, { className: 'md-h' }, ...inlineNodes(b.c)));
    else if (b.type === 'ul' || b.type === 'ol') root.append(el(b.type, {}, ...b.items.map((it) => el('li', {}, ...inlineNodes(it)))));
    else if (b.type === 'quote') root.append(el('blockquote', {}, ...inlineNodes(b.c)));
    else if (b.type === 'hr') root.append(el('hr'));
    else root.append(el('p', {}, ...inlineNodes(b.c)));
  }
  return root;
}

const fmtChars = (n) => (n === null || n === undefined ? '-' : n >= 1000 ? `${(n / 1000).toFixed(1)}k chars` : `${n} chars`);
const KIND_ICON = { project: 'folder', service: 'cpu', file: 'file' };

/** Collapsible "Context used": what each @mention pulled in (layer, source, line range, size), what was skipped and why, redactions. From the stored manifest. */
export function contextBlock(man, open = false) {
  if (!man) return null;
  const ments = man.mentions || [], un = man.unresolved || [], atts = man.attachments || [];
  if (!ments.length && !un.length && !atts.length) return null;
  const head = ments.length ? `Context used: ${ments.map((m) => m.label).join(', ')} \u00b7 ${fmtChars(man.used_chars)} of ${fmtChars(man.limit_chars)}${man.redactions ? ` \u00b7 ${man.redactions} secret-like value(s) redacted` : ''}${man.sticky ? ' \u00b7 sticky' : ''}` : atts.length ? `Attachments: ${atts.map((a) => a.name || a.id).join(', ')}` : 'Context: no mention could be resolved';
  const d = el('details', { className: 'context-used' }, el('summary', { textContent: head }));
  for (const m of ments) {
    d.append(el('div', { className: 'ctx-mention' },
      el('div', { className: 'row' }, el('strong', { textContent: m.label }), badge(m.status === 'ok' ? 'ok' : m.status.replace('_', ' '), m.status === 'ok' ? 's-running' : 's-failed'), m.branch ? chip(`${m.branch}@${m.commit}`, 'mono') : null,
        el('span', { className: 'small dim', textContent: `${fmtChars(m.chars)} of ${fmtChars(m.allocated)} share${m.sticky ? ' (sticky mention)' : ''}` })),
      m.error ? el('div', { className: 'small t-bad', textContent: m.error }) : null,
      el('ul', { className: 'ctx-list' }, ...m.included.map((i) => el('li', {}, chip(i.layer), ' ', el('code', { textContent: i.source.replace(/^[^:]*:/, '') }), i.section ? ` \u00a7 ${i.section}` : '', i.lines ? ` lines ${i.lines}` : '', el('span', { className: 'small dim', textContent: ` ${fmtChars(i.chars)}${i.truncated ? ' (truncated)' : ''}` })))),
      m.skipped.length ? el('div', { className: 'small dim' }, 'Skipped: ', m.skipped.slice(0, 12).map((x) => `${x.source.replace(/^[^:]*:/, '')} (${x.reason})`).join('; ')) : null,
      (m.notes || []).map((n) => el('div', { className: 'small dim', textContent: n })),
      m.tree_left_out && (m.tree_left_out.denied || m.tree_left_out.symlink) ? el('div', { className: 'small dim', textContent: `Never read: ${m.tree_left_out.denied} secret/ignored/binary file(s), ${m.tree_left_out.symlink} symlink(s)` }) : null));
  }
  for (const u of un) d.append(el('div', { className: 'callout warn small', textContent: `${u.raw}: ${u.message}${u.candidates && u.candidates.length ? ` (${u.candidates.slice(0, 6).join(', ')})` : ''}` }));
  for (const a of atts) d.append(el('div', { className: 'small', textContent: `${a.name || 'file'} (${a.kind || '?'}${a.derivation ? `, ${a.derivation}` : ''}): ${a.included ? `${a.chars || 0} chars${a.truncated ? ', truncated' : ''}${a.redactions ? `, ${a.redactions} redacted` : ''}` : (a.reason || 'not included')}` }));
  if (man.source) d.append(el('div', { className: 'tiny dim', textContent: `Source: ${man.source}. Read-only; chat never writes to a repository.` }));
  d.open = open; return d;
}

const CTX_CHOICES = [4096, 8192, 16384, 32768, 65536];
const fmtTok = (n) => (n === null || n === undefined ? '-' : n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n));
const untilIso = (iso) => { const s = Math.round((new Date(iso) - Date.now()) / 1000); return !iso || Number.isNaN(s) ? null : s <= 0 ? 'expiring' : s < 90 ? `${s}s` : `${Math.round(s / 60)} min`; };

export async function render(main, route) {
  const st = { convs: [], active: null, conv: null, info: null, models: [], streaming: null, draft: '', pending: [], pin: false, alive: true, poll: null, infoTimer: null };
  const root = el('div', { className: 'chat' }); main.append(root);
  const selId = route && route.id ? Number(route.id) : null;

  // ------------------------------------------------------------ data
  async function loadList() { const r = await api('/conversations'); st.convs = r.conversations; st.active = r.active; }
  async function loadConv(id) { st.conv = id ? await api(`/conversations/${id}`) : null; }
  async function loadInfo() {
    const q = new URLSearchParams(); const c = st.conv;
    if (c && c.model) q.set('model', c.model);
    if (c && c.options && c.options.num_ctx) q.set('num_ctx', c.options.num_ctx);
    try { st.info = await api(`/llm/info${q.toString() ? `?${q}` : ''}`); } catch (e) { st.info = { error: e.message, status: { reachable: false } }; }
  }
  async function loadModels() { try { st.models = ((await api('/ollama/models')).models || []).filter((m) => !m.capabilities || !m.capabilities.length || m.capabilities.includes('completion')); } catch { st.models = []; } }
  async function reloadAll() { await Promise.all([loadList(), loadConv(selId), loadInfo()]); draw(); watchForeignStream(); }

  // a stream started elsewhere (another tab / before a reload): poll until it ends
  function watchForeignStream() {
    clearTimeout(st.poll);
    if (st.alive && !st.streaming && st.conv && st.conv.streaming) st.poll = setTimeout(async () => { if (!st.alive || st.streaming) return; await Promise.all([loadList(), loadConv(selId)]); if (!st.conv.streaming) await loadInfo(); draw(); watchForeignStream(); }, 2000);
  }

  // ------------------------------------------------------------ actions
  const go = (id) => { location.hash = id ? `#/chat/${id}` : '#/chat'; };
  async function newChat() { const c = await api('/conversations', {}); go(c.id); }
  async function updateConv(patch) { await api(`/conversations/${st.conv.id}/update`, patch); await Promise.all([loadConv(selId), loadList(), loadInfo()]); draw(); }
  async function rename() { const t = await promptDialog({ title: 'Rename conversation', label: 'Title', value: st.conv.title, required: true, confirmText: 'Rename' }); if (t) await updateConv({ title: t }); }
  async function remove() {
    if (!await confirmDialog({ title: 'Delete this conversation?', message: 'The messages are deleted from the local database. This cannot be undone.', confirmText: 'Delete', danger: true })) return;
    await api(`/conversations/${st.conv.id}/delete`, {}); go(null);
  }

  /** Send a message and stream the answer into the thread. */
  async function send(text, think) {
    if (st.streaming) return;
    const ac = new AbortController();
    const ids = st.pending.map((p) => p.id);
    const pin = st.pin;
    const live = { ac, user: text, answer: '', thinking: '', meta: null, warn: [], error: null, done: null, status: 'streaming' };
    st.streaming = live; st.draft = ''; st.pending = []; drawThread(); drawComposer();
    let raf = 0; const refresh = () => { if (!raf) raf = setTimeout(() => { raf = 0; if (st.alive) updateLive(); }, 60); };
    try {
      const r = await fetch(`/api/conversations/${st.conv.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text, ...(think === undefined ? {} : { think }), ...(ids.length ? { attachments: ids, pin_attachments: pin } : {}) }), signal: ac.signal });
      if (!(r.headers.get('content-type') || '').includes('text/event-stream')) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
      const parser = sseParser(); const dec = new TextDecoder(); const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        for (const { event, data } of parser.feed(dec.decode(value, { stream: true }))) {
          if (event === 'meta') { live.meta = data; live.warn = data.warnings || []; }
          else if (event === 'token') live.answer += data.text;
          else if (event === 'thinking') live.thinking += data.text;
          else if (event === 'done') { live.done = data; live.status = data.status; live.warn = [...live.warn, ...(data.warn || [])]; }
          else if (event === 'error') { live.error = data; live.status = 'error'; }
          refresh();
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') live.status = 'aborted'; else { live.error = { code: 'client', message: e.message }; live.status = 'error'; if (!live.meta) toastError(e); }
    }
    st.streaming = null;
    if (!st.alive) return;
    await Promise.all([loadList(), loadConv(selId), loadInfo()]).catch(toastError);
    draw();
  }

  // ------------------------------------------------------------ view
  const msgNode = (m) => {
    const ctx = m.context || {};
    if (m.role === 'user') return el('div', { className: 'msg user' }, el('div', { className: 'bubble', textContent: m.content }), m.mentions && m.mentions.length ? el('div', { className: 'row end' }, ...m.mentions.map((r) => chip(r.kind === 'project' ? `@${r.project}` : `@${r.project}/${r.service}${r.file ? `:${r.file}` : ''}`, 'e-local', 'resolved mention'))) : null);
    return el('div', { className: `msg assistant ${m.status}` },
      ctx.thinking ? thinkingBlock(ctx.thinking, false) : null,
      contextBlock(ctx.context),
      el('div', { className: 'bubble' }, m.content ? renderMarkdown(m.content) : el('span', { className: 'dim', textContent: m.status === 'streaming' ? 'still generating (started elsewhere)\u2026' : '(no answer)' })),
      (ctx.warn || []).map((w) => el('div', { className: 'callout warn small', textContent: w.message })),
      m.status === 'error' ? el('div', { className: 'callout bad small', textContent: `Failed: ${ctx.error ? ctx.error.message : 'unknown error'}${m.content ? ' (partial answer kept above)' : ''}` }) : null,
      m.status === 'aborted' ? el('div', { className: 'small dim', textContent: 'stopped \u2013 partial answer kept' }) : null,
      el('div', { className: 'msg-foot small dim' }, [m.model, m.prompt_tokens != null ? `${m.prompt_tokens} prompt + ${m.completion_tokens ?? '?'} tokens` : null, m.num_ctx ? `ctx ${fmtTok(m.num_ctx)}` : null, m.duration_ms != null ? `${(m.duration_ms / 1000).toFixed(1)}s` : null].filter(Boolean).join(' \u00b7 ')));
  };
  function thinkingBlock(text, open) {
    const d = el('details', { className: 'thinking' }, el('summary', { textContent: 'Thinking' }), el('div', { className: 'think-body', textContent: text }));
    d.open = open; return d;
  }
  let liveNodes = null;
  function updateLive() {
    const l = st.streaming; if (!l || !liveNodes) return;
    if (l.thinking) { if (!liveNodes.think) { liveNodes.think = thinkingBlock('', !l.answer); liveNodes.wrap.prepend(liveNodes.think); } liveNodes.think.querySelector('.think-body').textContent = l.thinking; if (l.answer && liveNodes.think.dataset.auto !== '1') { liveNodes.think.dataset.auto = '1'; liveNodes.think.open = false; } }
    if (l.meta && l.meta.context && !liveNodes.ctxShown) { liveNodes.ctxShown = true; clear(liveNodes.ctxBox, contextBlock(l.meta.context)); }
    clear(liveNodes.bubble, l.answer ? renderMarkdown(l.answer) : el('span', { className: 'dim', textContent: l.meta ? (l.thinking ? 'thinking\u2026' : 'waiting for the model\u2026 (it may need to load first)') : 'sending\u2026' }));
    clear(liveNodes.extra, ...l.warn.map((w) => el('div', { className: 'callout warn small', textContent: w.message })), l.error ? el('div', { className: 'callout bad small', textContent: `Failed: ${l.error.message}` }) : null);
    const sc = liveNodes.scroller; if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160) sc.scrollTop = sc.scrollHeight;
  }

  const left = el('div', { className: 'chat-list card flat' }), mid = el('div', { className: 'chat-main' }), right = el('div', { className: 'chat-side' });
  root.append(left, mid, right);
  const scroller = el('div', { className: 'chat-scroll', tabIndex: 0, 'aria-live': 'polite' });
  const composerBox = el('div', { className: 'chat-composer' });
  const headBox = el('div', { className: 'chat-head' });
  mid.append(headBox, scroller, composerBox);

  function drawList() {
    clear(left, el('button', { className: 'btn', textContent: '+ New chat', onclick: (e) => busy(e.currentTarget, newChat) }),
      st.convs.length ? el('div', { className: 'chat-items', role: 'list' }, ...st.convs.map((c) => el('a', { href: `#/chat/${c.id}`, role: 'listitem', className: `chat-item ${st.conv && st.conv.id === c.id ? 'on' : ''}`, 'aria-current': st.conv && st.conv.id === c.id ? 'page' : null },
        el('div', { className: 'ellipsis', textContent: c.title || 'New chat' }), el('div', { className: 'small dim ico' }, `${c.message_count} msg \u00b7 ${ago(c.updated_at)}`, st.active && st.active.conversation_id === c.id ? [' \u00b7 ', icon('point'), ' live'] : '')))) : el('div', { className: 'small dim mt', textContent: 'No conversations yet.' }));
  }
  function drawHead() {
    const c = st.conv; const info = st.info;
    if (!c) return clear(headBox);
    const modelName = c.model || (info && info.chat_defaults && info.chat_defaults.model) || '';
    const names = st.models.map((m) => m.name); if (modelName && !names.includes(modelName)) names.unshift(modelName);
    const modelSel = select([['', `default (${info && info.chat_defaults ? info.chat_defaults.model : '?'})`], ['auto', 'Auto'], ...names.map((n) => [n, n])], c.model || '', { 'aria-label': 'Model', onchange: (e) => busy(e.currentTarget, () => updateConv({ model: e.currentTarget.value || null })) });
    const ctxNow = (c.options && c.options.num_ctx) || (info && info.chat_defaults && info.chat_defaults.num_ctx) || 16384;
    const ctxMax = info && info.ctx && info.ctx.max;
    const ctxSel = select(CTX_CHOICES.filter((n) => !ctxMax || n <= ctxMax).map((n) => [String(n), `ctx ${fmtTok(n)}`]), String(ctxNow), { 'aria-label': 'Context window', title: 'num_ctx for this conversation (a different value reloads the model once)', onchange: (e) => busy(e.currentTarget, () => updateConv({ options: { ...(c.options || {}), num_ctx: Number(e.currentTarget.value) } })) });
    const caps = (info && info.model && info.model.capabilities) || [];
    const canThink = !info || !info.model || caps.includes('thinking');
    const think = el('input', { type: 'checkbox', checked: c.think, disabled: !canThink, 'aria-label': 'Thinking', onchange: (e) => busy(e.currentTarget, () => updateConv({ think: e.currentTarget.checked })) });
    const lastAuto = (c.messages || []).slice().reverse().find((m) => m.role === 'assistant' && m.context && m.context.context && m.context.context.auto);
    const autoChip = c.model === 'auto' ? el('span', { className: 'chip', title: lastAuto ? (lastAuto.context.context.auto.reason || []).join('; ') : 'Chooses an installed model for each message. Nothing is downloaded.', textContent: lastAuto ? `Auto \u2192 ${lastAuto.context.context.auto.model}` : 'Auto' }) : null;
    clear(headBox, el('div', { className: 'row' }, el('h2', { className: 'ellipsis grow', title: c.title, textContent: c.title || 'New chat' }),
      el('button', { className: 'btn sm sec', textContent: 'Rename', onclick: () => rename().catch(toastError) }), el('button', { className: 'btn sm sec', textContent: 'Delete', disabled: !!c.streaming, onclick: () => remove().catch(toastError) })),
    el('div', { className: 'row mt' }, modelSel, ctxSel, autoChip, el('label', { className: 'row small', title: canThink ? 'Let the model reason before answering (slower; the reasoning is shown in a collapsible block)' : 'This model has no thinking capability' }, think, 'Thinking')));
  }
  function drawThread() {
    const c = st.conv;
    if (!c) { liveNodes = null; return clear(scroller, empty({ icon: 'message', title: 'Chat with your local model', text: 'Nothing leaves this machine. Pick a conversation or start a new one; no files or repositories are read.', action: el('button', { className: 'btn', textContent: '+ New chat', onclick: (e) => busy(e.currentTarget, newChat) }) })); }
    const nodes = c.messages.filter((m) => !(st.streaming && m.status === 'streaming')).map(msgNode);
    liveNodes = null;
    if (st.streaming) {
      const l = st.streaming; const bubble = el('div', { className: 'bubble' }), extra = el('div'), ctxBox = el('div'); const wrap = el('div', { className: 'msg assistant streaming' }, ctxBox, bubble, extra);
      nodes.push(el('div', { className: 'msg user' }, el('div', { className: 'bubble', textContent: l.user })), wrap);
      liveNodes = { wrap, bubble, extra, ctxBox, scroller, think: null, ctxShown: false }; clear(scroller, ...nodes); updateLive(); scroller.scrollTop = scroller.scrollHeight; return;
    }
    clear(scroller, ...(nodes.length ? nodes : [el('div', { className: 'small dim', style: { padding: '24px 4px' }, textContent: 'Say something. Enter sends, Shift+Enter adds a line.' })]));
    scroller.scrollTop = scroller.scrollHeight;
  }
  // @-autocomplete state (survives redraws of the composer)
  let ac = null, acSeq = 0, acTimer = 0;
  function drawComposer() {
    const c = st.conv; if (!c) return clear(composerBox);
    const busyOther = !st.streaming && ((st.active && st.active.conversation_id !== c.id) || c.streaming);
    const ta = el('textarea', { rows: 3, placeholder: st.streaming ? 'Answering\u2026' : 'Message the local model\u2026  (@ to mention a project or service)', disabled: !!st.streaming || c.archived, value: st.draft, 'aria-label': 'Message', 'aria-autocomplete': 'list', 'aria-controls': 'mention-list', role: 'combobox', 'aria-expanded': 'false' });
    const pop = el('div', { className: 'mention-pop', role: 'listbox', id: 'mention-list', hidden: true });
    const closePop = () => { ac = null; pop.hidden = true; ta.setAttribute('aria-expanded', 'false'); ta.removeAttribute('aria-activedescendant'); };
    const drawPop = () => {
      if (!ac || !ac.items.length) return closePop();
      clear(pop, ...ac.items.map((it, i) => el('div', { role: 'option', id: `mention-opt-${i}`, className: `mention-opt ${i === ac.idx ? 'on' : ''}`, 'aria-selected': String(i === ac.idx), onmousedown: (e) => { e.preventDefault(); pick(i); } },
        el('span', { className: `mention-kind k-${it.kind} ico`, 'aria-hidden': 'true' }, icon(KIND_ICON[it.kind] || 'point')), el('span', { className: 'mention-label', textContent: it.label }), el('span', { className: 'small dim ellipsis', textContent: it.detail || '' }))));
      pop.hidden = false; ta.setAttribute('aria-expanded', 'true'); ta.setAttribute('aria-activedescendant', `mention-opt-${ac.idx}`);
      const on = pop.querySelector('.on'); if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    };
    function pick(i) {
      if (!ac || !ac.items[i]) return;
      const it = ac.items[i], t = ac.token, v = ta.value, ins = `${it.insert} `;
      ta.value = v.slice(0, t.start) + ins + v.slice(t.end); const pos = t.start + ins.length; ta.setSelectionRange(pos, pos); st.draft = ta.value; closePop(); ta.focus();
    }
    const lookup = () => {
      const token = mentionAt(ta.value, ta.selectionStart);
      clearTimeout(acTimer);
      if (!token) return closePop();
      const seq = ++acSeq;
      acTimer = setTimeout(async () => {
        try {
          const r = await api(`/mentions/suggest?q=${encodeURIComponent(token.query)}${c.project_id ? `&project_id=${c.project_id}` : ''}`);
          if (seq !== acSeq || !document.contains(ta)) return;
          const cur = mentionAt(ta.value, ta.selectionStart); if (!cur) return closePop();
          ac = { items: r.items || [], idx: 0, token: cur }; drawPop();
        } catch { closePop(); }
      }, 90);
    };
    const addFiles = async (files) => {
      for (const f of files) {
        if (st.pending.length >= 8) { toast('At most 8 attachments.', 'warn'); break; }
        try { const up = await uploadFile(f); st.pending.push({ id: up.id, name: up.name || f.name, kind: up.kind, size: up.size }); }
        catch (e) { toastError(e); }
      }
      drawComposer();
    };
    const submit = () => { const t = ta.value.trim(); if (!t || st.streaming) return; if (busyOther) return toast('Another answer is still streaming (one at a time).', 'warn'); closePop(); send(t, c.think).catch(toastError); };
    ta.addEventListener('input', () => { st.draft = ta.value; lookup(); });
    ta.addEventListener('click', lookup);
    ta.addEventListener('blur', () => setTimeout(closePop, 150));
    ta.addEventListener('keydown', (e) => {
      if (ac && ac.items.length && !pop.hidden) {
        if (e.key === 'ArrowDown') { e.preventDefault(); ac.idx = (ac.idx + 1) % ac.items.length; return drawPop(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); ac.idx = (ac.idx - 1 + ac.items.length) % ac.items.length; return drawPop(); }
        if (e.key === 'Enter' || e.key === 'Tab') { if (!e.isComposing) { e.preventDefault(); return pick(ac.idx); } }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return closePop(); }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    });
    const fileInput = el('input', { type: 'file', multiple: true, hidden: true, 'aria-label': 'Choose files', onchange: (e) => { const fs = [...e.currentTarget.files]; e.currentTarget.value = ''; addFiles(fs); } });
    ta.addEventListener('paste', (e) => { const files = [...(e.clipboardData && e.clipboardData.files || [])]; if (files.length) { e.preventDefault(); addFiles(files); } });
    composerBox.ondragover = (e) => { e.preventDefault(); composerBox.classList.add('drop-on'); };
    composerBox.ondragleave = () => composerBox.classList.remove('drop-on');
    composerBox.ondrop = (e) => { e.preventDefault(); composerBox.classList.remove('drop-on'); addFiles([...(e.dataTransfer && e.dataTransfer.files || [])]); };
    const sticky = c.mentions_view || [];
    const pinBox = el('label', { className: 'row small', title: 'Keep the derived text in later turns of this chat' }, el('input', { type: 'checkbox', checked: st.pin, 'aria-label': 'Pin attachments', onchange: (e) => { st.pin = e.currentTarget.checked; } }), 'Pin');
    clear(composerBox,
      sticky.length ? el('div', { className: 'row small', title: 'Follow-up questions keep using these (fresh code is retrieved each time). Remove one to stop.' }, el('span', { className: 'dim', textContent: 'Sticky context:' }),
        ...sticky.map((m) => el('span', { className: 'chip e-local' }, m.label, el('button', { className: 'chip-x ico', type: 'button', 'aria-label': `Remove ${m.label}`, title: 'Remove', onclick: (e) => busy(e.currentTarget, () => updateConv({ mentions: sticky.filter((x) => x !== m) })) }, icon('x'))))) : null,
      chipRow(st.pending, (id) => { st.pending = st.pending.filter((p) => p.id !== id); drawComposer(); }),
      el('div', { className: 'mention-wrap' }, pop, ta),
      el('div', { className: 'row end' }, fileInput, el('button', { className: 'btn sm sec', type: 'button', textContent: 'Attach', disabled: !!st.streaming || c.archived, onclick: () => fileInput.click() }), pinBox, busyOther ? el('span', { className: 'small t-warn', textContent: 'another answer is streaming' }) : null,
        st.streaming ? el('button', { className: 'btn bad ico', onclick: () => st.streaming && st.streaming.ac.abort() }, icon('player-stop'), ' Stop') : el('button', { className: 'btn', textContent: 'Send', disabled: !!busyOther, onclick: submit })));
    if (!st.streaming && !busyOther) setTimeout(() => { if (st.alive && document.contains(ta)) ta.focus({ preventScroll: true }); }, 0);
  }

  function drawSide() {
    const i = st.info; const card = el('div', { className: 'card' });
    if (!i) return clear(right, el('div', { className: 'card skel', style: { height: '260px' } }));
    const kv = (k, ...v) => el('div', { className: 'kv-row' }, el('span', { className: 'dim small', textContent: k }), el('span', { className: 'v' }, ...v));
    const ok = i.status && i.status.reachable;
    const rows = [kv('Ollama', el('span', { className: `${ok ? 't-ok' : 't-bad'} ico` }, icon('point')), ok ? `v${i.status.version || '?'} reachable` : 'not reachable')];
    if (ok && i.model) {
      const m = i.model, ctx = i.ctx, run = i.running, last = lastTurn();
      const used = run && run.context_length ? ctx.in_use : null;
      rows.unshift(el('h3', { className: 'ellipsis', title: i.model_name, textContent: i.model_name }), el('div', { className: 'small dim', textContent: [m.family, m.parameter_size, m.quantization, m.size ? bytes(m.size) : null].filter(Boolean).join(' \u00b7 ') }), el('div', { className: 'row' }, ...(m.capabilities || []).map((c) => chip(c))));
      rows.push(
        el('div', { className: 'small dim mt', textContent: 'Context window' }),
        kv('max (model)', fmtTok(ctx.max)), kv('configured', fmtTok(ctx.configured)), kv('in use (loaded)', run ? fmtTok(ctx.in_use) : 'not loaded'),
        last && last.prompt_tokens != null ? kv('last prompt', `${fmtTok(last.prompt_tokens)} / ${fmtTok(last.num_ctx || ctx.configured)}`) : null,
        last && last.prompt_tokens != null ? el('div', { className: 'progress', role: 'img', 'aria-label': 'prompt tokens vs configured context' }, el('i', { style: { width: `${Math.min(100, Math.round((100 * last.prompt_tokens) / (last.num_ctx || ctx.configured || 1)))}%` } })) : null,
        el('div', { className: 'small dim mt', textContent: 'Loaded now' }),
        run ? [kv('state', badge('loaded', 's-running')), kv('GPU', run.gpu_pct == null ? '-' : `${run.gpu_pct}%${run.gpu_pct < 100 ? ' (rest on CPU: slower)' : ''}`), kv('memory', run.size ? `${bytes(run.size)} (${bytes(run.size_vram)} on GPU)` : '-'), run.expires_at ? kv('unloads in', untilIso(run.expires_at) || '-') : null]
          : kv('state', 'not loaded (the first answer loads it)'),
        i.kv_estimate ? kv('KV cache (est.)', `${bytes(i.kv_estimate.configured_bytes)} at ${fmtTok(ctx.configured)}`) : null,
        el('div', { className: 'small dim mt', textContent: 'Roles using this model' }),
        el('div', { className: 'row' }, i.roles_using.length ? i.roles_using.map((r) => chip(r.role, r.source === 'role' ? 'e-local' : '')) : el('span', { className: 'small dim', textContent: 'none' })),
        el('div', { className: 'small dim mt', textContent: 'Sampling' }),
        kv('think default', String(i.chat_defaults.think)), kv('model defaults', Object.keys(m.sampling_defaults || {}).length ? Object.entries(m.sampling_defaults).map(([k, v]) => `${k} ${v}`).join(', ') : 'none'),
        Object.keys(i.chat_defaults.sampling || {}).length ? kv('chat role', Object.entries(i.chat_defaults.sampling).map(([k, v]) => `${k} ${v}`).join(', ')) : null,
        i.gpu_shared && i.gpu_shared.note ? el('div', { className: 'callout warn small mt', textContent: i.gpu_shared.note }) : null);
    } else rows.push(el('div', { className: 'callout bad small mt', textContent: i.error || (i.status && i.status.error && i.status.error.message) || 'Ollama is not reachable. Start it, then refresh.' }));
    clear(right, clear(card, ...rows.flat(), el('div', { className: 'row mt' }, el('button', { className: 'btn sm sec', textContent: 'Refresh', onclick: (e) => busy(e.currentTarget, async () => { await loadInfo(); drawSide(); }) }), el('a', { className: 'small', href: '#/models', textContent: 'Models page' }))));
  }
  const lastTurn = () => { const ms = (st.conv && st.conv.messages) || []; for (let k = ms.length - 1; k >= 0; k--) if (ms[k].role === 'assistant' && ms[k].prompt_tokens != null) return ms[k]; return null; };

  function draw() { drawList(); drawHead(); drawThread(); drawComposer(); drawSide(); }

  clear(left, el('div', { className: 'skel', style: { height: '120px' } }));
  try { await Promise.all([loadList(), loadConv(selId).catch((e) => { toastError(e); location.hash = '#/chat'; }), loadInfo(), loadModels()]); } catch (e) { toastError(e); }
  draw(); watchForeignStream();
  st.infoTimer = setInterval(async () => { if (st.streaming || !st.alive) return; await loadInfo(); drawSide(); }, 15000); // loaded/unloaded changes while idle
  return () => { st.alive = false; clearTimeout(st.poll); clearInterval(st.infoTimer); if (st.streaming) st.streaming.ac.abort(); }; // leaving the page stops the answer (partial text is kept)
}
