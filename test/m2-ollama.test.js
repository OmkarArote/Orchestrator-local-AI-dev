'use strict';
require('./helpers/temp-env');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startFakeOllama } = require('./helpers/fake-ollama');
const { startServer, ROOT } = require('./helpers/harness');
const { createAdapter } = require('../lib/ollama');

describe('M2 ollama adapter (fake server)', () => {
  let fake, A;
  before(async () => { fake = await startFakeOllama(); A = createAdapter({ base: fake.url, allowPull: () => false }); });
  after(async () => { await fake.close(); });

  it('version / reachable / list / show / ps', async () => {
    assert.deepEqual(await A.version(), { ok: true, version: '0.35.1' });
    assert.equal(await A.isReachable(), true);
    const l = await A.listModels({ fresh: true });
    assert.equal(l.ok, true);
    const o = l.models.find((m) => m.name === 'ornith:9b');
    assert.deepEqual({ f: o.family, q: o.quantization, c: o.context_length, caps: o.capabilities }, { f: 'qwen35', q: 'Q4_K_M', c: 262144, caps: ['completion', 'tools', 'thinking'] });
    const s = await A.show('ornith:9b');
    assert.equal(s.ok, true);
    assert.equal(s.context_length, 262144);
    assert.deepEqual(s.parameters, { temperature: 0.6, top_k: 20, top_p: 0.95 });
    assert.deepEqual(s.thinking_values, ['low', 'medium', 'high']);
    assert.deepEqual((await A.ps()).models, []);
  });
  it('old Ollama: /api/tags without capabilities/context_length -> null, show() fills them in', async () => {
    fake.state.tagsMode = 'oldversion';
    try {
      const l = await A.listModels({ fresh: true });
      assert.equal(l.models[0].capabilities, null);
      assert.equal(l.models[0].context_length, null);
      assert.equal((await A.show('ornith:9b', { fresh: true })).capabilities.includes('thinking'), true);
    } finally { fake.state.tagsMode = 'normal'; }
  });
  it('errors are normalised, never thrown', async () => {
    assert.equal((await A.show('nope:1b')).code, 'http_404');
    assert.match((await A.show('nope:1b')).message, /not found/);
    fake.state.tagsMode = 'broken-json';
    assert.equal((await A.listModels({ fresh: true })).code, 'bad_json');
    fake.state.tagsMode = '500';
    assert.equal((await A.listModels({ fresh: true })).code, 'http_500');
    fake.state.tagsMode = 'normal';
    const dead = createAdapter({ base: 'http://127.0.0.1:9' });
    const r = await dead.version();
    assert.deepEqual([r.ok, r.code], [false, 'unreachable']);
    assert.equal((await dead.isReachable()), false);
    assert.equal((await dead.listModels({ fresh: true })).code, 'unreachable');
    fake.state.chatDelayMs = 400;
    const t = await A.chat('ollama', { model: 'ornith:9b', messages: [] }, { timeoutMs: 100 });
    fake.state.chatDelayMs = 0;
    assert.equal(t.code, 'timeout');
  });
  it('refuses non-loopback URLs unless explicitly allowed', async () => {
    const remote = createAdapter({ base: 'http://192.168.1.50:11434', allowRemote: false });
    assert.equal(remote.blocked, true);
    const r = await remote.version();
    assert.equal(r.code, 'blocked');
    assert.equal(createAdapter({ base: 'http://192.168.1.50:11434', allowRemote: true }).blocked, false);
    assert.equal(createAdapter({ base: 'http://[::1]:11434' }).blocked, false);
    assert.equal(createAdapter({ base: 'http://localhost:11434' }).blocked, false);
    assert.equal(createAdapter({ base: 'http://evil.example.com:11434' }).blocked, true);
  });
  it('model name validation', () => {
    for (const ok of ['ornith:9b', 'qwen2.5-coder:7b', 'library/llama3.1:8b', 'user/model:latest', 'a']) assert.equal(A.validName(ok), true, ok);
    for (const bad of ['', 'Ornith:9B', '../x', 'a b', 'a;b', '-x', 'x:', 'x:y:z', 'a/b/c/d', 'a'.repeat(200), 'x\0', null, 5, 'hf.co/../x', 'a//b']) assert.equal(A.validName(bad), false, String(bad));
  });
  it('pull/delete are DISABLED by default: no request ever reaches Ollama', async () => {
    const before = fake.state.requests.length;
    const p = await A.pull('qwen2.5-coder:1.5b'); const d = await A.deleteModel('ornith:9b');
    assert.deepEqual([p.ok, p.code, d.ok, d.code], [false, 'disabled', false, 'disabled']);
    assert.match(p.message, /downloads disabled/);
    assert.equal(fake.state.requests.length, before);
    assert.equal(fake.state.pullCalls + fake.state.deleteCalls, 0);
  });
  describe('pull/delete code path (flag enabled, FAKE server only)', () => {
    let P;
    before(() => { P = createAdapter({ base: fake.url, allowPull: () => true }); });
    it('streams progress and succeeds', async () => {
      const seen = [];
      const r = await P.pull('qwen2.5-coder:1.5b', { onProgress: (x) => seen.push(x) });
      assert.deepEqual(r, { ok: true });
      assert.deepEqual(seen.map((x) => x.percent), [null, 50, 100, null]);
      assert.equal(fake.state.requests.filter((q) => q.path === '/api/pull').pop().body.stream, true);
      assert.equal((await P.deleteModel('ornith:9b')).ok, true);
    });
    it('error line, truncated stream, invalid name, unreachable', async () => {
      fake.state.pullScript = [{ status: 'pulling manifest' }, { error: 'pull model manifest: file does not exist' }];
      assert.deepEqual([(await P.pull('x:1b')).ok, (await P.pull('x:1b')).code], [false, 'pull_failed']);
      fake.state.pullScript = [{ status: 'pulling manifest' }];
      assert.equal((await P.pull('x:1b')).code, 'incomplete');
      fake.state.pullScript = null;
      assert.equal((await P.pull('bad name')).code, 'invalid_name');
      assert.equal((await createAdapter({ base: 'http://127.0.0.1:9', allowPull: () => true }).pull('x:1b')).code, 'unreachable');
    });
    it('can be cancelled mid-stream', async () => {
      fake.state.pullScript = [{ status: 'pulling a', total: 100, completed: 10 }, { __hang: true }];
      const ac = new AbortController(); let got = 0;
      const pr = P.pull('x:1b', { signal: ac.signal, onProgress: () => { got++; setTimeout(() => ac.abort(), 50); } });
      const r = await pr;
      fake.state.pullScript = null;
      assert.equal(got, 1);
      assert.equal(r.code, 'aborted');
    });
  });
});

describe('M2 llm.js delegates to the adapter with IDENTICAL request bodies', () => {
  let fake;
  before(async () => { fake = await startFakeOllama(); });
  after(async () => { await fake.close(); });
  it('router (openai) and memory (ollama) bodies are exactly the pre-refactor shapes', async () => {
    const script = `const llm=require('./lib/llm'); (async()=>{
      const a = await llm.chatJson({ system:'SYS', user:'USR', api:'openai', maxTokens:300 });
      const b = await llm.chatJson({ system:'SYS', user:'USR', api:'ollama', numCtx:8192, timeoutMs:5000, maxTokens:500, schema:{type:'object'} });
      console.log(JSON.stringify([a.ok,b.ok]));})()`;
    const out = await new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ['--no-warnings', '-e', script], { cwd: ROOT, env: { ...process.env, OLLAMA_API_BASE: fake.url, ORCH_MODEL: 'ollama_chat/ornith:9b' } });
      let o = ''; c.stdout.on('data', (d) => (o += d)); c.on('close', () => resolve(o)); c.on('error', reject);
    });
    assert.equal(out.trim(), '[true,true]');
    const reqs = fake.state.requests.filter((r) => /chat/.test(r.path));
    assert.equal(reqs.length, 2);
    const [r1, r2] = reqs;
    const msgs = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USR' }];
    assert.equal(r1.path, '/v1/chat/completions');
    assert.deepEqual(r1.body, { model: 'ornith:9b', messages: msgs, temperature: 0, max_tokens: 300, response_format: { type: 'json_object' }, reasoning_effort: 'none' });
    assert.equal(r2.path, '/api/chat');
    assert.deepEqual(r2.body, { model: 'ornith:9b', messages: msgs, stream: false, think: false, format: { type: 'object' }, options: { temperature: 0, num_ctx: 8192, num_predict: 500 }, keep_alive: '30m' });
  });
});

describe('M2 server endpoints /api/ollama/status and /api/ollama/models', () => {
  it('status + installed models with capabilities, loaded flag, used-by', async () => {
    const S = await startServer();
    try {
      const st = await S.get('/ollama/status');
      assert.equal(st.reachable, true); assert.equal(st.version, '0.35.1'); assert.equal(st.loopback_only, true); assert.equal(st.pull_enabled, false);
      assert.match(st.pull_note, /downloads disabled/);
      assert.ok(st.ram_bytes > 1e9); assert.ok(st.disk_free_bytes > 0);
      S.fake.state.loaded = [{ name: 'ornith:9b', size: 1, size_vram: 1 }];
      const m = await S.get('/ollama/models?refresh=1');
      const o = m.models.find((x) => x.name === 'ornith:9b');
      assert.equal(o.loaded, true); assert.deepEqual(o.capabilities, ['completion', 'tools', 'thinking']); assert.equal(o.context_length, 262144);
      assert.deepEqual(o.defaults, { temperature: 0.6, top_k: 20, top_p: 0.95 });
      assert.equal(m.models.find((x) => x.name === 'deepseek-ocr:latest').capabilities.includes('vision'), true);
      S.fake.state.tagsMode = '500';
      const bad = await S.get('/ollama/models?refresh=1', { allowFail: true });
      assert.equal(bad.status, 502);
      assert.equal((await S.post('/ollama/models', {}, { allowFail: true })).status, 405);
    } finally { await S.stop(); }
  });
  it('Ollama unreachable: status says so, models 502, nothing throws', async () => {
    const S = await startServer({ fakeOllama: false });
    try {
      const st = await S.get('/ollama/status');
      assert.equal(st.reachable, false); assert.equal(st.error.code, 'unreachable');
      assert.equal((await S.get('/ollama/models', { allowFail: true })).status, 502);
    } finally { await S.stop(); }
  });
});

describe('M2 live smoke against the real local Ollama (read-only GET/show; no pull)', () => {
  it('lists ornith:9b with capabilities', async (t) => {
    const r = await fetch('http://127.0.0.1:11434/api/version').catch(() => null);
    if (!r || !r.ok) return t.skip('Ollama not running');
    const A = createAdapter({ base: 'http://127.0.0.1:11434', allowPull: () => false });
    const l = await A.listModels({ fresh: true });
    assert.equal(l.ok, true);
    const o = l.models.find((m) => m.name === 'ornith:9b');
    if (!o) return t.skip('ornith:9b not installed');
    const s = await A.show('ornith:9b');
    assert.equal(s.ok, true);
    assert.ok(s.capabilities.includes('completion'));
    assert.ok(s.context_length > 4096);
    console.log('live:', JSON.stringify({ version: (await A.version()).version, models: l.models.map((m) => m.name), ornith: { caps: s.capabilities, ctx: s.context_length, params: s.parameters } }));
  });
});
