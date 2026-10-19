'use strict';
// Swap-relook fix 6: aider gets think:false for thinking-capable local models (litellm sends it as Ollama's top-level `think`), via the
// model-settings file written for the model aider ACTUALLY runs. Non-thinking models get nothing, ORCH_AIDER_THINK=1 keeps the default.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo } = require('./helpers/harness');

const lastAider = (S) => JSON.parse(fs.readFileSync(path.join(S.base, 'stub-aider.log'), 'utf8').trim().split('\n').pop());

describe('M28 aider think:false for thinking models', () => {
  let S, P;
  before(async () => {
    S = await startServer();
    P = await S.addProject(makeRepo(path.join(S.work, 'th'), { 'a.txt': 'a\n' }), 'th', 'true');
  });
  after(async () => { await S.stop(); });

  it('thinking model (ornith:9b): think:false; non-thinking coding model: no settings file at all', async () => {
    await S.runToReview(P.id, { title: 'a', prompt: 'edit', files: ['a.txt'], engine: 'local' });
    let rec = lastAider(S);
    assert.equal(rec.settings, '- name: ollama_chat/ornith:9b\n  extra_params:\n    think: false\n');
    await S.post('/models/roles', { role: 'coding', model: 'deepseek-ocr:latest', options: {} });
    await S.runToReview(P.id, { title: 'b', prompt: 'edit', files: ['a.txt'], engine: 'local' });
    rec = lastAider(S);
    assert.equal(rec.model, 'ollama_chat/deepseek-ocr:latest'); assert.equal(rec.settings, null); assert.ok(!rec.args.includes('--model-settings-file'));
    await S.post('/models/roles/clear', { role: 'coding' });
  });

  it('an explicit coding-role think option wins and is validated (warning when turned on)', async () => {
    const r = await S.post('/models/roles', { role: 'coding', model: 'ornith:9b', options: { think: 'low' } });
    assert.ok((r.warnings || []).some((w) => /passed to aider/.test(w)));
    await S.runToReview(P.id, { title: 'c', prompt: 'edit', files: ['a.txt'], engine: 'local' });
    assert.equal(lastAider(S).settings, '- name: ollama_chat/ornith:9b\n  extra_params:\n    think: "low"\n');
    await S.post('/models/roles/clear', { role: 'coding' });
  });

  it('ORCH_AIDER_THINK=1 sends nothing (model default)', async () => {
    const S2 = await startServer({ env: { ORCH_AIDER_THINK: '1' } });
    try {
      const P2 = await S2.addProject(makeRepo(path.join(S2.work, 'th2'), { 'a.txt': 'a\n' }), 'th2', 'true');
      await S2.runToReview(P2.id, { title: 'a', prompt: 'edit', files: ['a.txt'], engine: 'local' });
      assert.equal(lastAider(S2).settings, null);
    } finally { await S2.stop(); }
  });
});
