'use strict';
// .ai/ export commits the managed copy on a NEW branch of ONE chosen service repo and registers a review task.
// ADAPTED for the refactor (intentional behaviour change, decision Q3): import/export are OFF by default and opt-in per project (config.ai_dir).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startServer, makeRepo, git } = require('./helpers/harness');

describe('M0 context export / import (.ai/)', () => {
  let S, repo, P;
  before(async () => {
    S = await startServer();
    repo = makeRepo(path.join(S.work, 'exp'), { 'hello.txt': 'hi\n' });
    P = await S.addProject(repo, 'exp', 'true');
  });
  after(async () => { await S.stop(); });

  it('export -> review task on branch ai/context-update-*, main untouched; merge; import', async () => {
    await S.post(`/projects/${P.id}/context/save`, { file: 'RULES.md', content: '# R\n- rule A\n' });
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const body = {};
    // default OFF: nothing touches the repo until the user opts in
    const off = await S.raw('POST', `/api/projects/${P.id}/context/export`, {});
    assert.equal(off.status, 409);
    assert.equal((await S.raw('POST', `/api/projects/${P.id}/context/import`, {})).status, 409);
    assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), head);
    await S.post(`/projects/${P.id}/update`, { config: { ai_dir: { service_id: P.serviceId, import: true, export: true } } });
    const ex = await S.post(`/projects/${P.id}/context/export`, body);
    assert.equal(ex.changed, true);
    assert.match(ex.branch, /^ai\/context-update-/);
    assert.equal(ex.task.status, 'review');
    assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), head, 'main untouched');
    assert.match(git(repo, 'show', `${ex.branch}:.ai/RULES.md`), /rule A/);
    await S.post(`/tasks/${ex.task.id}/approve-merge`, {});
    assert.match(git(repo, 'show', 'main:.ai/RULES.md'), /rule A/);
    await new Promise((r) => setTimeout(r, 1100)); // branch names have 1s resolution (latent v3 bug: two exports in the same second collide)
    const same = await S.post(`/projects/${P.id}/context/export`, body);
    assert.equal(same.changed, false);
    // diverge the managed copy, then import from the repo default branch
    await S.post(`/projects/${P.id}/context/save`, { file: 'RULES.md', content: 'changed locally\n' });
    const cx = await S.get(`/projects/${P.id}/context`);
    assert.equal(cx.files.find((f) => f.name === 'RULES.md').repo_state, 'differs');
    const imp = await S.post(`/projects/${P.id}/context/import`, {});
    assert.ok(imp.imported.includes('RULES.md'));
    assert.match((await S.get(`/projects/${P.id}/context`)).files.find((f) => f.name === 'RULES.md').content, /rule A/);
  });
});
