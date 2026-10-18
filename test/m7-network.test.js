'use strict';
// M7: the ONE real-network test: a public https clone of a tiny public repo (octocat/Hello-World). Opt-in: ORCH_NET_TEST=1.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers/harness');

describe('M7 real https clone (public repo)', { skip: process.env.ORCH_NET_TEST !== '1' && 'set ORCH_NET_TEST=1 to run the single real-network clone test' }, () => {
  let S;
  before(async () => { S = await startServer(); });
  after(async () => { await S.stop(); });
  it('clones https://github.com/octocat/Hello-World.git through the import job (no ORCH_TEST_ALLOW_FILE)', async () => {
    const P = (await S.post('/projects', { name: 'net' })).project;
    const j0 = await S.post(`/projects/${P.id}/services/import`, { url: 'https://github.com/octocat/Hello-World.git', name: 'hello', dir_name: 'hello' });
    const j = await S.waitFor(async () => { const x = await S.get(`/jobs/${j0.id}`); return ['done', 'failed', 'cancelled'].includes(x.state) ? x : null; }, { timeout: 120000, what: 'clone job' });
    assert.equal(j.state, 'done', JSON.stringify(j));
    const svc = j.result.service;
    assert.equal(svc.origin, 'import'); assert.equal(svc.remote_url, 'https://github.com/octocat/Hello-World.git');
    assert.ok(fs.existsSync(path.join(svc.local_path, 'README')), 'README present');
    assert.equal(fs.readdirSync(S.work).filter((n) => n.startsWith('.orch-clone-')).length, 0);
    console.log('# real clone ok:', svc.default_branch, j.elapsed_ms + 'ms');
    // a second import of the same remote is refused (duplicate)
    const dup = await S.api('POST', `/projects/${P.id}/services/import`, { url: 'https://github.com/octocat/hello-world', name: 'hello2', dir_name: 'hello2' }, { allowFail: true });
    assert.equal(dup.status, 409);
  });
});
