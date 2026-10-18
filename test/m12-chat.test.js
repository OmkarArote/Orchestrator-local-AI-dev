'use strict';
// M12 (plan M2): dashboard chat - streaming adapter, SSE endpoint, abort, single-stream slot, persistence, truncation warning, model card data.
// Everything runs against the FAKE Ollama; no real model is loaded and no token is generated.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('node:url');
const { startServer, ROOT, sleep } = require('./helpers/harness');

/** POST a message and read the SSE stream in the background: { status, json (non-SSE reply), events, abort(), waitFor(fn), done: Promise<{status,json,events}> } */
function openChat(S, id, body) {
  const ac = new AbortController(); const events = [];
  const out = { events, status: null, json: null, abort: () => ac.abort() };
  out.waitFor = async (fn, what = 'event') => { const t0 = Date.now(); while (!fn(events)) { if (Date.now() - t0 > 8000) throw new Error(`timeout waiting for ${what}; got ${events.map((e) => e.event)}`); await sleep(20); } };
  out.done = (async () => {
    const r = await fetch(`${S.url}/api/conversations/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
    out.status = r.status;
    if (!(r.headers.get('content-type') || '').includes('text/event-stream')) { const text = await r.text(); try { out.json = JSON.parse(text); } catch { /* ignore */ } return out; }
    let buf = ''; const dec = new TextDecoder();
    try {
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block), data = /^data: (.+)$/m.exec(block);
          if (ev && data) events.push({ event: ev[1], data: JSON.parse(data[1]) }); // else: keepalive comment
        }
      }
    } catch (e) { if (e.name !== 'AbortError') throw e; }
    return out;
  })();
  return out;
}
const chatPost = (S, id, body) => openChat(S, id, body).done;
const names = (r) => r.events.map((e) => e.event);
const lastStreamBody = (S) => { const rs = S.fake.state.requests.filter((r) => r.path === '/api/chat' && r.body && r.body.stream === true); return rs[rs.length - 1].body; };
const newConv = (S, extra) => S.post('/conversations', { ...(extra || {}) });

/** run node code against lib/* with a throwaway DB (lib/db opens ORCH_DB at require time: never the real one) */
function probe(code, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-m12-'));
  return new Promise((resolve, reject) => execFile(process.execPath, ['--no-warnings', '-e', code], { cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, ORCH_DB: path.join(dir, 'o.db'), ORCH_LOG_DIR: path.join(dir, 'logs'), ORCH_WORKTREES: path.join(dir, 'wt'), ...env } },
  (err, stdout, stderr) => { fs.rmSync(dir, { recursive: true, force: true }); if (err) return reject(new Error(`${err.message}\n${stderr}`)); resolve(JSON.parse(stdout.trim().split('\n').pop())); }));
}

describe('M12 chat: unit', () => {
  it('kvBytesPerToken: hybrid attention (only every Nth layer has a KV cache), plain, arrays, missing fields', async () => {
    const r = await probe(`const m = require('./lib/models');
      console.log(JSON.stringify([
        m.kvBytesPerToken({ block_count: 32, full_attention_interval: 4, head_count_kv: 4, key_length: 256, value_length: 256 }),
        m.kvBytesPerToken({ block_count: 32, head_count_kv: 8, key_length: 128, value_length: 128 }),
        m.kvBytesPerToken({ block_count: 4, head_count: 16, head_count_kv: [2, 4], embedding_length: 2048 }),
        m.kvBytesPerToken({ block_count: 4, head_count: 8, embedding_length: 1024 }),
        m.kvBytesPerToken({ block_count: 32 }), m.kvBytesPerToken(null), m.kvBytesPerToken({}),
      ]));`);
    assert.equal(r[0], 8 * 4 * 512 * 2, 'ornith:9b shape = 32768 B/token');
    assert.equal(r[1], 32 * 8 * 256 * 2);
    assert.equal(r[2], 4 * 3 * (128 + 128) * 2, 'avg kv heads 3, key_length = embedding/heads = 128');
    assert.equal(r[3], 4 * 8 * (128 + 128) * 2, 'no kv heads -> falls back to head_count');
    assert.deepEqual(r.slice(4), [null, null, null]);
  });

  it('chatDefaults: num_ctx 16384, think false, model = coding role model; the chat role overrides', async () => {
    const r = await probe(`const m = require('./lib/models'); const s = require('./lib/db');
      const a = m.chatDefaults();
      s.setModelRole('chat', 'other:1b', { num_ctx: 4096, temperature: 0.3, think: true });
      const b = m.chatDefaults();
      console.log(JSON.stringify({ a, b, roles: m.ROLES }));`, { ORCH_MODEL: 'ollama_chat/ornith:9b' });
    assert.equal(r.a.model, 'ornith:9b'); assert.equal(r.a.num_ctx, 16384); assert.equal(r.a.think, false);
    assert.equal(r.b.model, 'other:1b'); assert.equal(r.b.num_ctx, 4096); assert.equal(r.b.think, true); assert.deepEqual(r.b.sampling, { temperature: 0.3 });
    assert.ok(r.roles.includes('chat') && !r.roles.includes('embedding') && r.roles.length === 9);
  });

  it('context-provider hook: text goes into the system message, the manifest into meta + the stored message; provider errors never fail the chat', async () => {
    const { startFakeOllama } = require('./helpers/fake-ollama');
    const fake = await startFakeOllama();
    try {
      const code = (provider) => `(async () => { const chat = require('./lib/chat');
        chat.setContextProvider(${provider});
        const c = await chat.createConversation({});
        const h = await chat.prepare(c.id, { content: 'what is in the file?' });
        const ev = []; await h.run((e, d) => ev.push([e, d]), new AbortController().signal);
        console.log(JSON.stringify({ events: ev.map(([e]) => e), meta: ev[0][1], conv: chat.getConversation(c.id), active: chat.activeStream() }));
      })();`;
      const ok = await probe(code(`async ({ budget }) => ({ text: '<context source="a.js">SECRET_FILE_BODY</context>', manifest: { files: [{ path: 'a.js', chars: 22 }], budget_seen: budget.num_ctx } })`), { OLLAMA_API_BASE: fake.url });
      assert.deepEqual(ok.events, ['meta', 'token', 'token', 'done']);
      assert.deepEqual(ok.meta.context.files, [{ path: 'a.js', chars: 22 }]); assert.equal(ok.meta.context.budget_seen, 16384);
      const sys = fake.state.requests.filter((x) => x.body && x.body.stream)[0].body.messages[0];
      assert.equal(sys.role, 'system'); assert.match(sys.content, /SECRET_FILE_BODY/); assert.match(sys.content, /untrusted data/);
      const asst = ok.conv.messages[1];
      assert.deepEqual(asst.context.context.files, [{ path: 'a.js', chars: 22 }]);
      assert.equal(ok.active, null, 'slot released');
      const bad = await probe(code(`async () => { throw new Error('index missing'); }`), { OLLAMA_API_BASE: fake.url });
      assert.deepEqual(bad.events, ['meta', 'token', 'token', 'done']);
      assert.match(bad.meta.context.error, /index missing/); assert.equal(bad.meta.warnings[0].code, 'context_error');
    } finally { await fake.close(); }
  });
});

describe('M12 chat: markdown parser + SSE reader (public/js/md-parse.js, pure)', () => {
  let md;
  before(async () => { md = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'md-parse.js')).href); });
  it('never produces HTML: markup stays literal text; only http(s) links are links', () => {
    const b = md.parseMarkdown('<img src=x onerror=alert(1)> and [x](javascript:alert(1)) and [ok](https://example.com/a?b=1)');
    assert.equal(b.length, 1);
    const toks = b[0].c;
    assert.ok(toks.every((t) => ['text', 'link'].includes(t.t)));
    assert.equal(toks.filter((t) => t.t === 'link').length, 1); assert.equal(toks.find((t) => t.t === 'link').href, 'https://example.com/a?b=1');
    assert.match(toks[0].v, /^<img src=x onerror=alert\(1\)> and \[x\]\(javascript:alert\(1\)\) and $/);
  });
  it('code fences (closed / still streaming), headings, lists, quotes, inline code/bold/italic', () => {
    const b = md.parseMarkdown('# Title\n\nSome **bold** and *it* and `a*b*c`\n\n- one\n- two\n\n1. a\n2. b\n\n> quoted\n\n```js\nconst x = "<b>";\n```\n\n```py\nprint(1)');
    assert.deepEqual(b.map((x) => x.type), ['heading', 'p', 'ul', 'ol', 'quote', 'code', 'code']);
    assert.deepEqual(b[1].c.map((t) => t.t), ['text', 'strong', 'text', 'em', 'text', 'code']); assert.equal(b[1].c[5].v, 'a*b*c');
    assert.equal(b[2].items.length, 2); assert.equal(b[3].items.length, 2);
    assert.deepEqual([b[5].lang, b[5].text, b[5].open], ['js', 'const x = "<b>";', false]);
    assert.deepEqual([b[6].lang, b[6].text, b[6].open], ['py', 'print(1)', true], 'unclosed fence while streaming');
    assert.deepEqual(md.parseMarkdown(''), []); assert.doesNotThrow(() => md.parseMarkdown('*'.repeat(50) + '`'.repeat(5) + '[' + '```'));
  });
  it('sseParser: events split across chunks, keepalive comments skipped, bad JSON dropped', () => {
    const p = md.sseParser();
    assert.deepEqual(p.feed('event: token\ndata: {"text":"a"}\n\n: keepalive\n\nevent: tok'), [{ event: 'token', data: { text: 'a' } }]);
    assert.deepEqual(p.feed('en\ndata: {"text":"b"}\n\nevent: x\ndata: {oops\n\n'), [{ event: 'token', data: { text: 'b' } }]);
  });
});

describe('M12 chat: API + SSE (fake Ollama)', () => {
  let S;
  before(async () => { S = await startServer(); });
  after(async () => { await S.stop(); });

  it('conversation CRUD + validation', async () => {
    const c = await newConv(S, { title: '  My   chat ' });
    assert.equal(c.title, 'My chat'); assert.equal(c.think, false); assert.deepEqual(c.options, {}); assert.equal(c.model, null);
    const list = await S.get('/conversations');
    assert.ok(list.conversations.some((x) => x.id === c.id)); assert.equal(list.active, null);
    const u = await S.post(`/conversations/${c.id}/update`, { title: 'Renamed', options: { num_ctx: 8192, temperature: 0.2 }, think: true });
    assert.equal(u.title, 'Renamed'); assert.deepEqual(u.options, { num_ctx: 8192, temperature: 0.2 }); assert.equal(u.think, true);
    const g = await S.get(`/conversations/${c.id}`);
    assert.deepEqual(g.messages, []); assert.equal(g.streaming, false);
    assert.equal((await S.post('/conversations', { model: 'nope:1b' }, { allowFail: true })).status, 400);
    assert.equal((await S.post('/conversations', { options: { num_ctx: 300000 } }, { allowFail: true })).status, 400, 'validated like the chat role (context limit)');
    assert.equal((await S.post('/conversations', { project_id: 9999 }, { allowFail: true })).status, 400);
    assert.equal((await S.get('/conversations/99999', { allowFail: true })).status, 404);
    assert.equal((await S.post(`/conversations/${c.id}/messages`, { content: '   ' }, { allowFail: true })).status, 400);
    assert.equal((await S.post(`/conversations/${c.id}/messages`, { content: 'x', think: 5 }, { allowFail: true })).status, 400, 'think must be boolean/string');
    await S.post(`/conversations/${c.id}/update`, { archived: true });
    assert.equal((await S.post(`/conversations/${c.id}/messages`, { content: 'hi' }, { allowFail: true })).status, 409, 'archived');
    assert.ok(!(await S.get('/conversations')).conversations.some((x) => x.id === c.id), 'archived hidden');
    assert.ok((await S.get('/conversations?archived=1')).conversations.some((x) => x.id === c.id));
    await S.post(`/conversations/${c.id}/delete`);
    assert.equal((await S.get(`/conversations/${c.id}`, { allowFail: true })).status, 404);
    assert.equal(S.fake.state.streamsStarted, 0, 'none of that touched the model');
  });

  it('SSE order meta -> token* -> done; both messages persisted; explicit think:false + num_ctx + system prompt sent; history replayed', async () => {
    const c = await newConv(S);
    const r = await chatPost(S, c.id, { content: 'Say hello' });
    assert.equal(r.status, 200);
    assert.deepEqual(names(r), ['meta', 'token', 'token', 'done']);
    const meta = r.events[0].data, done = r.events[3].data;
    assert.equal(meta.model, 'ornith:9b'); assert.equal(meta.num_ctx, 16384); assert.equal(meta.think, false); assert.equal(meta.context, null);
    assert.ok(meta.budget.available_tokens > 8000 && meta.budget.context_max_chars > 0);
    assert.equal(r.events.filter((e) => e.event === 'token').map((e) => e.data.text).join(''), 'Hello world');
    assert.equal(done.status, 'complete'); assert.equal(done.prompt_tokens, 42); assert.equal(done.completion_tokens, 2); assert.deepEqual(done.warn, []);
    const b = lastStreamBody(S);
    assert.equal(b.stream, true); assert.strictEqual(b.think, false, 'think is always an explicit boolean (ornith defaults to thinking)'); assert.equal(b.options.num_ctx, 16384); assert.equal(b.model, 'ornith:9b');
    assert.deepEqual(b.messages.map((m) => m.role), ['system', 'user']); assert.equal(b.messages[1].content, 'Say hello');
    const g = await S.get(`/conversations/${c.id}`);
    assert.deepEqual(g.messages.map((m) => [m.role, m.status, m.content]), [['user', 'complete', 'Say hello'], ['assistant', 'complete', 'Hello world']]);
    assert.equal(g.messages[1].prompt_tokens, 42); assert.equal(g.messages[1].num_ctx, 16384); assert.equal(g.messages[1].model, 'ornith:9b'); assert.ok(g.messages[1].duration_ms >= 0);
    assert.equal(g.title, 'Say hello', 'untitled conversation takes its first line');
    await chatPost(S, c.id, { content: 'and again' });
    assert.deepEqual(lastStreamBody(S).messages.map((m) => [m.role, m.content]).slice(1), [['user', 'Say hello'], ['assistant', 'Hello world'], ['user', 'and again']]);
    assert.equal((await S.get('/conversations')).active, null);
  });

  it('think passthrough: thinking events precede tokens, are stored, and the request carries think:true; refused for models without thinking', async () => {
    const c = await newConv(S);
    const r = await chatPost(S, c.id, { content: 'hard question', think: true });
    assert.deepEqual(names(r), ['meta', 'thinking', 'thinking', 'token', 'token', 'done']);
    assert.equal(r.events[0].data.think, true);
    assert.equal(r.events.filter((e) => e.event === 'thinking').map((e) => e.data.text).join(''), 'Let me think.');
    assert.strictEqual(lastStreamBody(S).think, true);
    const m = (await S.get(`/conversations/${c.id}`)).messages[1];
    assert.equal(m.content, 'Hello world', 'thinking is not part of the answer'); assert.equal(m.context.thinking, 'Let me think.');
    await chatPost(S, c.id, { content: 'next', think: false });
    assert.strictEqual(lastStreamBody(S).think, false);
    assert.ok(!lastStreamBody(S).messages.some((x) => /Let me think/.test(x.content)), 'thinking is never replayed into history');
    const ocr = await newConv(S, { model: 'deepseek-ocr:latest' });
    const before = S.fake.state.streamsStarted;
    const bad = await chatPost(S, ocr.id, { content: 'x', think: true });
    assert.equal(bad.status, 400); assert.match(bad.json.error, /no 'thinking' capability/); assert.equal(S.fake.state.streamsStarted, before);
    assert.equal((await S.get('/conversations')).active, null, 'refused request released the slot');
  });

  it('conversation settings are used: model, sampling options, num_ctx', async () => {
    const c = await newConv(S, { options: { num_ctx: 8192, temperature: 0.1, top_k: 10 }, think: true });
    const r = await chatPost(S, c.id, { content: 'x' });
    assert.equal(r.events[0].data.num_ctx, 8192); assert.equal(r.events[0].data.think, true, 'conversation think default');
    const b = lastStreamBody(S);
    assert.deepEqual(b.options, { num_ctx: 8192, temperature: 0.1, top_k: 10 });
  });

  it('409 while streaming; abort (client disconnect) closes the upstream socket, keeps the partial answer as aborted, and frees the slot', async () => {
    S.fake.state.streamScript = [{ message: { role: 'assistant', content: 'Par' }, done: false }, { message: { role: 'assistant', content: 'tial' }, done: false }, { __hang: true }];
    const aborts0 = S.fake.state.streamAborts;
    const a = await newConv(S), b = await newConv(S);
    const run = openChat(S, a.id, { content: 'long one' });
    await run.waitFor((ev) => ev.filter((e) => e.event === 'token').length === 2, 'two tokens');
    assert.equal(S.fake.state.streamsOpen, 1);
    assert.deepEqual((await S.get('/conversations')).active.conversation_id, a.id);
    const second = await chatPost(S, b.id, { content: 'me too' });
    assert.equal(second.status, 409); assert.equal(second.json.code, 'busy'); assert.equal(second.json.active.conversation_id, a.id);
    assert.deepEqual((await S.get(`/conversations/${b.id}`)).messages, [], '409 wrote nothing');
    assert.equal((await S.post(`/conversations/${a.id}/delete`, {}, { allowFail: true })).status, 409, 'cannot delete a streaming conversation');
    assert.equal((await S.get(`/conversations/${a.id}`)).streaming, true);
    assert.equal((await S.get(`/conversations/${a.id}`)).messages[1].status, 'streaming');
    run.abort(); await run.done;
    await S.waitFor(async () => S.fake.state.streamAborts === aborts0 + 1 && S.fake.state.streamsOpen === 0, { what: 'upstream socket closed' });
    const m = await S.waitFor(async () => { const g = await S.get(`/conversations/${a.id}`); return g.messages[1].status === 'aborted' ? g.messages[1] : null; }, { what: 'assistant row aborted' });
    assert.equal(m.content, 'Partial'); assert.equal((await S.get('/conversations')).active, null, 'slot freed');
    S.fake.state.streamScript = null;
    const again = await chatPost(S, b.id, { content: 'now it works' });
    assert.deepEqual(names(again), ['meta', 'token', 'token', 'done']);
  });

  it('truncation warning when prompt_eval_count reaches the context window; stored on the message', async () => {
    S.fake.state.streamPromptTokens = 16384;
    try {
      const c = await newConv(S);
      const r = await chatPost(S, c.id, { content: 'big prompt' });
      const done = r.events.find((e) => e.event === 'done').data;
      assert.equal(done.status, 'complete'); assert.equal(done.warn.length, 1); assert.equal(done.warn[0].code, 'prompt_truncated'); assert.match(done.warn[0].message, /16384/);
      assert.equal((await S.get(`/conversations/${c.id}`)).messages[1].context.warn[0].code, 'prompt_truncated');
      S.fake.state.streamPromptTokens = 15000; // 91%: no warning
      const ok = await chatPost(S, c.id, { content: 'fine' });
      assert.deepEqual(ok.events.find((e) => e.event === 'done').data.warn, []);
      S.fake.state.streamScript = [{ message: { role: 'assistant', content: 'cut' } }, { message: { role: 'assistant', content: '' }, done: true, done_reason: 'length', prompt_eval_count: 50, eval_count: 100 }];
      const cut = await chatPost(S, c.id, { content: 'short limit' });
      assert.equal(cut.events.find((e) => e.event === 'done').data.warn[0].code, 'output_cut');
    } finally { S.fake.state.streamPromptTokens = 42; S.fake.state.streamScript = null; }
  });

  it('Ollama stream error / truncated stream -> error event, assistant row status error keeps the partial text', async () => {
    const c = await newConv(S);
    S.fake.state.streamScript = [{ message: { role: 'assistant', content: 'abc' } }, { error: 'model runner crashed' }];
    const e1 = await chatPost(S, c.id, { content: 'one' });
    assert.deepEqual(names(e1), ['meta', 'token', 'error']); assert.equal(e1.events[2].data.code, 'stream_error'); assert.match(e1.events[2].data.message, /model runner crashed/);
    S.fake.state.streamScript = [{ message: { role: 'assistant', content: 'xyz' } }, { __close: true }];
    const e2 = await chatPost(S, c.id, { content: 'two' });
    assert.equal(names(e2).at(-1), 'error');
    S.fake.state.streamScript = [{ message: { role: 'assistant', content: 'xyz' } }]; // ends without a done chunk
    const e3 = await chatPost(S, c.id, { content: 'three' });
    assert.equal(e3.events.at(-1).data.code, 'incomplete');
    S.fake.state.streamScript = null;
    const msgs = (await S.get(`/conversations/${c.id}`)).messages.filter((m) => m.role === 'assistant');
    assert.deepEqual(msgs.map((m) => [m.status, m.content]), [['error', 'abc'], ['error', 'xyz'], ['error', 'xyz']]);
    assert.equal(msgs[0].context.error.code, 'stream_error');
    assert.ok(!lastStreamBody(S).messages.some((x) => x.content === 'abc'), 'failed answers are not replayed into history');
    assert.equal((await S.get('/conversations')).active, null);
  });

  it('GET /api/llm/info: model facts, ctx max/configured/in use, loaded state, GPU %, roles using it, KV estimate, Ollama health', async () => {
    let info = await S.get('/llm/info');
    assert.equal(info.status.reachable, true); assert.equal(info.status.version, '0.35.1'); assert.equal(info.model_name, 'ornith:9b');
    assert.deepEqual(info.ctx, { max: 262144, configured: 16384, in_use: null }); assert.equal(info.running, null);
    assert.equal(info.model.family, 'qwen35'); assert.ok(info.model.capabilities.includes('thinking')); assert.deepEqual(info.model.sampling_defaults, { temperature: 0.6, top_k: 20, top_p: 0.95 });
    assert.equal(info.kv_estimate.bytes_per_token, 32768); assert.equal(info.kv_estimate.configured_bytes, 32768 * 16384); assert.equal(info.kv_estimate.in_use_bytes, null);
    assert.ok(info.roles_using.some((r) => r.role === 'chat') && info.roles_using.some((r) => r.role === 'coding'));
    assert.equal(info.chat_defaults.num_ctx, 16384); assert.equal(info.chat_defaults.think, false); assert.equal(info.chat_active, null); assert.equal(info.gpu_shared.note, null);
    S.fake.state.loaded = [{ name: 'ornith:9b', model: 'ornith:9b', size: 10000000000, size_vram: 7500000000, digest: 'sha256:aaa', expires_at: '2026-10-18T12:00:00Z', context_length: 16384, details: { family: 'qwen35', parameter_size: '9B', quantization_level: 'Q4_K_M' } }];
    info = await S.get('/llm/info?num_ctx=8192');
    assert.equal(info.running.gpu_pct, 75); assert.equal(info.running.context_length, 16384); assert.equal(info.running.expires_at, '2026-10-18T12:00:00Z');
    assert.deepEqual(info.ctx, { max: 262144, configured: 8192, in_use: 16384 }); assert.equal(info.kv_estimate.in_use_bytes, 32768 * 16384);
    const models = await S.get('/ollama/models?refresh=1');
    const o = models.models.find((m) => m.name === 'ornith:9b');
    assert.equal(o.loaded, true); assert.equal(o.running.gpu_pct, 75); assert.equal(o.running.context_length, 16384);
    assert.equal((await S.get('/llm/info?model=nope:1b', { allowFail: true })).json.error, "model 'nope:1b' is not installed");
    assert.equal((await S.get('/llm/info?model=Bad%20Name', { allowFail: true })).status, 400);
    S.fake.state.loaded = [];
  });
});

describe('M12 chat: Ollama unreachable', () => {
  let S;
  before(async () => { S = await startServer({ fakeOllama: false }); });
  after(async () => { await S.stop(); });
  it('error event, user row kept, assistant row status error; llm/info reports unreachable without failing', async () => {
    const c = await S.post('/conversations', {});
    const r = await chatPost(S, c.id, { content: 'anyone there?' });
    assert.deepEqual(names(r), ['meta', 'error']); assert.equal(r.events[1].data.code, 'unreachable');
    const g = await S.get(`/conversations/${c.id}`);
    assert.deepEqual(g.messages.map((m) => [m.role, m.status]), [['user', 'complete'], ['assistant', 'error']]);
    assert.equal(g.messages[1].context.error.code, 'unreachable'); assert.equal(g.messages[1].content, '');
    assert.equal((await S.get('/conversations')).active, null);
    const info = await S.get('/llm/info');
    assert.equal(info.status.reachable, false); assert.equal(info.model, null);
    assert.equal((await S.post('/conversations', { model: 'ornith:9b' }, { allowFail: true })).status, 400, 'cannot validate an explicit model while Ollama is down');
  });
});

describe('M12 chat: boot recovery', () => {
  it("assistant rows left 'streaming' by a dead process are marked error at boot (user history kept)", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-m12-boot-'));
    let S = await startServer({ base, keep: true });
    let id;
    try {
      id = (await S.post('/conversations', { title: 'crash' })).id;
      await S.stop();
      const db = new DatabaseSync(S.dbPath); // the TEST database (temp dir), server stopped
      db.prepare("INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, 'user', 'hi')").run(id);
      db.prepare("INSERT INTO chat_messages (conversation_id, role, content, status) VALUES (?, 'assistant', 'half an ans', 'streaming')").run(id);
      db.close();
      S = await startServer({ base, dbPath: S.dbPath, keep: true });
      const g = await S.get(`/conversations/${id}`);
      assert.deepEqual(g.messages.map((m) => [m.role, m.status, m.content]), [['user', 'complete', 'hi'], ['assistant', 'error', 'half an ans']]);
      assert.equal(g.messages[1].context.error.code, 'interrupted');
      assert.match(S.logs(), /marked 1 interrupted chat answer/);
    } finally { await S.stop().catch(() => {}); fs.rmSync(base, { recursive: true, force: true }); }
  });
});
