'use strict';
// Swap-relook fix 5: Cursor task runs get a 35 min default budget, dependencies are installed before Cursor starts when a lockfile exists
// (never fatal, never guessing the package manager), and the prompt states the time budget, targeted-tests-only and absent Mongo/Redis.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo } = require('./helpers/harness');

const lastPrompt = (S) => {
  const dir = path.dirname(S.env.STUB_LOG), base = path.basename(S.env.STUB_LOG);
  const f = fs.readdirSync(dir).filter((n) => n.startsWith(`${base}.prompt-`)).map((n) => path.join(dir, n)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs).pop();
  return fs.readFileSync(f, 'utf8');
};

describe('M27 Cursor runtime: preinstall, budget, test guidance', () => {
  let S;
  before(async () => { S = await startServer(); });
  after(async () => { await S.stop(); });

  it('lockfile + no node_modules: install_cmd runs in the worktree before Cursor, prompt says deps are installed', async () => {
    const repo = makeRepo(path.join(S.work, 'pre'), { 'package.json': '{"name":"pre"}\n', 'package-lock.json': '{"lockfileVersion":3}\n' });
    const P = await S.addProject(repo, 'pre', 'test -d node_modules', { install_cmd: 'mkdir -p node_modules && echo installed > node_modules/.marker' });
    const t = await S.runToReview(P.id, { title: 'c', prompt: 'do it', engine: 'cursor' });
    const ev = (await S.get(`/tasks/${t.id}/events`)).map((e) => e.message);
    const iDeps = ev.findIndex((m) => /^deps: package-lock\.json present, node_modules missing -> sh -c 'mkdir -p node_modules/.test(m));
    const iCursor = ev.findIndex((m) => /RUNS ON CURSOR SERVERS/.test(m));
    assert.ok(iDeps >= 0 && iCursor > iDeps, 'install runs before cursor');
    assert.ok(ev.includes('deps: exit=0 timedOut=false'));
    const p = lastPrompt(S);
    assert.match(p, /Time budget: about 35 minutes/);
    assert.match(p, /already installed by the orchestrator/);
    assert.match(p, /MongoDB, Redis and other services may be absent/);
    assert.match(p, /never the whole suite, integration tests or a dev\/start server/);
    assert.ok(!fs.readdirSync(repo).includes('node_modules'), 'main checkout untouched');
  });

  it('a failing install is not fatal; yarn.lock without install_cmd is not guessed; no lockfile = no install', async () => {
    const r1 = makeRepo(path.join(S.work, 'bad'), { 'package.json': '{"name":"bad"}\n', 'package-lock.json': '{}\n' });
    const P1 = await S.addProject(r1, 'bad', 'true', { install_cmd: 'exit 7' });
    const t1 = await S.runToReview(P1.id, { title: 'c', prompt: 'do it', engine: 'cursor' }, ['review', 'failed']);
    const e1 = (await S.get(`/tasks/${t1.id}/events`)).map((e) => e.message).join('\n');
    assert.match(e1, /deps: exit=7 .*continuing/); assert.match(e1, /RUNS ON CURSOR SERVERS/);
    assert.match(lastPrompt(S), /orchestrator install FAILED/);
    const r2 = makeRepo(path.join(S.work, 'yarn'), { 'package.json': '{"name":"y"}\n', 'yarn.lock': '\n' });
    const P2 = await S.addProject(r2, 'yarn', 'true');
    const t2 = await S.runToReview(P2.id, { title: 'c', prompt: 'do it', engine: 'cursor' });
    assert.match((await S.get(`/tasks/${t2.id}/events`)).map((e) => e.message).join('\n'), /yarn\.lock found but no install_cmd set; not guessing/);
    const r3 = makeRepo(path.join(S.work, 'nolock'), { 'package.json': '{"name":"n"}\n' });
    const P3 = await S.addProject(r3, 'nolock', 'true');
    const t3 = await S.runToReview(P3.id, { title: 'c', prompt: 'do it', engine: 'cursor' });
    assert.doesNotMatch((await S.get(`/tasks/${t3.id}/events`)).map((e) => e.message).join('\n'), /^deps:/m);
    assert.match(lastPrompt(S), /not pre-installed/);
  });
});
