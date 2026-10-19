'use strict';
// M9: model management backend + roles. Everything runs against the FAKE Ollama and a FAKE registry; no real pull, no real registry call.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { startServer, makeRepo, ROOT } = require('./helpers/harness');

function startFakeRegistry(sizes) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const m = req.url.match(/^\/v2\/(.+)\/manifests\/(.+)$/);
    const key = m && `${m[1].replace(/^library\//, '')}:${decodeURIComponent(m[2])}`;
    if (req.method !== 'GET' || !m || !(key in sizes)) { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json' });
    res.end(JSON.stringify({ schemaVersion: 2, config: { size: 400, digest: 'sha256:cfg' }, layers: [{ mediaType: 'application/vnd.ollama.image.model', size: sizes[key], digest: 'sha256:weights' }, { mediaType: 'application/vnd.ollama.image.template', size: 100, digest: 'sha256:t' }] }));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => new Promise((x) => { srv.closeAllConnections(); srv.close(x); }) })));
}
const lastBody = (S, p) => { const rs = S.fake.state.requests.filter((r) => r.path === p); return rs[rs.length - 1] && rs[rs.length - 1].body; };

describe('M9 roles, validation, consumers (pull DISABLED, default)', () => {
  let S, P, repo, svc, REG;
  before(async () => {
    REG = await startFakeRegistry({ 'qwen2.5-coder:1.5b': 990e6, 'qwen2.5-coder:7b': 4.68e9, 'qwen2.5-coder:32b': 19.85e9, 'deepseek-r1:7b': 4.68e9 });
    S = await startServer({ env: { ORCH_OLLAMA_REGISTRY: REG.url }, fakeOpts: { models: [
      { name: 'ornith:9b', model: 'ornith:9b', size: 1500000000, digest: 'sha256:aaa', details: { family: 'qwen35' }, capabilities: ['completion', 'tools', 'thinking'], context_length: 262144 },
      { name: 'deepseek-ocr:latest', model: 'deepseek-ocr:latest', size: 1200000000, digest: 'sha256:bbb', details: { family: 'deepseek-ocr' }, capabilities: ['completion', 'vision'], context_length: 8192 },
      { name: 'embed:1b', model: 'embed:1b', size: 100000000, digest: 'sha256:ccc', details: { family: 'bert' }, capabilities: ['embedding'], context_length: 2048 },
    ], show: {
      'ornith:9b': { parameters: 'temperature 0.6\ntop_k 20', details: { family: 'qwen35' }, model_info: { 'qwen35.context_length': 262144 }, capabilities: ['completion', 'tools', 'thinking'], thinking: { values: ['low', 'medium', 'high'] } },
      'deepseek-ocr:latest': { parameters: '', details: { family: 'deepseek-ocr' }, model_info: { 'deepseek2.context_length': 8192 }, capabilities: ['completion', 'vision'] },
      'embed:1b': { parameters: '', details: {}, model_info: { 'bert.context_length': 2048 }, capabilities: ['embedding'] },
    } } });
    repo = makeRepo(path.join(S.work, 'm9'), { 'a.txt': 'a\n' });
    P = await S.addProject(repo, 'm9', 'true');
    svc = P.serviceId;
  });
  after(async () => { await S.stop(); await REG.close(); });
  const validate = (role, model, options, extra) => S.post('/models/roles/validate', { role, model, options, ...extra });
  const set = (role, model, options, extra, o) => S.post('/models/roles', { role, model, options, ...extra }, o);

  it('validation against /api/show: ranges, context limit, think only on thinking models, installed, completion capability', async () => {
    const t = [
      ['coding', 'ornith:9b', { num_ctx: 8192, temperature: 0.2, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, num_predict: 512, seed: 1 }, true],
      ['coding', 'ornith:9b', { num_ctx: 300000 }, false, /exceeds the model's context length/],
      ['coding', 'deepseek-ocr:latest', { num_ctx: 9000 }, false, /exceeds the model's context length \(8192\)/],
      ['coding', 'deepseek-ocr:latest', { num_ctx: 8192 }, true],
      ['coding', 'ornith:9b', { num_ctx: 40000 }, false, /KV cache/],
      ['coding', 'ornith:9b', { num_ctx: 100 }, false, />= 512/],
      ['coding', 'ornith:9b', { num_ctx: 8192.5 }, false, /integer/],
      ['coding', 'deepseek-ocr:latest', { think: true }, false, /not supported/],
      ['coding', 'ornith:9b', { think: 'high' }, true],
      ['coding', 'ornith:9b', { think: 'bogus' }, false, /think must be/],
      ['coding', 'ornith:9b', { bogus: 1 }, false, /unknown option/],
      ['coding', 'ornith:9b', { temperature: 3 }, false, /0\.\.2/],
      ['coding', 'ornith:9b', { top_p: 1.5 }, false, /0\.\.1/],
      ['coding', 'ornith:9b', { top_k: -1 }, false, /top_k/],
      ['coding', 'ornith:9b', { repeat_penalty: 5 }, false, /repeat_penalty/],
      ['coding', 'ornith:9b', { num_predict: 0 }, false, /num_predict/],
      ['coding', 'ornith:9b', { temperature: '0.5' }, false, /temperature/],
      ['coding', 'not-installed:7b', {}, false, /not installed/],
      ['coding', 'Bad Name', {}, false, /invalid model name/],
      ['coding', 'embed:1b', {}, false, /no 'completion' capability/],
      ['nonsense', 'ornith:9b', {}, false, /unknown role/],
      ['coding', 'ornith:9b', [], false, /options must be an object/],
    ];
    for (const [role, model, options, ok, re] of t) {
      const v = await validate(role, model, options);
      assert.equal(v.ok, ok, `${role} ${model} ${JSON.stringify(options)} -> ${JSON.stringify(v.errors)}`);
      if (re) assert.match(v.errors.join(' | '), re);
    }
    const big = await validate('coding', 'ornith:9b', { num_ctx: 20000 }); assert.equal(big.ok, true); assert.match(big.warnings.join(), /large KV cache/);
    assert.equal((await validate('coding', 'ornith:9b', { num_ctx: 40000 }, { allow_large_ctx: true })).ok, true);
    assert.match((await validate('planning', 'ornith:9b', {})).warnings.join(), /no local consumer/);
    assert.match((await validate('routing', 'ornith:9b', { think: true })).warnings.join(), /strict JSON/);
    assert.equal((await validate('coding', 'ornith:9b', { num_ctx: '', temperature: null })).ok, true, 'empty values = model default');
    assert.deepEqual((await S.get('/models/roles')).roles.map((r) => r.source), Array(13).fill('config'), 'validate never saves');
    const bad = await set('coding', 'ornith:9b', { num_ctx: 300000 }, {}, { allowFail: true });
    assert.equal(bad.status, 400); assert.match(bad.json.error, /exceeds/);
  });

  it('all 13 roles are stored; unwired roles are flagged; defaults come from config; installed models show in_use_by', async () => {
    const r0 = (await S.get('/models/roles')).roles;
    assert.deepEqual(r0.map((r) => r.role), ['coding', 'planning', 'requirements', 'review', 'debugging', 'documentation', 'routing', 'memory', 'chat', 'image', 'video', 'audio', 'document']);
    assert.deepEqual(r0.filter((r) => r.wired).map((r) => r.role).sort(), ['audio', 'chat', 'coding', 'document', 'image', 'memory', 'routing', 'video']);
    assert.ok(r0.filter((r) => r.role !== 'audio').every((r) => r.model === 'ornith:9b' && r.source === 'config'));
    assert.equal(r0.find((r) => r.role === 'audio').model, 'whisper');
    for (const role of ['planning', 'requirements', 'review', 'debugging', 'documentation']) await set(role, 'deepseek-ocr:latest', { temperature: 0.4 });
    const r1 = (await S.get('/models/roles')).roles;
    assert.equal(r1.find((r) => r.role === 'review').model, 'deepseek-ocr:latest'); assert.equal(r1.find((r) => r.role === 'review').wired, false);
    const inst = await S.get('/ollama/models');
    assert.equal(inst.models.find((m) => m.name === 'deepseek-ocr:latest').in_use_by.length, 5);
    assert.ok(inst.models.find((m) => m.name === 'ornith:9b').in_use_by.some((x) => x.role === 'coding' && x.source === 'config'));
    for (const role of ['planning', 'requirements', 'review', 'debugging', 'documentation']) await S.post('/models/roles/clear', { role });
    assert.ok((await S.get('/models/roles')).roles.every((r) => r.source === 'config'));
  });

  it('without role overrides every consumer behaves as before (same model arg, same request bodies); aider only gets think:false for a thinking model', async () => {
    const log = path.join(S.base, 'stub-aider.log');
    await S.runToReview(P.id, { title: 'plain', prompt: 'edit', files: ['a.txt'], engine: 'local' });
    const rec = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
    assert.equal(rec.model, 'ollama_chat/ornith:9b'); assert.equal(rec.settings, '- name: ollama_chat/ornith:9b\n  extra_params:\n    num_ctx: 16384\n    num_predict: 4096\n    think: false\n'); // swap-relook fix 6 (ornith has 'thinking') plus M0 defaults
    await S.post(`/projects/${P.id}/route`, { prompt: 'edit a' });
    const b = lastBody(S, '/v1/chat/completions');
    assert.equal(b.model, 'ornith:9b'); assert.equal(b.temperature, 0); assert.equal(b.max_tokens, 300); assert.equal(b.reasoning_effort, 'none'); assert.equal(b.top_p, undefined);
  });

  it('coding role: model + options reach aider via --model-settings-file (num_ctx, temperature)', async () => {
    await set('coding', 'ornith:9b', { num_ctx: 12288, temperature: 0.3 });
    const log = path.join(S.base, 'stub-aider.log');
    const t = await S.runToReview(P.id, { title: 'with ctx', prompt: 'edit', files: ['a.txt'], engine: 'local' });
    const rec = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
    assert.equal(rec.model, 'ollama_chat/ornith:9b'); assert.ok(rec.args.includes('--model-settings-file'));
    assert.equal(rec.settings, '- name: ollama_chat/ornith:9b\n  extra_params:\n    num_ctx: 12288\n    temperature: 0.3\n    num_predict: 4096\n    think: false\n');
    const ev = (await S.get(`/tasks/${t.id}/events`)).map((e) => e.message).join('\n');
    assert.match(ev, /settings: num_ctx: 12288, temperature: 0\.3/);
    await set('coding', 'deepseek-ocr:latest', { num_ctx: 4096 });
    await S.runToReview(P.id, { title: 'other model', prompt: 'edit', files: ['a.txt'], engine: 'local' });
    const rec2 = fs.readFileSync(log, 'utf8').trim().split('\n').pop();
    assert.equal(JSON.parse(rec2).model, 'ollama_chat/deepseek-ocr:latest');
    await S.post('/models/roles/clear', { role: 'coding' });
  });

  it('routing + memory roles: model and options are used in the Ollama requests', async () => {
    await set('routing', 'deepseek-ocr:latest', { temperature: 0.1, top_p: 0.8 });
    await S.post(`/projects/${P.id}/route`, { prompt: 'edit a' });
    let b = lastBody(S, '/v1/chat/completions');
    assert.equal(b.model, 'deepseek-ocr:latest'); assert.equal(b.temperature, 0.1); assert.equal(b.top_p, 0.8);
    await S.post('/models/roles/clear', { role: 'routing' });
    await set('memory', 'deepseek-ocr:latest', { num_ctx: 4096, temperature: 0.2 });
    const t = await S.runToReview(P.id, { title: 'mem', prompt: 'edit', files: ['a.txt'], engine: 'local' });
    await S.post(`/tasks/${t.id}/approve-merge`, {});
    await S.waitFor(async () => lastBody(S, '/api/chat') && lastBody(S, '/api/chat').model === 'deepseek-ocr:latest', { what: 'memory request with role model' });
    b = lastBody(S, '/api/chat');
    assert.equal(b.options.num_ctx, 4096); assert.equal(b.options.temperature, 0.2); assert.equal(b.think, false);
    await S.post('/models/roles/clear', { role: 'memory' });
  });

  it('default model setting applies to roles without an override; validated against installed models', async () => {
    assert.equal((await S.post('/models/default', { model: 'deepseek-ocr:latest' })).model, 'deepseek-ocr:latest');
    const r = (await S.get('/models/roles')).roles;
    assert.ok(r.filter((x) => x.role !== 'audio').every((x) => x.model === 'deepseek-ocr:latest' && x.source === 'setting'));
    assert.equal(r.find((x) => x.role === 'audio').model, 'whisper');
    assert.equal((await S.api('POST', '/models/default', { model: 'ghost:1b' }, { allowFail: true })).status, 400);
    assert.equal((await S.get('/ollama/status')).default_model, 'deepseek-ocr:latest');
    await S.post('/models/default', { model: null });
    assert.ok((await S.get('/models/roles')).roles.every((x) => x.source === 'config'));
  });

  it('image and video need vision, document needs 8192 context, audio is the whisper preset', async () => {
    assert.equal((await S.post('/models/roles', { role: 'image', model: 'ornith:9b' }, { allowFail: true })).status, 400);
    assert.equal((await S.post('/models/roles', { role: 'image', model: 'deepseek-ocr:latest' })).model, 'deepseek-ocr:latest');
    S.fake.state.models.push({ name: 'huge:70b', model: 'huge:70b', size: 70e9, digest: 'sha256:huge', details: { family: 'llama' }, capabilities: ['completion', 'vision'], context_length: 8192 });
    S.fake.state.show['huge:70b'] = { capabilities: ['completion', 'vision'], model_info: { 'llama.context_length': 8192 }, details: { family: 'llama' } };
    const huge = await S.post('/models/roles', { role: 'image', model: 'huge:70b' }, { allowFail: true });
    assert.equal(huge.status, 400);
    assert.match(huge.json.error, /too large/);
    assert.equal((await S.post('/models/roles', { role: 'audio', model: 'ornith:9b' }, { allowFail: true })).status, 400);
    const audio = await S.post('/models/roles', { role: 'audio', model: 'whisper' });
    assert.equal(audio.model, 'whisper');
    S.fake.state.models.push({ name: 'tiny:1b', model: 'tiny:1b', size: 1000, digest: 'sha256:ccc', details: { family: 'llama' }, capabilities: ['completion'], context_length: 2048 });
    S.fake.state.show['tiny:1b'] = { capabilities: ['completion'], model_info: { 'llama.context_length': 2048 }, details: { family: 'llama' } };
    assert.equal((await S.post('/models/roles', { role: 'document', model: 'tiny:1b' }, { allowFail: true })).status, 400);
    await S.post('/models/roles/clear', { role: 'image' });
    await S.post('/models/roles/clear', { role: 'audio' });
  });

  it('catalog: verified sizes, fit classes, installed flags; Download is disabled; verify = read-only registry GET', async () => {
    const c = await S.get('/ollama/catalog');
    assert.equal(c.download_enabled, false); assert.match(c.download_note, /downloads disabled/);
    const by = (n) => c.models.find((m) => m.name === n);
    assert.equal(by('ornith:9b').installed, true); assert.equal(by('qwen2.5-coder:7b').installed, false);
    assert.equal(by('qwen2.5-coder:7b').weights_gb, 4.68); assert.ok(c.models.every((m) => m.can_download === false));
    const exp = (b) => (b <= 0.35 * c.ram_bytes ? 'recommended' : b <= 0.6 * c.ram_bytes ? 'tight' : 'too_large');
    for (const m of c.models) assert.equal(m.fit, exp(m.weights_bytes), m.name);
    assert.ok(c.models.some((m) => m.kind === 'base'));
    const v = await S.post('/ollama/models/verify', { name: 'qwen2.5-coder:7b' });
    assert.equal(v.exists, true); assert.equal(v.weights_bytes, 4.68e9); assert.equal(v.total_bytes, 4.68e9 + 500); assert.equal(v.pull_enabled, false);
    const nf = await S.post('/ollama/models/verify', { name: 'ghost:1b' }); assert.equal(nf.exists, false);
    assert.equal((await S.api('POST', '/ollama/models/verify', { name: 'Bad Name' }, { allowFail: true })).status, 400);
    assert.ok(REG.calls.length >= 2 && REG.calls.every((c2) => c2.startsWith('GET /v2/')), `registry calls must be GET manifests only: ${REG.calls}`);
  });

  it('pull and delete are DISABLED by default: 403, and the Ollama server is never asked to pull/delete', async () => {
    const p = await S.api('POST', '/ollama/models/pull', { name: 'qwen2.5-coder:7b', confirm_size_bytes: 4.68e9 + 500 }, { allowFail: true });
    assert.equal(p.status, 403); assert.equal(p.json.code, 'disabled'); assert.match(p.json.error, /downloads disabled/);
    const d = await S.api('POST', '/ollama/models/delete', { name: 'deepseek-ocr:latest', confirm: 'deepseek-ocr:latest' }, { allowFail: true });
    assert.equal(d.status, 403);
    assert.equal(S.fake.state.pullCalls, 0); assert.equal(S.fake.state.deleteCalls, 0);
    assert.equal((await S.get('/ollama/status')).pull_enabled, false);
  });
});

describe('M9 pull/delete when explicitly enabled (fake Ollama + fake registry only)', () => {
  let S, REG;
  before(async () => {
    REG = await startFakeRegistry({ 'qwen2.5-coder:1.5b': 990e6, 'qwen2.5-coder:32b': 19.85e9, 'qwen2.5-coder:3b': 1.93e9, 'deepseek-r1:7b': 4.68e9 });
    S = await startServer({ env: { ORCH_ALLOW_MODEL_PULL: '1', ORCH_OLLAMA_REGISTRY: REG.url } });
  });
  after(async () => { await S.stop(); await REG.close(); });
  const pull = (name, size, o) => S.api('POST', '/ollama/models/pull', { name, confirm_size_bytes: size }, o || { allowFail: true });
  const job = (id) => S.waitFor(async () => { const j = await S.get(`/jobs/${id}`); return ['done', 'failed', 'cancelled'].includes(j.state) ? j : null; }, { what: 'pull job' });

  it('requires the verified size echo, refuses unknown/too-large/low-disk/installed, then streams progress', async () => {
    assert.equal((await pull('qwen2.5-coder:1.5b', undefined)).status, 400);
    assert.equal((await pull('qwen2.5-coder:1.5b', 123)).status, 400);
    assert.equal((await pull('ghost:1b', 1)).status, 400);
    assert.match((await pull('qwen2.5-coder:32b', 19.85e9 + 500)).json.error, /too large/);
    assert.equal((await pull('ornith:9b', 1)).status, 409);
    assert.equal(S.fake.state.pullCalls, 0, 'nothing was requested yet');
    const size = 990e6 + 500;
    const j0 = await pull('qwen2.5-coder:1.5b', size);
    assert.equal(j0.status, 202);
    const j = await job(j0.json.id);
    assert.equal(j.state, 'done'); assert.equal(j.percent, 100); assert.equal(S.fake.state.pullCalls, 1);
    assert.deepEqual(S.fake.state.requests.filter((r) => r.path === '/api/pull').map((r) => r.body), [{ model: 'qwen2.5-coder:1.5b', stream: true }]);
  });

  it('disk guard, failure and cancel', async () => {
    const S2 = await startServer({ env: { ORCH_ALLOW_MODEL_PULL: '1', ORCH_OLLAMA_REGISTRY: REG.url, ORCH_TEST_DISK_FREE: String(3e9) } });
    try {
      const r = await S2.api('POST', '/ollama/models/pull', { name: 'qwen2.5-coder:3b', confirm_size_bytes: 1.93e9 + 500 }, { allowFail: true });
      assert.equal(r.status, 400); assert.match(r.json.error, /not enough free disk/); assert.equal(S2.fake.state.pullCalls, 0);
    } finally { await S2.stop(); }
    S.fake.state.pullScript = [{ status: 'pulling manifest' }, { error: 'disk full (fake)' }];
    const f = await pull('qwen2.5-coder:3b', 1.93e9 + 500);
    const jf = await job(f.json.id); assert.equal(jf.state, 'failed'); assert.match(jf.error, /disk full/);
    S.fake.state.pullScript = [{ status: 'pulling manifest' }, { status: 'pulling x', total: 100, completed: 10 }, { __hang: true }];
    const c = await pull('qwen2.5-coder:3b', 1.93e9 + 500);
    await S.waitFor(async () => (await S.get(`/jobs/${c.json.id}`)).percent >= 10, { what: 'progress' });
    assert.equal((await pull('deepseek-r1:7b', 4.68e9 + 500)).status, 409, 'only one download at a time');
    assert.equal((await S.post(`/jobs/${c.json.id}/cancel`)).cancelled, true);
    assert.equal((await job(c.json.id)).state, 'cancelled');
    S.fake.state.pullScript = null;
  });

  it('registry unreachable -> refuse (no pull); delete needs confirm and is blocked for assigned/default models', async () => {
    const S3 = await startServer({ env: { ORCH_ALLOW_MODEL_PULL: '1' } }); // registry = closed port
    try {
      const r = await S3.api('POST', '/ollama/models/pull', { name: 'qwen2.5-coder:3b', confirm_size_bytes: 1 }, { allowFail: true });
      assert.equal(r.status, 400); assert.match(r.json.error, /cannot verify/); assert.equal(S3.fake.state.pullCalls, 0);
    } finally { await S3.stop(); }
    const del = (name, confirm) => S.api('POST', '/ollama/models/delete', { name, confirm }, { allowFail: true });
    assert.equal((await del('deepseek-ocr:latest', 'nope')).status, 400);
    await S.post('/models/roles', { role: 'review', model: 'deepseek-ocr:latest', options: {} });
    const blocked = await del('deepseek-ocr:latest', 'deepseek-ocr:latest'); assert.equal(blocked.status, 409); assert.match(blocked.json.error, /review/);
    assert.equal((await del('ornith:9b', 'ornith:9b')).status, 409, 'configured default model');
    assert.equal(S.fake.state.deleteCalls, 0);
    await S.post('/models/roles/clear', { role: 'review' });
    assert.equal((await del('deepseek-ocr:latest', 'deepseek-ocr:latest')).status, 200);
    assert.equal(S.fake.state.deleteCalls, 1);
  });
});

describe('M9 guards', () => {
  const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  it('registry access is read-only GET and confined to lib/registry.js; pull/delete only reachable through lib/models.js', () => {
    const r = src('lib/registry.js');
    assert.ok(!/method:\s*'(POST|PUT|DELETE|PATCH)'/.test(r)); assert.ok(/method: 'GET'/.test(r));
    const offenders = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'lib')).concat(['server.js', 'config.js'].map((x) => `../${x}`))) {
      const p = f.startsWith('..') ? f.slice(3) : `lib/${f}`; if (!p.endsWith('.js')) continue;
      const t = src(p);
      if (/registry\.ollama\.ai/.test(t) && p !== 'config.js') offenders.push(`${p}: registry host`);
      if (/\bollama\.(pull|deleteModel)\(/.test(t) && p !== 'lib/models.js') offenders.push(`${p}: pull/delete call`);
    }
    assert.deepEqual(offenders, []);
    assert.match(src('config.js'), /ALLOW_MODEL_PULL: env\.ORCH_ALLOW_MODEL_PULL === '1'/);
    const img = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) {
      if (!f.endsWith('.js')) continue;
      if (/\.images\s*=/.test(src(`lib/${f}`)) && f !== 'ollama.js') img.push(f);
    }
    assert.deepEqual(img, []);
  });
});

describe('M10 vision images stay inside the Ollama adapter', () => {
  it('moves images onto the user message and never leaves them as a top-level field', async () => {
    const { startFakeOllama } = require('./helpers/fake-ollama');
    const fake = await startFakeOllama();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-m10-'));
    try {
      const out = await new Promise((resolve, reject) => execFile(process.execPath, ['--no-warnings', '-e', `const { createAdapter } = require('./lib/ollama');
        (async () => { const o = createAdapter({ base: ${JSON.stringify(fake.url)} });
          const r = await o.chatStream({ model: 'deepseek-ocr:latest', messages: [{ role: 'user', content: 'see' }], images: ['AAAA'] }, {});
          console.log(JSON.stringify({ ok: r.ok })); })().catch((e) => { console.error(e); process.exit(1); });`], {
        cwd: ROOT, encoding: 'utf8',
        env: { ...process.env, ORCH_DB: path.join(dir, 'o.db'), ORCH_LOG_DIR: path.join(dir, 'logs'), ORCH_WORKTREES: path.join(dir, 'wt'), OLLAMA_API_BASE: fake.url },
      }, (err, stdout, stderr) => { if (err) reject(new Error(stderr || err.message)); else resolve(stdout); }));
      assert.match(out, /"ok":true/);
      const body = fake.state.requests.filter((q) => q.path === '/api/chat').at(-1).body;
      assert.equal(body.images, undefined);
      assert.deepEqual(body.messages.at(-1).images, ['AAAA']);
      assert.equal(fake.state.imageCalls, 1);
    } finally { await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
