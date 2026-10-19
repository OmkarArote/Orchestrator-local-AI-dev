'use strict';
// M6 planner: validate the JSON plan, retry a bad local reply once, then hand off to the injected Cursor planner.
require('./helpers/temp-env');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validatePlan, planLocal, planCursor } = require('../lib/flow/plan');

const GOOD = JSON.stringify({
  targetBranch: 'feature/city_filter',
  steps: [{ id: '1', file: 'src/a.js', intent: 'fix greet', acceptance: 'greet returns hello', estLines: 4 }],
  risk: { files: 1, crossModule: false, contract: false, estDiff: 4 },
});

describe('M36 planner', () => {
  it('rejects a plan with no steps and accepts the step schema', () => {
    assert.equal(validatePlan('not json').ok, false);
    assert.equal(validatePlan({ steps: [] }).ok, false);
    assert.equal(validatePlan({ steps: [{ file: '../x.js', intent: 'x' }] }).ok, false);
    const v = validatePlan(GOOD);
    assert.equal(v.ok, true);
    assert.equal(v.plan.steps[0].file, 'src/a.js');
    assert.equal(v.plan.risk.estDiff, 4);
    assert.equal(v.plan.targetBranch, 'feature/city_filter');
  });

  it('uses a valid local JSON plan and does not call Cursor', async () => {
    let calls = 0;
    const chat = async (body) => {
      calls++;
      assert.equal(body.format, 'json');
      assert.equal(body.think, false);
      return { ok: true, content: GOOD };
    };
    let cursor = 0;
    const r = await planLocal({ task: { prompt: 'fix greet in src/a.js' }, model: 'ornith:9b' }, { files: [] }, { chat, model: 'ornith:9b' });
    assert.equal(r.ok, true);
    assert.equal(r.source, 'local');
    assert.equal(r.attempts, 1);
    assert.equal(calls, 1);
    assert.equal(cursor, 0);
    assert.equal(r.plan.steps[0].file, 'src/a.js');
  });

  it('retries invalid JSON once and then the Cursor planner turns named files into steps', async () => {
    let calls = 0;
    const chat = async () => { calls++; return { ok: true, content: calls === 1 ? 'sure' : '{"nope":true}' }; };
    const local = await planLocal({ task: { prompt: 'edit src/a.js' } }, null, { chat, model: 'ornith:9b' });
    assert.equal(local.ok, false);
    assert.equal(calls, 2);
    const cursor = await planCursor(
      { task: { prompt: 'edit src/a.js and lib/b.js' } },
      { files: [] },
      async () => ({ ok: true, plan: 'Change src/a.js and lib/b.js so the greeting is shared.', text: 'Change src/a.js and lib/b.js so the greeting is shared.' }),
    );
    assert.equal(cursor.ok, true);
    assert.equal(cursor.source, 'cursor-files');
    assert.deepEqual(cursor.plan.steps.map((s) => s.file), ['src/a.js', 'lib/b.js']);
  });

  it('keeps a Cursor reply that is already a valid plan', async () => {
    const cursor = await planCursor({ task: { prompt: 'edit src/a.js' } }, null, async () => ({ ok: true, plan: GOOD, text: GOOD, model: 'auto' }));
    assert.equal(cursor.ok, true);
    assert.equal(cursor.source, 'cursor');
    assert.equal(cursor.plan.steps.length, 1);
  });
});
