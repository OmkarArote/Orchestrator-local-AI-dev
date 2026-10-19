'use strict';
require('./helpers/temp-env'); // FIRST: lib/* is loaded in-process below
// Swap-relook fixes 1 + 2: a task check must terminate (dev/start servers and watchers are refused), and plan-first keeps the FULL Cursor
// plan (createPlan tool body) and fails clearly when the plan is tiny/truncated instead of storing a 353-char preamble.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo } = require('./helpers/harness');
const guard = require('../lib/check-guard');

describe('M26 check guard (pure)', () => {
  it('refuses dev/start servers and watchers, by script name and by script body', () => {
    for (const [cmd, scripts] of [['npm run dev', {}], ['npm start', {}], ['yarn dev', {}], ['pnpm run serve:api', {}], ['npm run check', { check: 'nodemon src/server.js' }],
      ['npm test', { test: 'jest --watchAll' }], ['node --test --watch', {}], ['node src/server.js', {}], ['npx vite', {}], ['docker compose up', {}], ['npm run build && npm run dev', {}]]) {
      assert.ok(guard.longRunningReason(cmd, scripts), `${cmd} should be refused`);
    }
  });
  it('lets terminating checks through (tests, lint, build, syntax check, bounded commands)', () => {
    for (const [cmd, scripts] of [['npm test', { test: 'node --test' }], ['npm run build && npm test', { build: 'tsc', test: 'vitest run' }], ['npm run lint', { lint: 'eslint .' }],
      ['git diff --check', {}], ['node --check src/server.js', {}], ['git ls-files -z -- src | xargs -0 -n1 node --check', {}], ['npx vite build', {}], ['docker compose up -d && npm test', {}],
      ['pytest -q', {}], ['test -f a.txt', {}], ['timeout 60 npm run dev', {}], ['grep -w foo a.txt', {}]]) {
      assert.equal(guard.longRunningReason(cmd, scripts), null, cmd);
    }
  });
});

describe('M26 plan selection (pure)', () => {
  let pickPlan, StreamParser;
  before(() => {
    ({ pickPlan } = require('../lib/runner'));
    ({ StreamParser } = require('../lib/cursor'));
  });
  it('the createPlan body wins over a short result; a tiny text-only answer is rejected; a long text-only answer is kept', () => {
    const plan = '# Plan\n' + '- step\n'.repeat(40);
    assert.deepEqual(pickPlan({ plan, text: "I'll trace...", fullText: "I'll trace..." }), { text: plan.trim(), source: 'createPlan' });
    const tiny = pickPlan({ plan: null, text: 'x'.repeat(353), fullText: 'x'.repeat(353) });
    assert.match(tiny.problem, /353 chars.*truncated/);
    const long = pickPlan({ plan: null, text: 'short', fullText: 'y'.repeat(900) });
    assert.equal(long.problem, undefined); assert.equal(long.source, 'assistant text'); assert.equal(long.text.length, 900);
    assert.match(pickPlan({ plan: 'too short', text: '' }).problem, /only 9 chars/);
  });
  it('stream parser captures the createPlan args and complete assistant segments (deltas are not double counted)', () => {
    const p = new StreamParser();
    const feed = (o) => p.feed(JSON.stringify(o));
    feed({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello ' }] }, timestamp_ms: 1 });
    feed({ type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: { path: 'a.js' } } } });
    feed({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] }, model_call_id: 'm' });
    feed({ type: 'tool_call', subtype: 'started', tool_call: { createPlanToolCall: { args: { plan: '# full plan\n1. a\n2. b' } } } });
    feed({ type: 'tool_call', subtype: 'completed', tool_call: { createPlanToolCall: { args: { plan: '# full plan\n1. a\n2. b' }, result: { success: {} } } } });
    feed({ type: 'result', subtype: 'success', result: 'Hello world' });
    assert.equal(p.plan, '# full plan\n1. a\n2. b');
    assert.equal(p.fullText, 'Hello world');
  });
});

describe('M26 check guard + plan capture (server)', () => {
  let S, P, repo;
  before(async () => {
    S = await startServer();
    repo = makeRepo(path.join(S.work, 'm26'), { 'hello.txt': 'hi\n', 'package.json': JSON.stringify({ name: 'm26', scripts: { dev: 'nodemon index.js', check: 'nodemon index.js' } }) });
    P = await S.addProject(repo, 'm26', 'test -f hello.txt');
  });
  after(async () => { await S.stop(); });

  it('API refuses a long-running check_cmd on a service and on a task (400, nothing stored)', async () => {
    const r = await S.post(`/services/${P.serviceId}/update`, { check_cmd: 'npm run dev' }, { allowFail: true });
    assert.equal(r.status, 400); assert.match(r.json.error, /check_cmd refused: 'npm run dev'/);
    const svc = (await S.get(`/projects/${P.id}/services`)).find((s) => s.id === P.serviceId);
    assert.notEqual(svc.check_cmd, 'npm run dev');
    const t = await S.post('/tasks', { project_id: P.id, service_id: P.serviceId, title: 't', prompt: 'p', check_cmd: 'npm start' }, { allowFail: true });
    assert.equal(t.status, 400); assert.match(t.json.error, /check_cmd refused/);
    const ok = await S.post(`/services/${P.serviceId}/update`, { check_cmd: 'test -f hello.txt' });
    assert.equal(ok.check_cmd, 'test -f hello.txt');
  });

  it('runtime: a check that expands to a watcher (npm run check -> nodemon) is refused immediately, not run to the timeout', async () => {
    const t = await S.runToReview(P.id, { title: 'w', prompt: 'edit', files: ['hello.txt'], engine: 'local', check_cmd: 'npm run check' }, 'failed');
    assert.match(t.result_summary, /check: REFUSED \(long-running check: npm run check\)/);
    const ev = (await S.get(`/tasks/${t.id}/events`)).map((e) => e.message).join('\n');
    assert.match(ev, /check refused: 'npm run check' runs "nodemon index.js"/);
    assert.doesNotMatch(ev, /check: sh -c/);
  });

  it('plan_first stores the full createPlan body (not the preamble) and writes it to the log dir', async () => {
    const t = await S.runToReview(P.id, { title: 'plan', prompt: 'do it', engine: 'cursor', plan_first: true }, 'awaiting_plan');
    assert.match(t.plan_text, /stub plan/); assert.doesNotMatch(t.plan_text, /I'll trace/);
    const ev = (await S.get(`/tasks/${t.id}/events`)).map((e) => e.message).join('\n');
    assert.match(ev, /PLAN stored on the task \(\d+ chars, source: createPlan\)/);
    assert.match(fs.readFileSync(path.join(S.base, 'logs', `cursor-task-${t.id}-plan.md`), 'utf8'), /stub plan/);
  });

  it('plan_first fails clearly on a tiny/truncated plan and keeps a long text-only plan', async () => {
    const t = await S.runToReview(P.id, { title: 'tiny', prompt: 'STUB_PLAN_TINY', engine: 'cursor', plan_first: true }, 'failed');
    assert.match(t.result_summary, /plan run failed: no createPlan output and the answer is only \d+ chars .*truncated/);
    assert.equal(t.plan_text, null);
    const t2 = await S.runToReview(P.id, { title: 'long', prompt: 'STUB_PLAN_TEXT_ONLY', engine: 'cursor', plan_first: true }, 'awaiting_plan');
    assert.match(t2.plan_text, /stub plan/); assert.ok(t2.plan_text.length > 600);
  });
});
