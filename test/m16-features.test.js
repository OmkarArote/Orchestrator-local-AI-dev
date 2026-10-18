'use strict';
// M5: cross-repo Features (contract-first). Provider task in service A (project 1) -> contract artifact -> consumer task in service B (project 2).
// Temp DB + random port + stub aider; nothing touches the real DB. Portable (no shell-isms, os.tmpdir, realpaths).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startServer, makeRepo, git, sleep } = require('./helpers/harness');

const ROUTES = (files) => `STUB_APPEND<<${files}>>`;

describe('M5 cross-repo features', () => {
  let S, repoA, repoB, PA, PB, n = 0;
  before(async () => {
    S = await startServer();
    repoA = makeRepo(path.join(S.work, 'api-svc'), { 'README.md': '# api\n' });
    repoB = makeRepo(path.join(S.work, 'web-app'), { 'README.md': '# web\n' });
    PA = await S.addProject(repoA, 'ApiProj', 'true');
    PB = await S.addProject(repoB, 'WebProj', 'true');
  });
  after(async () => { await S.stop(); });

  const bodyOf = (o = {}) => {
    n += 1;
    return {
      project_id: PB.id, title: `Invoices ${n}`, brief: 'Create the invoices API in the API service and integrate it in the web app.',
      contract: o.contract === undefined ? 'POST /invoices -> 201 {id, total}\nGET /invoices/{id} -> 200 {id, total}' : o.contract,
      steps: [
        { project_id: PA.id, service_id: PA.serviceId, title: `provider ${n}`, engine: 'local', files: [`src/routes${n}.js`],
          prompt: o.provider || `add the invoice routes ${ROUTES(`router.post('/invoices', h);\\nrouter.get('/invoices/:id', h);`)}` },
        { project_id: PB.id, service_id: PB.serviceId, title: `consumer ${n}`, engine: 'local', files: [`src/client${n}.js`], prompt: o.consumer || 'call the invoices API' },
      ],
    };
  };
  const make = async (o) => S.post('/features', bodyOf(o));
  const detail = (id) => S.get(`/features/${id}`);
  const stepOf = (f, role) => f.steps.find((s) => s.role === role);
  const stubEntries = () => fs.readFileSync(S.env.STUB_AIDER_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const approvedAndStarted = async (f) => { await S.post(`/features/${f.id}/approve-contract`, {}); return S.post(`/features/${f.id}/start`, {}); };

  it('creates a feature across two projects: provider first, consumer second, all pending, gated by the contract', async () => {
    const f = await make();
    assert.equal(f.status, 'contract_pending');
    assert.equal(f.project_id, PB.id, 'owner project');
    assert.equal(f.steps.length, 2);
    assert.deepEqual(f.steps.map((s) => [s.step_no, s.role, s.project, s.status]), [[1, 'provider', 'ApiProj', 'pending'], [2, 'consumer', 'WebProj', 'pending']]);
    assert.equal(f.contracts.length, 1); assert.equal(f.contracts[0].status, 'proposed'); assert.equal(f.contracts[0].source, 'human');
    assert.equal(f.graph.edges.length, 1); assert.equal(f.graph.edges[0].from, stepOf(f, 'provider').id);
    const t = await S.get(`/tasks/${stepOf(f, 'consumer').id}`);
    assert.equal(t.feature_id, f.id); assert.equal(t.feature_role, 'consumer'); assert.ok(t.group_id);
    assert.ok((await S.get(`/features`)).some((x) => x.id === f.id));
    assert.ok((await S.get(`/features?project_id=${PA.id}`)).some((x) => x.id === f.id), 'listed under a participating (non-owner) project');
    // validation
    const bad = async (patch, re) => { const r = await S.post('/features', { ...bodyOf(), ...patch }, { allowFail: true }); assert.equal(r.status, 400, JSON.stringify(r.json)); if (re) assert.match(r.json.error, re); };
    await bad({ steps: [bodyOf().steps[0]] }, /2\.\.8/);
    await bad({ title: '' }, /title/);
    await bad({ project_id: 99999 }, /not found/);
    const b = bodyOf();
    await bad({ steps: [b.steps[0], { ...b.steps[1], service_id: undefined }] }, /service_id required/);
    await bad({ steps: [b.steps[0], { ...b.steps[1], service_id: 'auto' }] }, /service_id required/);
    await bad({ steps: [b.steps[0], { ...b.steps[0] }] }, /used twice/);
    await bad({ steps: [b.steps[0], { ...b.steps[1], engine: 'auto-route' }] }, /auto-route/);
    await bad({ steps: [b.steps[0], { ...b.steps[1], project_id: PA.id }] }, /not found in project/);
    await bad({ steps: [b.steps[0], { ...b.steps[1], plan_first: true }] }, /plan_first only applies to engine=cursor/);
  });

  it('contract-first: nothing starts without an approved contract; start = one approval for every pending step; provider then consumer, with the contract injected', async () => {
    const f = await make();
    const prov = stepOf(f, 'provider'), cons = stepOf(f, 'consumer');
    let r = await S.post(`/features/${f.id}/start`, {}, { allowFail: true });
    assert.equal(r.status, 409); assert.match(r.json.error, /approve the contract first/);
    assert.equal((await S.get(`/tasks/${prov.id}`)).status, 'pending', 'no step moved');
    assert.equal((await S.post(`/features/${f.id}/approve-contract`, { version: 7 }, { allowFail: true })).status, 409);
    assert.equal((await S.post(`/features/${f.id}/contract`, { content: '   ' }, { allowFail: true })).status, 400);
    const ap = await S.post(`/features/${f.id}/approve-contract`, {});
    assert.equal(ap.status, 'planned'); assert.equal(ap.contract.approved_version, 1);
    assert.equal((await S.get(`/tasks/${prov.id}`)).status, 'pending', 'approving the contract does not start anything');
    const st = await S.post(`/features/${f.id}/start`, {});
    assert.equal(st.status === 'running' || st.status === 'review', true);
    const pr = await S.waitStatus(prov.id, 'review'); const cr = await S.waitStatus(cons.id, 'review');
    assert.equal((await S.get(`/tasks/${prov.id}`)).approvals.some((a) => a.stage === 'start' && a.decision === 'approved' && /feature #\d+ start approved/.test(a.reason)), true);
    // ordering: the provider's aider run is logged before the consumer's
    const wtP = path.basename(pr.worktree_path), wtC = path.basename(cr.worktree_path);
    const log = stubEntries();
    const iP = log.findIndex((e) => e.cwd.includes(wtP)), iC = log.findIndex((e) => e.cwd.includes(wtC));
    assert.ok(iP >= 0 && iC >= 0 && iP < iC, `provider ran first (${iP} < ${iC})`);
    // contract captured from the provider's diff (deterministic) and injected
    const d = await detail(f.id);
    assert.equal(d.actuals.length, 1); assert.equal(d.actuals[0].kind, 'api_actual'); assert.equal(d.actuals[0].source, 'extracted'); assert.equal(d.actuals[0].task_id, prov.id);
    assert.match(d.actuals[0].content, /- POST \/invoices {3}\(src\/routes\d+\.js\)/); assert.match(d.actuals[0].content, /- GET \/invoices\/:id /);
    assert.equal(d.drift, null); assert.equal(d.last_compare.comparable, true); assert.equal(d.last_compare.drift, false);
    const bundle = (t) => fs.readFileSync(path.join(S.base, 'logs', 'context', `task-${t.id}`, 'CONTEXT.md'), 'utf8');
    const bc = bundle(cons);
    assert.match(bc, /## API CONTRACT \(v1, approved by a human\)/); assert.match(bc, /POST \/invoices -> 201/); assert.match(bc, /## PROVIDER'S IMPLEMENTATION/); assert.match(bc, /- GET \/invoices\/:id/);
    assert.match(bc, /You are a CONSUMER/); assert.match(bc, /Other steps: provider #\d+ ApiProj/);
    const bp = bundle(prov);
    assert.match(bp, /You are the PROVIDER/); assert.match(bp, /API CONTRACT \(v1/); assert.doesNotMatch(bp, /PROVIDER'S IMPLEMENTATION/);
    const ctx = JSON.parse((await S.get(`/tasks/${cons.id}`)).context_json);
    assert.ok(ctx.parts.some((p) => /^API CONTRACT/.test(p.name)) && ctx.parts.some((p) => /^PROVIDER'S IMPLEMENTATION/.test(p.name)), 'manifest lists the injected parts');
    assert.equal(d.status, 'review');
    // a normal (non-feature) task gets no feature parts
    const plain = await S.runToReview(PA.id, { title: 'plain', prompt: 'x', files: ['plain.txt'] });
    assert.doesNotMatch(bundle(plain), /API CONTRACT/);
  });

  it('merge guard: a consumer cannot be merged before its provider; a normal merge in order needs no override and records none', async () => {
    const f = await make();
    const prov = stepOf(f, 'provider'), cons = stepOf(f, 'consumer');
    await approvedAndStarted(f);
    await S.waitStatus(prov.id, 'review'); await S.waitStatus(cons.id, 'review');
    const headB = git(repoB, 'rev-parse', 'HEAD');
    let r = await S.post(`/tasks/${cons.id}/approve-merge`, {}, { allowFail: true });
    assert.equal(r.status, 409); assert.equal(r.json.merge_order_blocked, true); assert.equal(r.json.override_required, true); assert.equal(r.json.provider_task_id, prov.id);
    assert.match(r.json.error, /cannot be merged before its provider step/);
    r = await S.post(`/tasks/${cons.id}/approve-merge`, { override_reason: 'short' }, { allowFail: true });
    assert.equal(r.status, 409, 'a too-short typed reason does not override');
    r = await S.post(`/tasks/${cons.id}/approve-merge`, { reason: 'looks fine, merge it please' }, { allowFail: true });
    assert.equal(r.status, 409, 'the ordinary approval note is not an override');
    assert.equal((await S.get(`/tasks/${cons.id}`)).status, 'review'); assert.equal(git(repoB, 'rev-parse', 'HEAD'), headB, 'nothing merged');
    const mo = (await detail(f.id)).merge_order;
    assert.deepEqual(mo.map((x) => [x.role, x.order_ok, x.merged]), [['provider', true, false], ['consumer', false, false]]);
    assert.equal((await S.get(`/features/${f.id}/merge-plan`)).merge_order[1].blocked_by, prov.id);
    // in order: provider, then consumer without any override
    await S.post(`/tasks/${prov.id}/approve-merge`, {});
    assert.equal((await detail(f.id)).merge_order[1].order_ok, true);
    const done = await S.post(`/tasks/${cons.id}/approve-merge`, { override_reason: 'not needed here, must not be recorded' });
    assert.equal(done.status, 'done');
    const d = await detail(f.id);
    assert.equal(d.overrides.length, 0, 'no override recorded when none was needed');
    assert.equal(d.status, 'done');
    assert.equal((await S.get(`/tasks/${cons.id}`)).approvals.some((a) => /OVERRIDE/.test(a.reason || '')), false);
  });

  it('override: consumer-first merge needs a typed reason (>= 8 chars) and the override is recorded in the DB (artifact, approval, event)', async () => {
    const f = await make();
    const prov = stepOf(f, 'provider'), cons = stepOf(f, 'consumer');
    await approvedAndStarted(f);
    await S.waitStatus(prov.id, 'review'); await S.waitStatus(cons.id, 'review');
    const reason = 'provider PR is blocked on review; consumer is feature-flagged off';
    const r = await S.post(`/tasks/${cons.id}/approve-merge`, { override_reason: reason });
    assert.equal(r.status, 'done');
    const d = await detail(f.id);
    assert.equal(d.overrides.length, 1);
    assert.equal(d.overrides[0].reason, reason); assert.equal(d.overrides[0].task_id, cons.id); assert.equal(d.overrides[0].provider_task_id, prov.id); assert.equal(d.overrides[0].provider_status, 'review');
    assert.equal(d.merge_order[1].overridden, true);
    const t = await S.get(`/tasks/${cons.id}`);
    assert.ok(t.approvals.some((a) => a.stage === 'merge' && a.decision === 'approved' && a.reason.includes('MERGE-ORDER OVERRIDE') && a.reason.includes(reason)));
    const ev = await S.get(`/tasks/${cons.id}/events`);
    assert.ok(ev.some((e) => /MERGE-ORDER OVERRIDE by human/.test(e.message) && e.message.includes(reason)));
    assert.ok(ev.some((e) => /merge blocked by feature merge order/.test(e.message)) === false, 'no block event when the override was sent right away');
    // the row is in the real table (kind notes), not only in a response
    const db = new DatabaseSync(S.dbPath);
    try {
      const rows = db.prepare("SELECT kind, status, source, task_id, content FROM task_artifacts WHERE feature_id = ? AND kind = 'notes'").all(f.id);
      assert.equal(rows.length, 1); assert.equal(rows[0].task_id, cons.id); assert.equal(JSON.parse(rows[0].content).reason, reason);
    } finally { db.close(); }
    // the provider can still be merged afterwards
    await S.post(`/tasks/${prov.id}/approve-merge`, {});
    assert.equal((await detail(f.id)).status, 'done');
  });

  it('drift: provider implements something else than the contract -> consumers wait until a human accepts the actual (or ignores with a reason)', async () => {
    const f = await make({ provider: `add routes ${ROUTES(`router.post('/invoices', h);`)}` }); // contract also promises GET /invoices/{id}
    const prov = stepOf(f, 'provider'), cons = stepOf(f, 'consumer');
    await approvedAndStarted(f);
    await S.waitStatus(prov.id, 'review');
    const d = await S.waitFor(async () => { const x = await detail(f.id); return x.drift ? x : null; }, { what: 'drift flagged' });
    assert.equal(d.status, 'contract_drift'); assert.deepEqual(d.drift.missing, ['GET /invoices/{}']); assert.deepEqual(d.drift.extra, []);
    await sleep(1500);
    assert.equal((await S.get(`/tasks/${cons.id}`)).status, 'approved', 'consumer must not start while the contract drifts');
    // ignoring needs a typed reason
    assert.equal((await S.post(`/features/${f.id}/ignore-drift`, {}, { allowFail: true })).status, 400);
    assert.equal((await S.post(`/features/${f.id}/ignore-drift`, { reason: 'short' }, { allowFail: true })).status, 400);
    const acc = await S.post(`/features/${f.id}/accept-actual`, {});
    assert.equal(acc.drift, null);
    const newest = acc.contracts[acc.contracts.length - 1];
    assert.equal(newest.version, 2); assert.equal(newest.status, 'approved'); assert.equal(newest.source, 'extracted'); assert.equal(acc.contracts[0].status, 'superseded');
    const cr = await S.waitStatus(cons.id, 'review');
    assert.match(fs.readFileSync(path.join(S.base, 'logs', 'context', `task-${cons.id}`, 'CONTEXT.md'), 'utf8'), /API CONTRACT \(v2, approved by a human\)/);
    assert.equal(cr.status, 'review');
    // ignore path: a second drifting feature, resolved with a typed reason (recorded as a note)
    const g = await make({ provider: `add routes ${ROUTES(`router.post('/invoices', h);`)}` });
    await approvedAndStarted(g);
    await S.waitFor(async () => { const x = await detail(g.id); return x.drift ? x : null; }, { what: 'drift 2' });
    const ig = await S.post(`/features/${g.id}/ignore-drift`, { reason: 'GET by id ships in the next release' });
    assert.equal(ig.drift, null);
    await S.waitStatus(stepOf(g, 'consumer').id, 'review');
    const db = new DatabaseSync(S.dbPath);
    try { assert.equal(db.prepare("SELECT count(*) AS c FROM task_artifacts WHERE feature_id = ? AND kind = 'notes'").get(g.id).c, 1); } finally { db.close(); }
  });

  it('a newer contract version pauses steps that have not started until a human approves it', async () => {
    const f = await make();
    await S.post(`/features/${f.id}/approve-contract`, {});
    const v2 = await S.post(`/features/${f.id}/contract`, { content: 'POST /invoices -> 201 {id}\nGET /invoices/{id} -> 200' });
    assert.equal(v2.contract.proposed_version, 2); assert.equal(v2.contract.approved_version, 1);
    let r = await S.post(`/features/${f.id}/start`, {}, { allowFail: true });
    assert.equal(r.status, 409); assert.match(r.json.error, /waiting for approval/);
    await S.post(`/features/${f.id}/approve-contract`, {});
    await S.post(`/features/${f.id}/start`, {});
    await S.waitStatus(stepOf(f, 'consumer').id, 'review');
    r = await S.post(`/features/${f.id}/contract`, { content: 'x' }, { allowFail: true });
    assert.equal(r.status, 200, 'a feature that is still open accepts a new proposal');
  });

  it('provider failure halts the consumer ("not run"), the feature is failed; retry-step re-queues both as NEW pending tasks (approval gate again); cancel rejects the rest', async () => {
    const f = await make({ provider: 'STUB_FAIL do it' });
    const prov = stepOf(f, 'provider'), cons = stepOf(f, 'consumer');
    await approvedAndStarted(f);
    await S.waitStatus(prov.id, 'failed');
    const c = await S.waitStatus(cons.id, 'failed');
    assert.match(c.result_summary, /not run: provider step #\d+ \(.+\) is failed/);
    assert.equal(log2(await S.get(`/tasks/${cons.id}/events`)), true);
    assert.equal((await detail(f.id)).status, 'failed');
    assert.equal((await S.post(`/features/${f.id}/retry-step`, { task_id: cons.id }, { allowFail: true })).status, 200, 'a failed consumer alone can be retried');
    const again = await S.post(`/features/${f.id}/retry-step`, { task_id: prov.id });
    assert.equal(again.history.length, 2, 'both old tasks kept as history'); assert.ok(again.history.some((h) => h.id === prov.id));
    assert.ok(again.steps.every((s) => s.status === 'pending'), 'retries need a fresh start approval');
    assert.equal(again.steps.length, 2); assert.notEqual(stepOf(again, 'provider').id, prov.id);
    assert.equal((await S.post(`/features/${f.id}/retry-step`, { task_id: prov.id }, { allowFail: true })).status, 409, 'already replaced');
    assert.equal((await S.post(`/features/${f.id}/cancel`, {}, { allowFail: true })).status, 400);
    const cx = await S.post(`/features/${f.id}/cancel`, { reason: 'dropping this' });
    assert.equal(cx.status, 'cancelled'); assert.ok(cx.steps.every((s) => s.status === 'rejected'));
    assert.equal((await S.post(`/features/${f.id}/start`, {}, { allowFail: true })).status, 409);
    function log2(ev) { return ev.some((e) => /sequence step not run: provider step/.test(e.message)); }
  });

  it('authorized roots are enforced when a feature is created; nothing is created on refusal', async () => {
    const out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-m16-out-')));
    try {
      const inRepo = makeRepo(path.join(S.work, 'esc-repo'), { 'README.md': '# e\n' });
      const outRepo = makeRepo(path.join(out, 'outside-repo'), { 'README.md': '# o\n' });
      const PE = await S.addProject(inRepo, 'EscProj', 'true');
      const setLocalPath = (p) => { const db = new DatabaseSync(S.dbPath); try { db.exec('PRAGMA busy_timeout = 5000'); db.prepare('UPDATE services SET local_path = ? WHERE id = ?').run(p, PE.serviceId); } finally { db.close(); } };
      setLocalPath(outRepo);
      const before = { f: (await S.get('/features')).length, t: (await S.get('/tasks')).length };
      const b = bodyOf();
      const r = await S.post('/features', { ...b, steps: [b.steps[0], { ...b.steps[1], project_id: PE.id, service_id: PE.serviceId }] }, { allowFail: true });
      assert.equal(r.status, 409, JSON.stringify(r.json)); assert.match(r.json.error, /step 2: service '.+' is not usable: .*outside the authorized roots/);
      assert.deepEqual({ f: (await S.get('/features')).length, t: (await S.get('/tasks')).length }, before, 'no feature and no task created');
      setLocalPath(inRepo);
      assert.equal((await S.post('/features', { ...b, steps: [b.steps[0], { ...b.steps[1], project_id: PE.id, service_id: PE.serviceId }] }, { allowFail: true })).status, 201, 'usable again once inside the roots');
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
  });

  it('deleting services/projects: used services stay (archive), the owner project is refused while other projects have unfinished steps; afterwards rows go, other projects keep their history', async () => {
    const mk = async (name) => { const r = makeRepo(path.join(S.work, `del-${name}`), { 'README.md': `# ${name}\n` }); return S.addProject(r, name, 'true'); };
    const [D1, D2, D3] = [await mk('Del-owner'), await mk('Del-prov'), await mk('Del-cons')];
    const body = (owner, a, b, title) => ({ project_id: owner.id, title, contract: 'GET /ping', steps: [
      { project_id: a.id, service_id: a.serviceId, title: `${title} p`, prompt: 'p', files: ['p.txt'], engine: 'local' },
      { project_id: b.id, service_id: b.serviceId, title: `${title} c`, prompt: 'c', files: ['c.txt'], engine: 'local' }] });
    const f1 = await S.post('/features', body(D1, D2, D3, 'F1'));
    // service with a step in its history cannot be unregistered
    const rs = await S.raw('POST', `/api/services/${D2.serviceId}/remove`, { confirm: (await S.get(`/projects/${D2.id}/services`))[0].name });
    assert.equal(rs.status, 409); assert.match(rs.json.error, /archive it instead/);
    // the owner project has no task of its own, but steps elsewhere are unfinished
    let r = await S.raw('POST', `/api/projects/${D1.id}/delete`, { confirm: 'Del-owner' });
    assert.equal(r.status, 409); assert.match(r.json.error, /cross-repo feature\(s\) with unfinished steps in other projects/); assert.match(r.json.error, new RegExp(`feature #${f1.id}`));
    assert.equal((await detail(f1.id)).id, f1.id, 'nothing was deleted');
    // a participating project with unfinished steps is refused by the generic rule
    r = await S.raw('POST', `/api/projects/${D2.id}/delete`, { confirm: 'Del-prov' });
    assert.equal(r.status, 409); assert.match(r.json.error, /unfinished tasks/);
    await S.post(`/features/${f1.id}/cancel`, { reason: 'cleanup' });
    const tid = stepOf(f1, 'consumer').id;
    // delete the owner: allowed now; the steps in the other projects keep their rows but leave the feature
    r = await S.raw('POST', `/api/projects/${D1.id}/delete`, { confirm: 'Del-owner' });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.ok(r.json.rows.foreign_steps_detached >= 2, JSON.stringify(r.json.rows));
    assert.equal((await S.get(`/features/${f1.id}`, { allowFail: true })).status, 404);
    const t = await S.get(`/tasks/${tid}`);
    assert.equal(t.status, 'rejected'); assert.equal(t.feature_id, null); assert.equal(t.group_id, null); assert.ok(t.approvals.length >= 1, 'history kept');
    // a feature owned by a surviving project whose provider project is deleted: still readable, the guard no longer blocks the consumer
    const f2 = await S.post('/features', body(D3, D2, D3, 'F2').steps ? { ...body(D3, D2, D3, 'F2') } : {});
    await S.post(`/features/${f2.id}/cancel`, { reason: 'cleanup 2' });
    r = await S.raw('POST', `/api/projects/${D2.id}/delete`, { confirm: 'Del-prov' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const left = await detail(f2.id);
    assert.equal(left.steps.length, 1); assert.equal(left.steps[0].role, 'consumer'); assert.equal(left.steps[0].merge_blocked, null);
    r = await S.raw('POST', `/api/projects/${D3.id}/delete`, { confirm: 'Del-cons' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await S.get(`/features/${f2.id}`, { allowFail: true })).status, 404);
    assert.equal((await S.get('/health')).ok, true);
  });

  it('existing gates stay: a Cursor consumer with plan_first stops at awaiting_plan (human approves the plan), never auto-merges, and no step merged by itself', async () => {
    const b = bodyOf();
    b.steps[1] = { ...b.steps[1], engine: 'cursor', model: 'auto', plan_first: true };
    const f = await S.post('/features', b);
    const prov = stepOf(f, 'provider'), cons = stepOf(f, 'consumer');
    await approvedAndStarted(f);
    await S.waitStatus(prov.id, 'review');
    await S.waitStatus(cons.id, 'awaiting_plan');
    await sleep(800);
    assert.equal((await S.get(`/tasks/${cons.id}`)).status, 'awaiting_plan', 'waits for the human plan approval');
    assert.equal((await detail(f.id)).status, 'running');
    await S.post(`/tasks/${cons.id}/approve-plan`, {});
    await S.waitStatus(cons.id, 'review');
    assert.equal((await S.get(`/tasks/${prov.id}`)).status, 'review', 'nothing merged by itself');
    assert.equal((await detail(f.id)).status, 'review');
  });

  it('extraction + comparison unit checks (deterministic, no LLM): express/flask/spring/openapi, path-param normalisation', async () => {
    const out = await new Promise((resolve, reject) => {
      const cp = require('node:child_process').spawn(process.execPath, ['--no-warnings', '-e', `
        const f = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'features.js'))});
        const diff = [
          'diff --git a/api/app.py b/api/app.py', '+++ b/api/app.py', "+@app.route('/orders/<int:oid>', methods=['PUT', 'DELETE'])", "+@router.get('/orders')",
          'diff --git a/src/Orders.java b/src/Orders.java', '+++ b/src/Orders.java', '+@PostMapping("/orders/{id}/ship")',
          'diff --git a/docs/openapi.yaml b/docs/openapi.yaml', '+++ b/docs/openapi.yaml', '+  /users/{id}:', '+    get:', '+    delete:',
          'diff --git a/srv/main.go b/srv/main.go', '+++ b/srv/main.go', '+r.POST("/pay/:id", h)',
        ].join('\\n');
        const e = f.extractFromDiff(diff);
        const keys = e.endpoints.map(f.endpointKey).sort();
        console.log(JSON.stringify({ keys, cmp: f.compare('PUT /orders/{id}, GET /orders and POST /pay/{x}', e), free: f.compare('just prose, no routes', e) }));
      `], { env: { ...process.env, ORCH_DB: path.join(S.base, 'unit.db'), ORCH_LOG_DIR: path.join(S.base, 'unit-logs'), ORCH_WORKTREES: path.join(S.base, 'unit-wt') } });
      let o = '', er = ''; cp.stdout.on('data', (d) => { o += d; }); cp.stderr.on('data', (d) => { er += d; });
      cp.on('exit', (c) => (c === 0 ? resolve(o) : reject(new Error(er)))); cp.on('error', reject);
    });
    const r = JSON.parse(out.trim().split('\n').pop());
    assert.deepEqual(r.keys, ['DELETE /orders/{}', 'DELETE /users/{}', 'GET /orders', 'GET /users/{}', 'POST /orders/{}/ship', 'POST /pay/{}', 'PUT /orders/{}']);
    assert.equal(r.cmp.comparable, true); assert.equal(r.cmp.drift, true); assert.deepEqual(r.cmp.missing, []); assert.ok(r.cmp.extra.includes('POST /orders/{}/ship'));
    assert.deepEqual(r.free, { comparable: false, drift: false, missing: [], extra: [] });
  });

  it('API surface: unknown ids/endpoints and methods are refused; no /api/chat route is used', async () => {
    assert.equal((await S.get('/features/99999', { allowFail: true })).status, 404);
    assert.equal((await S.raw('DELETE', '/api/features')).status, 405);
    const f = await make();
    assert.equal((await S.raw('POST', `/api/features/${f.id}`, {})).status, 405);
    assert.equal((await S.raw('GET', `/api/features/${f.id}/start`)).status, 405);
    assert.equal((await S.raw('POST', `/api/features/${f.id}/nope`, {})).status, 404);
    assert.equal((await S.post(`/features/${f.id}/retry-step`, { task_id: 99999 }, { allowFail: true })).status, 404);
    assert.equal((await S.post(`/features/${f.id}/accept-actual`, {}, { allowFail: true })).status, 409, 'no extracted API yet');
  });
});
