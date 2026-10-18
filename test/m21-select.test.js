'use strict';
// M9: deterministic model choice. The pure function never downloads and never returns a cloud engine.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { selectModel } = require('../lib/model-select');
const { startServer, sleep } = require('./helpers/harness');

const m = (over) => ({ name: 'a', capabilities: ['completion'], context_length: 8192, weights_gb: 5, strengths: ['general'], fit: 'recommended', ...over });

describe('M9 selectModel', () => {
  it('is deterministic and prefers a strength match that is already loaded', () => {
    const input = { taskKind: 'code_edit', installed: [m({ name: 'small', weights_gb: 2, strengths: ['general'] }), m({ name: 'coder', weights_gb: 5, strengths: ['code'] })], loaded: ['coder'], roles: { default: 'small' } };
    const a = selectModel(input), b = selectModel(input);
    assert.equal(a.model, 'coder');
    assert.equal(a.rule, 'auto');
    assert.deepEqual(a.score_table, b.score_table);
    assert.ok(a.score_table[0].parts.some((p) => p.startsWith('+40')));
    assert.ok(a.score_table[0].parts.some((p) => p.startsWith('+25')));
  });

  it('tie-breaks toward the smaller model, then the name', () => {
    const r = selectModel({ taskKind: 'chat_text', installed: [m({ name: 'b', weights_gb: 4, strengths: ['general'] }), m({ name: 'a', weights_gb: 4, strengths: ['general'] }), m({ name: 'c', weights_gb: 8, strengths: ['general'] })] });
    assert.equal(r.model, 'a');
  });

  it('returns none with the missing capability and a download suggestion, never a model', () => {
    const r = selectModel({ taskKind: 'image_qa', installed: [m({ name: 'text' })], prefs: { suggestions: [{ name: 'qwen3-vl:4b-instruct', weights_gb: 3.3, capabilities_expected: ['vision'] }] } });
    assert.equal(r.model, null);
    assert.equal(r.rule, 'none');
    assert.equal(r.missing, 'vision');
    assert.match(r.reason.join(' '), /vision/);
    assert.equal(r.suggestion.name, 'qwen3-vl:4b-instruct');
  });

  it('drops too_large models and anything that is not an Ollama name', () => {
    const r = selectModel({ taskKind: 'chat_text', installed: [m({ name: 'huge', fit: 'too_large' }), m({ name: 'cursor/gpt-5', strengths: ['general'] }), m({ name: 'ok', weights_gb: 1 })] });
    assert.equal(r.model, 'ok');
    assert.ok(!r.score_table.some((s) => s.model.includes('/')));
  });

  it('defers when a local task holds the GPU and the best choice would swap', () => {
    const r = selectModel({ taskKind: 'code_edit', installed: [m({ name: 'loaded', strengths: ['general'], weights_gb: 6, fit: 'tight' }), m({ name: 'coder', strengths: ['code'], weights_gb: 5 })], loaded: ['loaded'], prefs: { taskRunning: true } });
    assert.equal(r.rule, 'defer');
    assert.equal(r.swap.needed, true);
    assert.match(r.reason[0], /GPU/);
  });

  it('an explicit choice wins and is not corrected', () => {
    const r = selectModel({ taskKind: 'code_edit', installed: [m({ name: 'coder', strengths: ['code'] }), m({ name: 'other' })], prefs: { explicit: 'other' } });
    assert.equal(r.model, 'other');
    assert.equal(r.rule, 'explicit');
  });
});

describe('M9 resolve over HTTP', () => {
  let S;
  before(async () => { S = await startServer(); });
  after(async () => { if (S) await S.stop(); });

  it('accepts auto for chat and refuses it for routing and as the global default', async () => {
    assert.equal((await S.post('/models/roles', { role: 'chat', model: 'auto' })).model, 'auto');
    assert.equal((await S.post('/models/roles', { role: 'routing', model: 'auto' }, { allowFail: true })).status, 400);
    assert.equal((await S.post('/models/default', { model: 'auto' }, { allowFail: true })).status, 400);
  });

  it('a conversation set to auto sends an installed model and records the reason', async () => {
    const c = await S.post('/conversations', { model: 'auto' });
    assert.equal(c.model, 'auto');
    const r = await fetch(`${S.url}/api/conversations/${c.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hello' }) });
    const text = await r.text();
    assert.match(text, /event: done/);
    const body = S.fake.state.requests.filter((q) => q.path === '/api/chat' && q.body && q.body.stream).at(-1).body;
    assert.equal(body.model, 'ornith:9b');
    const conv = await S.get(`/conversations/${c.id}`);
    const asst = conv.messages.find((m) => m.role === 'assistant');
    assert.equal(asst.context.context.auto.model, 'ornith:9b');
    assert.equal(asst.context.context.auto.rule, 'auto');
    await sleep(10);
  });
});
