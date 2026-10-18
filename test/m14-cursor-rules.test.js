'use strict';
// M14 (plan M4): per-service Cursor rules. Generation content, marker/idempotency, hand-written files untouched, review-branch-only commit,
// no write without approval, authorized-root / symlink refusal, stale detection, and the rules of THIS repository itself.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { startServer, makeRepo, git, fingerprint, ROOT } = require('./helpers/harness');

function probe(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-m14-'));
  return new Promise((resolve, reject) => execFile(process.execPath, ['--no-warnings', '-e', code], { cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, ORCH_DB: path.join(dir, 'o.db'), ORCH_LOG_DIR: path.join(dir, 'logs'), ORCH_WORKTREES: path.join(dir, 'wt') } },
  (err, stdout, stderr) => { fs.rmSync(dir, { recursive: true, force: true }); if (err) return reject(new Error(`${err.message}\n${stderr}`)); resolve(JSON.parse(stdout.trim().split('\n').pop())); }));
}
const cr = (pid, q = '') => `/projects/${pid}/cursor-rules${q}`;
const branches = (repo) => git(repo, 'branch', '--list', 'ai/cursor-rules-*').split('\n').map((l) => l.replace(/^[*+\s]+/, '')).filter(Boolean);
const lsFiles = (repo, rev) => git(repo, 'ls-tree', '-r', '--name-only', rev).split('\n').filter(Boolean);
const find = (pv, suffix) => pv.files.find((f) => f.dest.endsWith(suffix));

describe('M14 cursor rules: generation, approval, review branch, idempotency', () => {
  let S, repo, P, SVC, API;
  const HOME_LEAK = '/Users/someone/secret-project';
  before(async () => {
    S = await startServer();
    repo = makeRepo(path.join(S.work, 'mono'), { 'README.md': '# mono\n', 'services/api/package.json': '{"name":"api"}\n', 'services/api/src/index.js': 'module.exports = 1;\n' });
    P = await S.addProject(repo, 'Rules-Demo', 'npm test');
    SVC = P.serviceId;
    API = await S.post(`/projects/${P.id}/services`, { name: 'api', path: 'services/api', description: 'HTTP API', check_cmd: 'npm run check' });
    await S.post(`/projects/${P.id}/context/save`, { file: 'RULES.md', content: '# Rules\n- Keep tests green.\n- Never edit migrations.\n' });
    await S.post(`/projects/${P.id}/context/save`, { file: 'ARCHITECTURE.md', content: '# Architecture\nA small API in front of a database.\n' });
    await S.post(`/projects/${P.id}/context/save`, { file: 'MEMORY.md', content: `# Memory\n\n## 2026-01-01\n- Decided to use sqlite. API_KEY=abcd1234efgh5678ijkl\n- Old checkout lived in ${HOME_LEAK}\n` });
    await S.post(`/projects/${P.id}/context/save`, { file: 'services/api.md', content: '# api notes\n- Errors use the {error} shape.\n' });
  });
  after(async () => { await S.stop(); });

  it('preview renders proper frontmatter, markers, scoped globs, an AGENTS.md pointer, and leaks neither paths nor secrets; it is read-only', async () => {
    const before = fingerprint(repo);
    const pv = await S.get(cr(P.id, `/preview?service_id=${API.id}`));
    assert.equal(fingerprint(repo), before, 'preview does not touch the repo');
    assert.equal(pv.status, 'not_generated'); assert.equal(pv.enabled, false);
    assert.deepEqual(pv.files.map((f) => f.dest).sort(), ['.cursor/rules/rules-demo-architecture.mdc', '.cursor/rules/rules-demo-memory.mdc', '.cursor/rules/rules-demo-rules.mdc', '.cursor/rules/rules-demo-service-api.mdc', 'services/api/AGENTS.md']);
    const lint = await probe(`const c = require('./lib/cursor-rules'); const files = ${JSON.stringify(pv.files.filter((f) => f.kind === 'rule').map((f) => f.content))}; console.log(JSON.stringify(files.map((t) => ({ l: c.lint(t, { generated: true }), fm: c.parseFrontmatter(t).data }))));`);
    for (const x of lint) assert.ok(x.l.ok, JSON.stringify(x.l)), assert.ok(!x.l.warnings.length, JSON.stringify(x.l.warnings));
    const fm = (suffix) => lint[pv.files.filter((f) => f.kind === 'rule').findIndex((f) => f.dest.endsWith(suffix))].fm;
    assert.deepEqual(fm('-rules.mdc'), { description: 'Project rules for Rules-Demo (generated from RULES.md)', alwaysApply: true, globs: '' });
    assert.equal(fm('-architecture.mdc').alwaysApply, false); assert.match(fm('-memory.mdc').description, /memory/i);
    assert.equal(fm('-service-api.mdc').globs, 'services/api/**'); assert.equal(fm('-service-api.mdc').alwaysApply, false);
    const all = pv.files.map((f) => f.content).join('\n');
    assert.match(find(pv, '-rules.mdc').content, /Never edit migrations/);
    assert.match(find(pv, '-service-api.mdc').content, /Errors use the \{error\} shape/); assert.match(find(pv, '-service-api.mdc').content, /npm run check/);
    assert.match(find(pv, '-memory.mdc').content, /Decided to use sqlite/);
    for (const f of pv.files) assert.match(f.content, /<!-- generated-by: local-ai-dev-orchestrator cursor-rules v1/, f.dest);
    assert.ok(!all.includes('abcd1234efgh5678'), 'secret-looking value redacted'); assert.match(all, /API_KEY=\[REDACTED\]/);
    assert.ok(!all.includes(HOME_LEAK) && !all.includes('/Users/someone'), 'home paths masked'); assert.ok(!all.includes(S.work) && !/- Repo:/.test(all), 'local checkout path of the service map never lands in the repo');
    const agents = find(pv, 'AGENTS.md').content;
    assert.match(agents, /\.cursor\/rules\/rules-demo-rules\.mdc/); assert.match(agents, /npm run check/);
    assert.ok(pv.warnings.some((w) => /redacted/.test(w)) && pv.notes.some((w) => /replaced by ~/.test(w)));
    assert.ok(pv.stats.always_tokens > 0 && pv.stats.always_tokens <= 600);
    assert.match(pv.commit_identity, /AI Dev Orchestrator <ai-orchestrator@localhost>/);
    // the root service gets the root AGENTS.md and no glob
    const rootPv = await S.get(cr(P.id, `/preview?service_id=${SVC}`));
    assert.ok(rootPv.files.some((f) => f.dest === 'AGENTS.md')); assert.equal(rootPv.files.find((f) => f.dest === '.cursor/rules/rules-demo-service-rules-demo.mdc').globs, '');
  });

  it('nothing is written without opt-in, an explicit approve and the digest of the preview', async () => {
    const before = fingerprint(repo), pv = await S.get(cr(P.id, `/preview?service_id=${API.id}`));
    const gen = (b, o) => S.post(cr(P.id, '/generate'), { service_id: API.id, ...b }, { allowFail: true, ...o });
    assert.equal((await gen({})).status, 400, 'no approve');
    assert.equal((await gen({ approve: 'true', digest: pv.digest })).status, 400, 'approve must be the boolean true');
    assert.equal((await gen({ approve: true })).status, 400, 'digest required');
    const noOptin = await gen({ approve: true, digest: pv.digest }); assert.equal(noOptin.status, 409); assert.match(noOptin.json.error, /not enabled/);
    const en = await S.post(cr(P.id, '/optin'), { service_id: API.id, enabled: true }); assert.equal(en.enabled, true);
    const stale = await gen({ approve: true, digest: 'deadbeef' }); assert.equal(stale.status, 409); assert.match(stale.json.error, /out of date/);
    assert.equal((await S.post(cr(P.id, '/generate'), { service_id: 999999, approve: true, digest: pv.digest }, { allowFail: true })).status, 404);
    assert.equal(fingerprint(repo), before, 'repo untouched by every refused attempt');
    assert.deepEqual(branches(repo), []);
    const ov = await S.get(cr(P.id)); assert.equal(ov.services.find((s) => s.service_id === API.id).enabled, true); assert.equal(ov.services.find((s) => s.service_id === SVC).enabled, false);
    await S.post(`/projects/${P.id}/update`, { config: { ai_dir: null } }); // saving the Settings tab must not drop the opt-in
    const p2 = await S.get(`/projects/${P.id}`); assert.deepEqual(p2.config.cursor_rules.service_ids, [API.id]);
  });

  let task1, branch1, pvBefore;
  it('approved generation commits ONLY on a new review branch (default branch and checkout untouched) and registers a review task', async () => {
    const headMain = git(repo, 'rev-parse', 'main').trim(), statusBefore = git(repo, 'status', '--porcelain');
    pvBefore = await S.get(cr(P.id, `/preview?service_id=${API.id}`));
    const r = await S.post(cr(P.id, '/generate'), { service_id: API.id, approve: true, digest: pvBefore.digest });
    assert.equal(r.changed, true); assert.match(r.branch, /^ai\/cursor-rules-api-\d{8}-\d{6}-[0-9a-f]{4}$/); assert.equal(r.task.status, 'review'); assert.equal(r.task.engine_used, 'cursor-rules');
    task1 = r.task; branch1 = r.branch;
    assert.equal(git(repo, 'rev-parse', 'main').trim(), headMain, 'default branch not moved'); assert.equal(git(repo, 'status', '--porcelain'), statusBefore, 'main checkout not dirtied');
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
    assert.ok(!lsFiles(repo, 'main').some((f) => f.includes('.cursor') || f.endsWith('AGENTS.md')), 'nothing on main');
    assert.deepEqual(lsFiles(repo, branch1).filter((f) => /\.cursor|AGENTS/.test(f)).sort(), pvBefore.files.map((f) => f.dest).sort());
    assert.deepEqual(git(repo, 'diff', '--name-only', `main...${branch1}`).split('\n').filter(Boolean).sort(), pvBefore.files.map((f) => f.dest).sort(), 'the commit contains exactly the approved files');
    assert.equal(git(repo, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', branch1).trim(), 'AI Dev Orchestrator <ai-orchestrator@localhost>|AI Dev Orchestrator <ai-orchestrator@localhost>');
    assert.equal(git(repo, 'rev-list', '--count', `main..${branch1}`).trim(), '1');
    assert.equal(git(repo, 'worktree', 'list').trim().split('\n').length, 1, 'throw-away worktree removed');
    assert.equal(git(repo, 'show', `${branch1}:.cursor/rules/rules-demo-rules.mdc`), find(pvBefore, '-rules.mdc').content);
    // the status on main stays "not generated" until a human merges; the pending branch is listed
    const pv = await S.get(cr(P.id, `/preview?service_id=${API.id}`)); assert.equal(pv.status, 'not_generated'); assert.deepEqual(pv.pending_branches, [branch1]);
    // approving again while an identical review branch waits creates nothing new
    const again = await S.post(cr(P.id, '/generate'), { service_id: API.id, approve: true, digest: pv.digest });
    assert.equal(again.changed, false); assert.equal(again.existing_branch, branch1); assert.deepEqual(branches(repo), [branch1]);
  });

  it('after the human merge the service is in sync; regeneration is idempotent; a changed source makes it stale and only the changed file is rewritten', async () => {
    await S.post(`/tasks/${task1.id}/approve-merge`, {});
    assert.ok(lsFiles(repo, 'main').includes('.cursor/rules/rules-demo-service-api.mdc'));
    let pv = await S.get(cr(P.id, `/preview?service_id=${API.id}`));
    assert.equal(pv.status, 'in_sync'); assert.ok(pv.files.every((f) => f.state === 'same'), JSON.stringify(pv.files.map((f) => [f.dest, f.state]))); assert.deepEqual(pv.pending_branches, []);
    const n = branches(repo).length, head = git(repo, 'rev-parse', 'main').trim();
    const noop = await S.post(cr(P.id, '/generate'), { service_id: API.id, approve: true, digest: pv.digest });
    assert.equal(noop.changed, false); assert.match(noop.message, /in sync/); assert.equal(branches(repo).length, n); assert.equal(git(repo, 'rev-parse', 'main').trim(), head);
    // stale: RULES.md changed in the managed context
    await S.post(`/projects/${P.id}/context/save`, { file: 'RULES.md', content: '# Rules\n- Keep tests green.\n- Never edit migrations.\n- New: log every error.\n' });
    pv = await S.get(cr(P.id, `/preview?service_id=${API.id}`));
    assert.equal(pv.status, 'stale'); assert.equal(find(pv, '-rules.mdc').state, 'changed');
    assert.ok(find(pv, '-rules.mdc').diff.some((l) => l.t === '+' && /log every error/.test(l.s)) && find(pv, '-rules.mdc').diff.some((l) => l.t === ' '), 'diff has added and context lines');
    assert.deepEqual(pv.files.filter((f) => f.state === 'changed').map((f) => f.dest), ['.cursor/rules/rules-demo-rules.mdc'].concat(pv.files.filter((f) => f.state === 'changed' && !f.dest.endsWith('-rules.mdc')).map((f) => f.dest)));
    const ov = await S.get(cr(P.id)); assert.equal(ov.services.find((s) => s.service_id === API.id).status, 'stale');
    const r = await S.post(cr(P.id, '/generate'), { service_id: API.id, approve: true, digest: pv.digest });
    assert.equal(r.changed, true); assert.deepEqual(git(repo, 'diff', '--name-only', `main...${r.branch}`).split('\n').filter(Boolean).sort(), pv.files.filter((f) => f.state === 'changed').map((f) => f.dest).sort());
    assert.match(git(repo, 'show', `${r.branch}:.cursor/rules/rules-demo-rules.mdc`), /log every error/);
    await S.post(`/tasks/${r.task.id}/approve-merge`, {});
    assert.equal((await S.get(cr(P.id, `/preview?service_id=${API.id}`))).status, 'in_sync');
    // a service-map change (description) also makes the service rule stale
    await S.post(`/services/${API.id}/update`, { description: 'HTTP API v2' });
    await S.post(`/projects/${P.id}/context/save`, { file: 'SERVICES.md', content: '# Service map\n\n## api\n- Path: `services/api`\n- Responsibility: owns the v2 HTTP API\n' });
    pv = await S.get(cr(P.id, `/preview?service_id=${API.id}`)); assert.equal(find(pv, '-service-api.mdc').state, 'changed'); assert.match(find(pv, '-service-api.mdc').content, /owns the v2 HTTP API/);
  });

  it('hand-written files are never overwritten; only marker-carrying files are rewritten; nothing is deleted', async () => {
    const hw = makeRepo(path.join(S.work, 'handmade'), {
      '.cursor/rules/hand-architecture.mdc': '---\ndescription: mine\nglobs:\nalwaysApply: false\n---\nHand written, no marker.\n',
      'AGENTS.md': '# My own agents file\nDo it my way.\n', 'package.json': '{"name":"hand"}\n',
    });
    const Q = await S.addProject(hw, 'Hand', 'true');
    await S.post(`/projects/${Q.id}/context/save`, { file: 'RULES.md', content: '# R\n- rule\n' });
    await S.post(`/projects/${Q.id}/context/save`, { file: 'ARCHITECTURE.md', content: '# A\nbits\n' });
    const pv = await S.get(cr(Q.id, `/preview?service_id=${Q.serviceId}`));
    const arch = find(pv, '-architecture.mdc'); assert.equal(arch.dest, '.cursor/rules/hand-architecture.mdc'); assert.equal(arch.state, 'hand_written'); assert.match(arch.note, /hand-written/);
    assert.equal(find(pv, 'AGENTS.md').state, 'hand_written');
    assert.deepEqual(pv.files.filter((f) => f.state === 'new').map((f) => f.dest).sort(), ['.cursor/rules/hand-rules.mdc', '.cursor/rules/hand-service-hand.mdc']);
    await S.post(cr(Q.id, '/optin'), { service_id: Q.serviceId, enabled: true });
    const head = git(hw, 'rev-parse', 'main').trim();
    const r = await S.post(cr(Q.id, '/generate'), { service_id: Q.serviceId, approve: true, digest: pv.digest });
    assert.equal(r.changed, true);
    const changed = git(hw, 'diff', '--name-status', `main...${r.branch}`).split('\n').filter(Boolean);
    assert.ok(changed.every((l) => l.startsWith('A\t')), `only additions: ${changed}`);
    assert.ok(!changed.some((l) => /hand-architecture|AGENTS\.md/.test(l)));
    for (const f of ['.cursor/rules/hand-architecture.mdc', 'AGENTS.md']) assert.equal(git(hw, 'show', `${r.branch}:${f}`), git(hw, 'show', `main:${f}`), `${f} identical on the branch`);
    assert.equal(git(hw, 'rev-parse', 'main').trim(), head);
    await S.post(`/tasks/${r.task.id}/approve-merge`, {});
    // an orphaned generated file (source removed) is reported, never deleted
    await S.post(`/projects/${Q.id}/context/save`, { file: 'RULES.md', content: '   \n' });
    const pv2 = await S.get(cr(Q.id, `/preview?service_id=${Q.serviceId}`));
    assert.ok(pv2.orphans.some((o) => /hand-rules\.mdc$/.test(o)), JSON.stringify(pv2.orphans)); assert.ok(pv2.notes.some((n) => /never deleted/.test(n)));
    assert.ok(lsFiles(hw, 'main').some((f) => /hand-rules\.mdc$/.test(f)));
  });

  it('safe on authorized roots only: a service outside the roots, a symlinked service dir and a symlinked .cursor are all refused, nothing is written', async () => {
    const out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-m14-out-')));
    try {
      // (1) service repointed outside the authorized roots
      const outRepo = makeRepo(path.join(out, 'outside-repo'), { 'README.md': '# o\n' });
      const R = await S.addProject(makeRepo(path.join(S.work, 'inroot'), { 'README.md': '# i\n' }), 'Escape', 'true');
      await S.post(`/projects/${R.id}/context/save`, { file: 'RULES.md', content: '# R\n- x\n' });
      await S.post(cr(R.id, '/optin'), { service_id: R.serviceId, enabled: true });
      const setLocalPath = (p) => { const db = new DatabaseSync(S.dbPath); try { db.exec('PRAGMA busy_timeout = 5000'); db.prepare('UPDATE services SET local_path = ? WHERE id = ?').run(p, R.serviceId); } finally { db.close(); } };
      const fpOut = fingerprint(outRepo);
      setLocalPath(outRepo);
      let r = await S.get(cr(R.id, `/preview?service_id=${R.serviceId}`), { allowFail: true }); assert.equal(r.status, 409); assert.match(r.json.error, /outside the authorized roots/);
      r = await S.post(cr(R.id, '/generate'), { service_id: R.serviceId, approve: true, digest: 'x' }, { allowFail: true }); assert.equal(r.status, 409); assert.match(r.json.error, /outside the authorized roots/);
      assert.equal(fingerprint(outRepo), fpOut); assert.deepEqual(branches(outRepo), []);
      const ov = await S.get(cr(R.id)); assert.match(ov.services[0].problem, /outside the authorized roots/);
      // (2) in-root name, outside by realpath (symlink)
      const link = path.join(S.work, 'link-out'); fs.symlinkSync(outRepo, link); setLocalPath(link);
      r = await S.get(cr(R.id, `/preview?service_id=${R.serviceId}`), { allowFail: true }); assert.equal(r.status, 409); assert.match(r.json.error, /outside the authorized roots/);
      assert.equal(fingerprint(outRepo), fpOut);
      // (3) the repo itself tracks `.cursor` as a symlink that points outside: refused before and during generation
      const trap = path.join(S.work, 'trap'); const target = path.join(out, 'cursor-target'); fs.mkdirSync(path.join(target, 'rules'), { recursive: true });
      makeRepo(trap, { 'README.md': '# trap\n' }); fs.symlinkSync(target, path.join(trap, '.cursor')); git(trap, 'add', '-A'); git(trap, 'commit', '-q', '-m', 'cursor is a symlink');
      const T = await S.addProject(trap, 'Trap', 'true');
      await S.post(`/projects/${T.id}/context/save`, { file: 'RULES.md', content: '# R\n- x\n' }); await S.post(cr(T.id, '/optin'), { service_id: T.serviceId, enabled: true });
      const pv = await S.get(cr(T.id, `/preview?service_id=${T.serviceId}`));
      assert.equal(pv.status, 'blocked'); assert.ok(pv.files.some((f) => f.state === 'blocked' && /symlink/.test(f.note)));
      const g = await S.post(cr(T.id, '/generate'), { service_id: T.serviceId, approve: true, digest: pv.digest }, { allowFail: true });
      assert.equal(g.status, 409); assert.match(g.json.error, /symlink/);
      assert.deepEqual(fs.readdirSync(path.join(target, 'rules')), [], 'the symlink target outside the repo stays empty'); assert.deepEqual(branches(trap), []);
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
  });

  it('the writer itself refuses symlinked ancestors/targets and unsafe destinations (defence in depth, on disk)', async () => {
    const r = await probe(`const fs = require('node:fs'), os = require('node:os'), path = require('node:path'); const rules = require('./lib/cursor-rules');
      const mk = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w-'))); const tryW = (root, rel) => { try { rules._safeWrite(root, rel, 'X'); return 'ok'; } catch (e) { return e.message.replace(/\\/[^ ]*\\//g, ''); } };
      const root = mk(), out = mk(); fs.symlinkSync(out, path.join(root, '.cursor'));
      const res = { dirLink: tryW(root, '.cursor/rules/x.mdc'), outside: fs.readdirSync(out) };
      const root2 = mk(); fs.mkdirSync(path.join(root2, '.cursor/rules'), { recursive: true }); fs.writeFileSync(path.join(out, 'victim'), 'v'); fs.symlinkSync(path.join(out, 'victim'), path.join(root2, '.cursor/rules/x.mdc'));
      res.fileLink = tryW(root2, '.cursor/rules/x.mdc'); res.victim = fs.readFileSync(path.join(out, 'victim'), 'utf8');
      const root3 = mk(); res.good = tryW(root3, 'a/b/AGENTS.md'); res.goodText = fs.readFileSync(path.join(root3, 'a/b/AGENTS.md'), 'utf8'); res.again = tryW(root3, 'a/b/AGENTS.md'); res.leftovers = fs.readdirSync(path.join(root3, 'a/b'));
      res.bad = ['../x.mdc', '.cursor/rules/../../x.mdc', '/etc/passwd', '.cursor/rules/X.mdc', 'README.md', '.cursor/rules/x.md'].map((d) => tryW(root3, d)).map((m) => /unsafe destination/.test(m));
      res.dest = ['AGENTS.md', 'a/b/AGENTS.md', '.cursor/rules/x.mdc', '../x.mdc', '/etc/passwd', '.cursor/rules/a b.mdc'].map((d) => rules.DEST_RE.test(d));
      console.log(JSON.stringify(res));`);
    assert.match(r.dirLink, /symlink/); assert.deepEqual(r.outside, [], 'nothing created through the symlinked .cursor');
    assert.match(r.fileLink, /symlink/); assert.equal(r.victim, 'v', 'a symlinked target file is not written through');
    assert.equal(r.good, 'ok'); assert.equal(r.goodText, 'X'); assert.equal(r.again, 'ok'); assert.deepEqual(r.leftovers, ['AGENTS.md'], 'atomic rename leaves no temp file');
    assert.deepEqual(r.bad, [true, true, true, true, true, true]); assert.deepEqual(r.dest, [true, true, true, false, false, false]);
  });
});

describe('M14 cursor rules: lint, diff and the rules of this repository', () => {
  it('lint rejects bad frontmatter; hasMarker needs the marker near the top; lineDiff collapses unchanged context', async () => {
    const r = await probe(`const c = require('./lib/cursor-rules'); const ok = c.frontmatter({ description: 'd: with colon', globs: 'src/**', alwaysApply: false });
      const mk = (t) => c.lint(t);
      console.log(JSON.stringify({ ok: mk(ok + 'body\\n').ok, parsed: c.parseFrontmatter(ok).data,
        none: mk('no frontmatter\\n').errors, nodesc: mk('---\\nglobs: a\\nalwaysApply: false\\n---\\nx').errors, badbool: mk('---\\ndescription: "x"\\nalwaysApply: maybe\\n---\\nx').errors,
        big: c.lint(ok + 'x'.repeat(9000)).errors, unknown: c.lint('---\\ndescription: "x"\\nfoo: 1\\nalwaysApply: false\\n---\\nx').warnings,
        m1: c.hasMarker('---\\n---\\n<!-- generated-by: local-ai-dev-orchestrator cursor-rules v1 | x -->\\n'), m2: c.hasMarker('# my file\\n' + 'x\\n'.repeat(1500) + '<!-- generated-by: local-ai-dev-orchestrator -->'), m3: c.hasMarker('see generated-by: local-ai-dev-orchestrator in docs'),
        diff: c.lineDiff(Array.from({ length: 20 }, (_, i) => 'l' + i).join('\\n'), Array.from({ length: 20 }, (_, i) => (i === 10 ? 'CHANGED' : 'l' + i)).join('\\n')).map((x) => x.t + x.s),
        gone: c.lineDiff('a\\nb', 'a\\nb'), neu: c.lineDiff(null, 'x\\ny').map((x) => x.t) }));`);
    assert.equal(r.ok, true); assert.deepEqual(r.parsed, { description: 'd: with colon', globs: 'src/**', alwaysApply: false });
    assert.match(r.none[0], /no frontmatter/); assert.ok(r.nodesc.some((e) => /description/.test(e))); assert.ok(r.badbool.some((e) => /alwaysApply/.test(e))); assert.ok(r.big.some((e) => /bytes/.test(e)));
    assert.ok(r.unknown.some((w) => /foo/.test(w))); assert.equal(r.m1, true); assert.equal(r.m2, false); assert.equal(r.m3, false);
    assert.deepEqual(r.diff, [' l7', ' l8', ' l9', '-l10', '+CHANGED', ' l11', ' l12', ' l13'].map((s) => s.replace(/^ /, ' ')));
    assert.deepEqual(r.gone, []); assert.deepEqual(r.neu, ['+', '+']);
  });

  it('THIS repository ships hand-written Cursor rules: valid .mdc, small always-on set, they describe the real guards', () => {
    const dir = path.join(ROOT, '.cursor', 'rules'); const names = fs.readdirSync(dir);
    assert.ok(names.length >= 4 && names.every((n) => n.endsWith('.mdc')), `only .mdc files: ${names}`);
    return probe(`const fs = require('node:fs'), path = require('node:path'); const c = require('./lib/cursor-rules'); const dir = ${JSON.stringify(dir)};
      console.log(JSON.stringify(fs.readdirSync(dir).map((n) => { const t = fs.readFileSync(path.join(dir, n), 'utf8'); return { n, l: c.lint(t), marker: c.hasMarker(t) }; })));`).then((res) => {
    let always = 0; const text = {};
    for (const { n, l, marker } of res) {
      text[n] = fs.readFileSync(path.join(dir, n), 'utf8');
      assert.ok(l.ok, `${n}: ${l.errors}`); assert.deepEqual(l.warnings, [], n); assert.ok(!marker, `${n} is hand-written (no generated marker)`);
      if (l.always) always += l.tokens;
    }
    assert.ok(always > 0 && always <= 600, `always-applied rules ~${always} tokens (budget 600)`);
    const all = Object.values(text).join('\n');
    for (const must of ['zero npm dependencies', 'lib/ollama.js', '/api/chat', 'lib/proc.js', 'unlinkSync', 'fsguard', 'portable', 'users.noreply.github.com', 'no local git identity', 'Plan first', 'Never claim', 'm1-guards', 'alert(']) assert.ok(new RegExp(must.replace(/[()]/g, '\\$&'), 'i').test(all), `rules mention '${must}'`);
    // every file path / identifier the rules cite exists
    for (const f of ['lib/ollama.js', 'lib/proc.js', 'lib/fsguard.js', 'lib/safegit.js', 'lib/runner.js', 'lib/cursor.js', 'lib/open.js', 'test/m1-guards.test.js', 'test/m10-ui.test.js', 'test/helpers/harness.js', 'scripts/ui-smoke.sh', 'scripts/dev-demo.js']) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
    assert.match(fs.readFileSync(path.join(ROOT, 'lib', 'fsguard.js'), 'utf8'), /removeOwnedDir/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies || {}, {}, 'zero dependencies, as the rules claim');
    assert.equal(fs.existsSync(path.join(ROOT, '.git', 'config')) && /\[user\]/.test(fs.readFileSync(path.join(ROOT, '.git', 'config'), 'utf8')), false, 'no local git identity, as the rules claim');
    });
  });

  it('the generator itself stays inside the guards: git only through proc, no deletes, only .cursor/rules + AGENTS.md destinations', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'cursor-rules.js'), 'utf8');
    assert.ok(!/unlinkSync|rmSync|rmdirSync|fs\.rm\(|rimraf/.test(src)); assert.ok(!/execFile|spawn|exec\(/.test(src));
    const subs = [...src.matchAll(/git\((?:root|wt|base\.root),\s*\[(?:\.\.\.context\.GIT_ID,\s*)?'([a-z-]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(subs)].sort(), ['add', 'branch', 'commit', 'diff', 'ls-tree', 'rev-parse', 'show', 'worktree']);
    assert.ok(!/'push'|'merge'|'checkout'|'reset'|'clean'|'stash'/.test(src), 'never pushes, merges, resets or switches branches');
  });
});
