'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../config');
const store = require('./db');
const cursor = require('./cursor');
const { run, git } = require('./proc');
const { branchOf } = require('./paths');
const repo = require('./repo');
const context = require('./context');
const memory = require('./memory');
const models = require('./models');
const settings = require('./settings');

const GIT_ID = ['-c', 'user.name=AI Dev Orchestrator', '-c', 'user.email=ai-orchestrator@localhost'];

// Scheduler state: id -> { id, kind: 'local'|'cursor', project_id, service_id, state }.
// Local (aider) tasks are strictly sequential (max 1); Cursor tasks may run up to ORCH_MAX_PARALLEL_CURSOR at once (never two on the same repo + overlapping subdir).
const running = new Map();
const branchFor = (t) => branchOf((store.getTask(t.id)) || t);
const baseOf = (task, service) => task.base_ref || service.default_branch;

const ev = (id, kind, msg) => store.addEvent(id, kind, msg);
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
const tail = (arr, n) => arr.slice(-n).join('\n');

/** Move a running/checking task to a terminal state and record why. */
function finish(task, from, to, summary, extra = {}) {
  store.updateFields(task.id, { result_summary: summary, ...extra });
  if (!store.transition(task.id, from, to)) {
    const cur = store.getTask(task.id);
    if (cur) store.transition(task.id, cur.status, to);
  }
  ev(task.id, 'system', `FINAL: ${to.toUpperCase()} - ${summary}`);
}

// ------------------------------------------------------------------ phases
async function aiderPhase(ctx) {
  const { task, wt, state, onSpawn } = ctx, id = task.id;
  const root = ctx.root;
  // task files are relative to the service root when a service is set; repo-relative paths that exist are converted
  const files = (task.files || []).map((f) => {
    if (root === wt || fs.existsSync(path.join(root, f)) || !fs.existsSync(path.join(wt, f))) return f;
    return path.relative(root, path.join(wt, f));
  });
  for (const f of files) if (!fs.existsSync(path.join(root, f))) ev(id, 'system', `note: ${f} does not exist on ${ctx.defaultBranch}; aider may create it`);
  const ctxNote = ctx.bundleFile ? `\n\nA read-only project context file (RULES, service map, memory) is attached as ${path.basename(ctx.bundleFile)}; follow its RULES. Do not edit that file.` : '';
  const message = `${task.prompt}${ctxNote}\n\nRules: only change what is needed for this request, keep the existing code style, imports and unrelated code unchanged, and return the complete file.`;
  // coding role options (num_ctx, temperature, ...) reach aider through its model-settings file; nothing configured = no file = unchanged behaviour
  let settingsFile = null;
  const yaml = models.aiderSettingsYaml();
  if (yaml) { fs.mkdirSync(cfg.LOG_DIR, { recursive: true }); settingsFile = path.join(cfg.LOG_DIR, `aider-task-${id}.model-settings.yml`); fs.writeFileSync(settingsFile, yaml); }
  const aiderArgs = [
    '--model', models.aiderModelArg(), ...(settingsFile ? ['--model-settings-file', settingsFile] : []), '--no-show-model-warnings', '--yes-always', '--no-auto-commits', '--no-dirty-commits',
    '--no-check-update', '--no-analytics', '--edit-format', 'whole', '--no-pretty', '--no-fancy-input',
    '--no-gitignore', '--map-tokens', '0', '--no-restore-chat-history', '--no-detect-urls', '--no-suggest-shell-commands',
    '--no-show-release-notes',
    ...(ctx.bundleFile ? ['--read', ctx.bundleFile] : []),
    '--chat-history-file', path.join(cfg.LOG_DIR, `aider-task-${id}.chat.md`),
    '--input-history-file', path.join(cfg.LOG_DIR, `aider-task-${id}.input`),
    '--llm-history-file', path.join(cfg.LOG_DIR, `aider-task-${id}.llm.log`),
    '--message', message, ...files,
  ];
  ev(id, 'system', `engine local: aider ${models.aiderModelArg()}${settingsFile ? ' (settings: ' + yaml.split('\n').slice(2).map((x) => x.trim()).filter(Boolean).join(', ') + ')' : ''} in ${ctx.service ? ctx.service.path : '.'} on [${files.join(', ')}]${ctx.bundleFile ? ' + --read context bundle' : ''} (timeout ${Math.round(cfg.AIDER_TIMEOUT_MS / 1000)}s)`);
  const aider = await run(cfg.AIDER_BIN, aiderArgs, {
    cwd: root, timeoutMs: cfg.AIDER_TIMEOUT_MS, onSpawn, env: { OLLAMA_API_BASE: cfg.OLLAMA_API_BASE },
    onLine: (l) => ev(id, 'aider', l),
  });
  ev(id, 'system', `aider finished: exit=${aider.code} signal=${aider.signal || '-'} timedOut=${aider.timedOut}${aider.error ? ' error=' + aider.error : ''}`);
  const ok = aider.code === 0 && !aider.timedOut && !aider.error;
  return { ok, label: 'aider', note: `aider: ${ok ? 'ok' : aider.timedOut ? 'TIMEOUT' : `FAILED (exit ${aider.code})`}`, tag: '[aider failed] ', cancelled: state.cancelled };
}

/** Safety guard: cursor may only ever be pointed at this task's own worktree (never the project's main checkout). */
async function assertWorktree(ctx) {
  const { task, wt } = ctx;
  const rw = real(wt), root = real(cfg.WORKTREES), rp = real(ctx.repoRoot);
  if (!rw || !root || !rw.startsWith(root + path.sep)) throw new Error(`refusing: ${wt} is not inside the worktrees root`);
  if (rw === rp) throw new Error("refusing: worktree path equals the service's repo");
  const top = (await git(wt, ['rev-parse', '--show-toplevel'])).out.trim();
  if (real(top) !== rw) throw new Error(`refusing: ${wt} is not a git worktree root (toplevel ${top})`);
  const br = (await git(wt, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
  const want = branchFor(task);
  if (br !== want) throw new Error(`refusing: worktree is on '${br}', expected ${want}`);
}

/** Run the Cursor CLI in the worktree. kind: 'task' (can edit) | 'review' (read-only, --mode ask). Counts toward the daily cap. */
async function runCursor(ctx, { kind, model, prompt, timeoutMs }) {
  const { task, wt, onSpawn } = ctx, id = task.id;
  const usage = store.cursorUsageToday();
  if (store.cursorRemaining(kind) <= 0) return { ok: false, blocked: true, note: kind === 'review' ? `daily Cursor review cap reached (${usage.reviews}/${usage.review_cap})` : `daily Cursor cap reached (${usage.used}/${usage.cap})` };
  const st = await cursor.getStatus({ force: true });
  if (!st.installed) return { ok: false, note: `cursor CLI not installed (${cfg.CURSOR_BIN})` };
  if (!st.logged_in) return { ok: false, note: 'cursor CLI is not logged in (run `agent login`)' };
  await assertWorktree(ctx);

  const args = ['-p'];
  if (kind === 'task') args.push('--force');          // may edit/run commands (inside the sandbox, inside the worktree)
  else if (kind === 'plan') args.push('--mode', 'plan'); // read-only planning (no edits)
  else args.push('--mode', 'ask');                    // read-only review
  args.push('--trust', '--sandbox', 'enabled', '--workspace', wt, '--model', model,
    '--output-format', 'stream-json', '--stream-partial-output', prompt);

  const logBase = path.join(cfg.LOG_DIR, `cursor-task-${id}-${kind}`);
  fs.mkdirSync(cfg.LOG_DIR, { recursive: true });
  const rawFile = `${logBase}.jsonl`, errFile = `${logBase}.stderr`;
  const mainBefore = `${(await git(ctx.repoRoot, ['rev-parse', 'HEAD'])).out.trim()}|${(await git(ctx.repoRoot, ['status', '--porcelain'])).out}`;
  if (store.cursorRemaining(kind) <= 0) return { ok: false, blocked: true, note: 'daily Cursor cap reached (another parallel task used the last slot)' };
  store.recordCursorUse(id, kind, model);
  const u = store.cursorUsageToday();
  ev(id, 'cursor', `RUNS ON CURSOR SERVERS (uses Pro usage): ${kind === 'task' ? 'agent --force' : kind === 'plan' ? 'agent --mode plan' : 'agent --mode ask'} --sandbox enabled --model ${model} in ${wt} (timeout ${Math.round(timeoutMs / 1000)}s). Cursor usage today: tasks+plans ${u.used}/${u.cap}, reviews ${u.reviews}/${u.review_cap}. Raw stream: ${rawFile}`);

  const parser = new cursor.StreamParser();
  fs.appendFileSync(rawFile, `# ---- ${new Date().toISOString()} task ${id} ${kind} model ${model}\n`);
  const r = await run(cfg.CURSOR_BIN, args, {
    cwd: wt, timeoutMs, onSpawn, maxLine: 8 * 1024 * 1024, env: { CI: undefined },
    onLine: (l, which) => {
      if (which === 'out') {
        try { fs.appendFileSync(rawFile, l + '\n'); } catch { /* ignore */ }
        for (const e of parser.feed(l)) ev(id, e.kind, e.message);
      } else {
        try { fs.appendFileSync(errFile, l + '\n'); } catch { /* ignore */ }
        ev(id, 'cursor', `stderr: ${l.slice(0, 500)}`);
      }
    },
  });
  for (const e of parser.flush()) ev(id, e.kind, e.message);
  const res = parser.result;
  if (parser.model) { // the actual model Cursor reports in the stream-json `system/init` event (matters when model=auto)
    ev(id, 'cursor', `model actually used (stream-json): ${parser.model}`);
    if (kind !== 'review') store.updateFields(id, { model_used: parser.model });
  }
  const ok = r.code === 0 && !r.timedOut && !r.error && !!res && res.subtype === 'success' && !res.is_error;
  ev(id, 'system', `cursor finished: exit=${r.code} signal=${r.signal || '-'} timedOut=${r.timedOut}${r.error ? ' error=' + r.error : ''} result=${res ? res.subtype : 'none'}`);
  const mainAfter = `${(await git(ctx.repoRoot, ['rev-parse', 'HEAD'])).out.trim()}|${(await git(ctx.repoRoot, ['status', '--porcelain'])).out}`;
  if (mainAfter !== mainBefore) ev(id, 'error', `WARNING: the service's main checkout (HEAD/status) changed while cursor ran; inspect ${ctx.repoRoot} (could be a concurrent human edit)`);
  const why = r.timedOut ? 'TIMEOUT' : r.error ? `error: ${r.error}` : r.code !== 0 ? `FAILED (exit ${r.code})` : !res ? 'FAILED (no result event)' : res.is_error ? 'FAILED (agent reported error)' : 'ok';
  return { ok, model_used: parser.model || null, text: res && res.result ? String(res.result) : '', note: `cursor(${model}): ${why}`, why, tag: '[cursor failed] ', timedOut: r.timedOut };
}

const svcLine = (ctx) => (ctx.service ? `\n- This task belongs to the service '${ctx.service.name}' (directory ${ctx.service.path}/ inside the repo). Keep changes inside it unless the task clearly requires otherwise.` : '');

async function cursorPhase(ctx) {
  const { task, project, wt, checkCmd } = ctx;
  const model = task.model || cfg.CURSOR_MODEL;
  const files = (task.files || []).length ? `\n- Files most likely involved: ${task.files.join(', ')}` : '';
  const bundle = ctx.bundleText ? `${ctx.bundleText}\n---\n\n` : '';
  let prompt = `${bundle}TASK:\n${task.prompt}\n\nContext and rules from the orchestrator:\n- You are in an isolated git worktree on branch ${branchFor(task)} (project ${project.name}); edit files in this directory only.${svcLine(ctx)}\n- Make the smallest change that satisfies the request; keep the existing code style; do not touch unrelated code.\n- Do NOT run git commit/push/checkout/branch/reset; the orchestrator commits your changes afterwards.${files}\n- After your change this check command must pass: \`${checkCmd}\`${ctx.service ? ` (run from ${ctx.service.path}/)` : ''} (you may run it yourself).`;
  if (ctx.plan) prompt += `\n\nA human-approved implementation plan (produced earlier by a read-only planning run) follows. Implement it:\n<plan>\n${ctx.plan}\n</plan>`;
  if (ctx.escalation) {
    prompt += `\n\nA previous attempt by a small local model failed (${ctx.escalation.reason}). Its changes (if any) are committed on this branch; inspect \`git log\`/\`git diff ${ctx.defaultBranch}...HEAD\`, then fix or redo them as needed.${ctx.escalation.checkTail ? `\nLast check output:\n${ctx.escalation.checkTail}` : ''}`;
  }
  const r = await runCursor(ctx, { kind: 'task', model, prompt, timeoutMs: cfg.CURSOR_TIMEOUT_MS });
  return { ...r, label: 'cursor' };
}

/** Plan-first: `agent -p --mode plan` (read-only). The plan is stored on the task and a human approves it before the implementation run. */
async function planPhase(ctx) {
  const { task, project, wt } = ctx, id = task.id;
  const model = task.model || cfg.CURSOR_MODEL;
  const bundle = ctx.bundleText ? `${ctx.bundleText}\n---\n\n` : '';
  const prompt = `${bundle}TASK:\n${task.prompt}\n\nYou are in PLAN mode: do not edit any files. Produce a concise, concrete implementation plan (files/functions to change, steps, tests to add or run, risks/open questions) for the task above in project ${project.name}${ctx.service ? `, service '${ctx.service.name}' (${ctx.service.path}/)` : ''}. A human will review the plan before any code is written. Max ~40 lines.`;
  const head = (await git(wt, ['rev-parse', 'HEAD'])).out.trim();
  const r = await runCursor(ctx, { kind: 'plan', model, prompt, timeoutMs: cfg.CURSOR_REVIEW_TIMEOUT_MS });
  const dirty = (await git(wt, ['status', '--porcelain'])).out.trim();
  const tip = (await git(wt, ['rev-parse', 'HEAD'])).out.trim();
  if (dirty || tip !== head) {
    ev(id, 'error', `plan run modified the worktree (dirty=${!!dirty}, head moved=${tip !== head}); restoring ${head.slice(0, 7)}`);
    await git(wt, ['reset', '--hard', head]); await git(wt, ['clean', '-fd']);
  }
  return { ...r, label: 'cursor plan' };
}

/** Advisory, read-only AI review of the committed change. Never blocks the merge. */
async function reviewPhase(ctx, head) {
  const { task, project, wt } = ctx, id = task.id;
  const model = task.review_model || cfg.CURSOR_REVIEW_MODEL;
  try {
    const stat = (await git(wt, ['diff', '--stat', `${baseOf(task, ctx.service)}...HEAD`])).out;
    let diff = (await git(wt, ['diff', `${baseOf(task, ctx.service)}...HEAD`])).out;
    let trunc = false;
    if (Buffer.byteLength(diff) > cfg.MAX_REVIEW_DIFF_BYTES) { diff = diff.slice(0, cfg.MAX_REVIEW_DIFF_BYTES); trunc = true; }
    const prompt = `You are an independent, READ-ONLY code reviewer. Do not modify any files. Review the change below (branch ${branchFor(task)} vs ${baseOf(task, ctx.service)}) against the task it was meant to implement.\n\nPROJECT RULES (.ai/RULES.md; judge the diff against them too):\n${(context.read(project, 'RULES.md') || '(none)').slice(0, 3000)}\n\nTASK TITLE: ${task.title}\nTASK PROMPT:\n${task.prompt}\n\nCHECK COMMAND THAT PASSED: ${ctx.checkCmd}\n\nDIFF STAT:\n${stat}\nDIFF${trunc ? ' (truncated)' : ''}:\n${diff}\n\nRespond concisely (max ~15 lines): 1) does it satisfy the task? 2) correctness/edge-case risks, 3) missing tests, 4) anything suspicious (secrets, unrelated changes). Start with a one-line verdict.`;
    ev(id, 'review', `advisory AI review starting (cursor, model ${model}, --mode ask); this does NOT gate the merge`);
    const r = await runCursor(ctx, { kind: 'review', model, prompt, timeoutMs: cfg.CURSOR_REVIEW_TIMEOUT_MS });
    // read-only means the worktree must be exactly as committed
    const dirty = (await git(wt, ['status', '--porcelain'])).out.trim();
    const tip = (await git(wt, ['rev-parse', 'HEAD'])).out.trim();
    if (dirty || tip !== head) {
      ev(id, 'error', `review modified the worktree (dirty=${!!dirty}, head moved=${tip !== head}); restoring ${head.slice(0, 7)}`);
      await git(wt, ['reset', '--hard', head]); await git(wt, ['clean', '-fd']);
    }
    if (!r.ok || !r.text.trim()) { const m = `AI review unavailable: ${r.note || 'empty review'}`; ev(id, 'review', m); return m; }
    const header = `ADVISORY AI REVIEW (Cursor, model ${model}, read-only; not a gate, can be wrong)`;
    ev(id, 'review', header);
    for (const line of r.text.trim().split('\n').slice(0, 60)) if (line.trim()) ev(id, 'review', line);
    return `${header}\n\n${r.text.trim()}`;
  } catch (e) {
    const m = `AI review unavailable: ${e.message}`; ev(id, 'review', m); return m;
  }
}

async function runCheck(ctx) {
  const { task, project, state, onSpawn } = ctx, id = task.id;
  const wt = ctx.root; // service root inside the worktree (or the worktree itself)
  const line = (l) => { ev(id, 'check', l); ctx.checkLines.push(l); if (ctx.checkLines.length > 80) ctx.checkLines.shift(); };
  const hasPkg = fs.existsSync(path.join(wt, 'package.json')), hasNm = fs.existsSync(path.join(wt, 'node_modules'));
  const installCmd = (ctx.service && ctx.service.install_cmd) || project.install_cmd;
  if (installCmd && (!hasPkg || !hasNm)) {
    ev(id, 'system', `install: sh -c '${installCmd}' (timeout ${Math.round(cfg.INSTALL_TIMEOUT_MS / 1000)}s)`);
    const inst = await run('/bin/sh', ['-c', installCmd], { cwd: wt, timeoutMs: cfg.INSTALL_TIMEOUT_MS, onLine: line, onSpawn });
    ev(id, 'system', `install: exit=${inst.code} timedOut=${inst.timedOut}`);
    if (inst.code !== 0) return { ok: false, note: inst.timedOut ? 'FAILED (install timeout)' : `FAILED (install exit ${inst.code})` };
  } else if (!installCmd && hasPkg && !hasNm) {
    ev(id, 'system', `node_modules missing: running 'npm install' (timeout ${Math.round(cfg.INSTALL_TIMEOUT_MS / 1000)}s)`);
    const inst = await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: wt, timeoutMs: cfg.INSTALL_TIMEOUT_MS, onLine: line, onSpawn });
    ev(id, 'system', `npm install: exit=${inst.code} timedOut=${inst.timedOut}`);
    if (inst.code !== 0) return { ok: false, note: inst.timedOut ? 'FAILED (npm install timeout)' : `FAILED (npm install exit ${inst.code})` };
  }
  if (state.cancelled) return { ok: false, note: 'cancelled' };
  const cmd = ctx.checkCmd;
  if (cmd === cfg.EMPTY_CHECK) { // built-in default for projects without a real check: stage like the commit will, then whitespace/conflict-marker check
    ev(id, 'system', 'check: built-in `git diff --check` over the staged change (whitespace errors / conflict markers only - NOT a behaviour test; set a real check_cmd)');
    await git(ctx.wt, ['add', '-A', '--', ...commitSpec()]);
    const d = await git(ctx.wt, ['diff', '--cached', '--check']);
    for (const l of (d.out + d.err).split('\n')) if (l.trim()) line(l);
    ev(id, 'system', `check finished: exit=${d.code}`);
    return d.code === 0 ? { ok: true, note: `PASSED (${cmd})` } : { ok: false, note: `FAILED (exit ${d.code}: ${cmd})` };
  }
  ev(id, 'system', `check: sh -c '${cmd}' (timeout ${Math.round(cfg.CHECK_TIMEOUT_MS / 1000)}s)`);
  const r = await run('/bin/sh', ['-c', cmd], { cwd: wt, timeoutMs: cfg.CHECK_TIMEOUT_MS, onLine: line, onSpawn });
  ev(id, 'system', `check finished: exit=${r.code} timedOut=${r.timedOut}`);
  if (r.code === 0 && !r.timedOut) return { ok: true, note: `PASSED (${cmd})` };
  return { ok: false, note: r.timedOut ? `FAILED (timeout: ${cmd})` : `FAILED (exit ${r.code}: ${cmd})` };
}

/** pathspec for `git add`: everything except aider scratch files, build output and tsbuildinfo (the context bundle lives outside the repo). */
const commitSpec = () => ['.', ':(exclude,glob)**/.aider*', ':(exclude,glob)**/*.tsbuildinfo', ':(exclude,glob)**/dist/**', ':(exclude,glob)**/node_modules/**', ':(exclude,glob)**/.cursor/rules/orch-context.mdc'];

/** Commit worktree changes (excluding aider scratch files and an untracked npm lockfile). */
async function commitIfChanged(ctx, prefix) {
  const { task, wt } = ctx, id = task.id;
  const spec = commitSpec();
  const tracked = await git(wt, ['ls-files', '--error-unmatch', 'package-lock.json']);
  if (tracked.code !== 0) spec.push(':(exclude)package-lock.json');
  await git(wt, ['add', '-A', '--', ...spec]);
  const diff = await git(wt, ['diff', '--cached', '--shortstat']);
  const head = async () => (await git(wt, ['rev-parse', 'HEAD'])).out.trim();
  if (!diff.out.trim()) { ev(id, 'git', 'no changes to commit'); return { changed: false, head_sha: await head() }; }
  const by = ctx.engineLabel;
  const msg = `${prefix}ai/task-${id}: ${task.title}\n\n${task.prompt}\n\nGenerated by local AI dev orchestrator (${by}). Not reviewed.`;
  const c = await git(wt, [...GIT_ID, 'commit', '-q', '-m', msg]);
  if (c.code !== 0) { ev(id, 'error', `git commit failed: ${c.err || c.error}`); return { changed: false, head_sha: await head() }; }
  const sha = await head();
  const stat = diff.out.trim();
  ev(id, 'git', `committed ${sha.slice(0, 7)} on ${branchFor(task)}: ${stat}`);
  return { changed: true, head_sha: sha, stat };
}

// ------------------------------------------------------------------ main flow
async function processTask(task) {
  const id = task.id;
  let branch = branchFor(task);
  const state = { id, cancelled: false, kill: null };
  { const slot = running.get(id); if (slot) slot.state = state; }
  const onSpawn = (kill) => { state.kill = kill; };
  let status = 'running';
  const project = store.getProject(task.project_id);
  const planResume = task.plan_state === 'approved' && !!task.worktree_path;                  // approved plan: implement it with cursor in the same worktree
  const escResume = !planResume && task.escalation === 'approved' && !!task.worktree_path;    // approved escalation: skip local, go to cursor
  const resume = planResume || escResume;

  if (!store.transition(id, 'approved', 'running', { branch })) return;
  ev(id, 'system', `Task #${id} started: ${task.title} [project ${project ? project.name : '?'}, engine ${task.engine}${escResume ? ', ESCALATED to cursor' : ''}${planResume ? ', PLAN APPROVED -> implementing with cursor' : ''}]`);

  try {
    if (!project) return finish(task, status, 'failed', `project #${task.project_id} not found`);
    const service = task.service_id ? store.getService(task.service_id) : null;
    if (!service) return finish(task, status, 'failed', 'task has no service; every task runs inside one service (one git repo)');
    let repoRoot;
    try { repoRoot = repo.assertUsable(service); } catch (e) { return finish(task, status, 'failed', e.message); } // clear message BEFORE any git command
    const base = baseOf(task, service); // the service's default branch, or the previous step's branch for stacked sequence steps
    const wt = resume ? task.worktree_path : repo.worktreeFor({ ...task, worktree_path: null }, project, service);
    const ctx = {
      task, project, wt, root: wt, service, repoRoot, defaultBranch: service.default_branch, state, onSpawn, checkLines: [], escalation: null, plan: planResume ? task.plan_text : null,
      checkCmd: task.check_cmd || service.check_cmd || project.check_cmd || cfg.DEFAULT_CHECK, engineLabel: '',
    };

    // ---- 1. worktree + branch from the project's default branch (skipped when resuming an escalated task)
    if (resume) {
      if (!fs.existsSync(wt)) return finish(task, status, 'failed', `worktree ${wt} is gone; cannot escalate`);
      ev(id, 'git', `resuming in existing worktree ${wt}`);
    } else {
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      if (fs.existsSync(wt)) return finish(task, status, 'failed', `worktree path already exists: ${wt}`);
      const b = await git(repoRoot, ['rev-parse', '--verify', `${base}^{commit}`]);
      if (b.code !== 0) return finish(task, status, 'failed', `base branch '${base}' not found in ${repoRoot}`);
      if (!task.branch) { // pick a free branch name (stale branches from older runs must not block a task)
        const root0 = branch; let n = 2;
        while ((await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0 && n < 50) branch = `${root0}-${n++}`;
        if (branch !== root0) { ev(id, 'git', `branch ${root0} already exists; using ${branch}`); store.updateFields(id, { branch }); }
      }
      const add = await git(repoRoot, ['worktree', 'add', '-b', branch, wt, base]);
      ev(id, 'git', `git worktree add -b ${branch} ${wt} ${base} -> exit ${add.code} ${add.err.trim().split('\n').pop() || ''}`);
      if (add.code !== 0) return finish(task, status, 'failed', `worktree creation failed: ${(add.err || add.error || '').trim().slice(0, 300)}`);
      ev(id, 'git', `base ${base} @ ${b.out.trim().slice(0, 7)}; worktree ${wt}`);
      store.updateFields(id, { worktree_path: wt });
    }

    // ---- 1b. service root (monorepo subfolder inside the worktree) + shared context bundle
    {
      const rr = real(path.join(wt, service.path)), rw = real(wt);
      if (!rr || !rw || (rr !== rw && !rr.startsWith(rw + path.sep))) return finish(task, status, 'failed', `service '${service.name}' path '${service.path}' does not exist inside the worktree (or escapes it)`);
      ctx.root = rr;
      ev(id, 'system', `service: ${service.name} (repo ${repoRoot}, subdir ${service.path}); working root ${rr}${service.archived ? ' [service is archived]' : ''}`);
    }
    try {
      await context.ensureSeeded(project);
      const b = context.buildBundle({ project, service, services: store.listServices(project.id), taskText: `${task.title}\n${task.prompt}`, maxChars: settings.effective(project).context_max_chars });
      if (b.text) {
        const dir = path.join(cfg.LOG_DIR, 'context', `task-${id}`);
        fs.mkdirSync(dir, { recursive: true });
        ctx.bundleFile = path.join(dir, 'CONTEXT.md'); ctx.bundleText = b.text;
        fs.writeFileSync(ctx.bundleFile, b.text);
        store.updateFields(id, { context_json: JSON.stringify({ ...b.manifest, file: ctx.bundleFile }) });
        ev(id, 'context', `context bundle ${b.manifest.total_chars}/${b.manifest.max_chars} chars: ${b.manifest.parts.map((x) => `${x.name} ${x.chars}${x.truncated ? ' (truncated)' : ''}`).join(', ')}; file ${ctx.bundleFile} (outside the repo; passed to the engine, never committed)`);
      } else ev(id, 'context', 'no project context files yet (.ai RULES/SERVICES/MEMORY); running without a context bundle');
    } catch (e) { ev(id, 'error', `context bundle failed (continuing without): ${e.message}`); }

    // ---- 2. engine
    const engine = task.engine === 'auto' ? (resume ? 'cursor' : 'local') : task.engine;
    const model = task.model || cfg.CURSOR_MODEL;
    ctx.engineLabel = engine === 'local' ? `aider ${models.aiderModelArg()}` : `cursor ${model}`;
    store.updateFields(id, { engine_used: escResume ? 'local+cursor' : engine });
    if (escResume) {
      const reason = (task.result_summary || 'local attempt failed').replace(/; escalation to Cursor requested$/, '').slice(0, 400);
      ctx.escalation = { reason, checkTail: '' };
      const ch = (store.eventsAfter(id, 0, 5000).filter((e) => e.kind === 'check').slice(-25).map((e) => e.message)).join('\n');
      ctx.escalation.checkTail = ch.slice(-2500);
    }
    if (engine === 'cursor' && task.plan_first && !task.plan_state && !resume) { // plan-first: read-only plan run, then wait for a human to approve it
      ev(id, 'system', 'plan_first: running Cursor in --mode plan first; implementation only starts after you approve the plan');
      const pl = await planPhase(ctx);
      if (state.cancelled) return finish(task, status, 'failed', 'cancelled by user');
      if (!pl.ok || !pl.text.trim()) return finish(task, status, 'failed', `plan run failed: ${pl.note || 'empty plan'}`);
      store.updateFields(id, { plan_text: pl.text.trim(), plan_state: 'pending', result_summary: `plan ready (${pl.note}); waiting for plan approval` });
      ev(id, 'cursor', `PLAN stored on the task (${pl.text.trim().length} chars); waiting for approve-plan`);
      store.transition(id, status, 'awaiting_plan');
      return;
    }
    const eng = engine === 'local' ? await aiderPhase(ctx) : await cursorPhase(ctx);
    if (state.cancelled) { const c = await commitIfChanged(ctx, '[cancelled] '); return finish(task, status, 'failed', 'cancelled by user', c.changed ? { head_sha: c.head_sha } : {}); }

    // ---- 3. check
    let check = { ok: false, note: `skipped (${eng.label} failed)` };
    if (eng.ok) {
      store.transition(id, 'running', 'checking'); status = 'checking';
      check = await runCheck(ctx);
      if (state.cancelled) { const c = await commitIfChanged(ctx, '[cancelled] '); return finish(task, status, 'failed', 'cancelled by user', c.changed ? { head_sha: c.head_sha } : {}); }
    }

    // ---- 4. commit on the branch (never merge)
    const tag = !eng.ok ? eng.tag : !check.ok ? '[check failed] ' : '';
    const commit = await commitIfChanged(ctx, tag);
    const ahead = Number((await git(wt, ['rev-list', '--count', `${base}..HEAD`])).out.trim()) || 0;
    const hasWork = commit.changed || ahead > 0;
    const stat = hasWork ? (await git(wt, ['diff', '--shortstat', `${base}...HEAD`])).out.trim() : '';
    const bits = [
      ...(escResume ? [`local attempt: ${ctx.escalation.reason}`] : []),
      ...(planResume ? ['implemented the approved plan'] : []),
      eng.note, `check: ${check.note}`,
      hasWork ? `commit ${commit.head_sha.slice(0, 7)} on ${branch} (${stat})` : 'no file changes were produced',
    ];
    const success = eng.ok && check.ok && hasWork;
    if (success) {
      let reviewText = null;
      if (task.ai_review) reviewText = await reviewPhase(ctx, commit.head_sha);
      const extra = { head_sha: commit.head_sha };
      if (reviewText) extra.review_summary = reviewText;
      finish(task, status, 'review', bits.join('; ') + (reviewText ? '; AI review attached (advisory)' : ''), extra);
      await memory.proposeForTask(id); // local LLM, pending human approval; never writes memory by itself
      return;
    }

    // ---- 5. failed: engine=auto may escalate local -> cursor (explicit, capped, by default needs a human click)
    const reason = !hasWork && eng.ok ? `${eng.label} made no changes` : !eng.ok ? eng.note : `check failed: ${check.note}`;
    const failSummary = [!hasWork && eng.ok ? `${eng.label} made no changes` : '', ...bits].filter(Boolean).join('; ');
    const extra = hasWork ? { head_sha: commit.head_sha } : {};
    if (task.engine === 'auto' && !resume && !eng.cancelled) {
      if (!task.allow_escalation) { ev(id, 'escalation', 'local attempt failed; escalation NOT allowed for this task (allow_escalation=false)'); return finish(task, status, 'failed', `${failSummary}; escalation not allowed`, extra); }
      const u = store.cursorUsageToday();
      if (u.remaining <= 0) {
        ev(id, 'escalation', `local attempt failed (${reason}); escalation BLOCKED: daily Cursor cap reached (${u.used}/${u.cap})`);
        return finish(task, status, 'failed', `${failSummary}; escalation blocked (daily cursor cap ${u.used}/${u.cap})`, { ...extra, escalation: 'blocked' });
      }
      ev(id, 'escalation', `local attempt failed (${reason}). Escalating to Cursor (model ${model}, runs on Cursor servers, uses Pro usage). Cursor usage today ${u.used}/${u.cap}.`);
      store.updateFields(id, { result_summary: `${failSummary}; escalation to Cursor requested`, escalation: 'pending', ...extra });
      if (!cfg.ESCALATION_REQUIRE_APPROVAL) {
        store.addApproval(id, 'escalate', 'approved', 'auto-approved by config (ORCH_ESCALATION_REQUIRE_APPROVAL=0)');
        ev(id, 'escalation', 'escalation auto-approved by server config; queued for the runner');
        store.updateFields(id, { escalation: 'approved' });
        store.transition(id, status, 'approved');
      } else {
        ev(id, 'escalation', 'waiting for a human to approve or reject the escalation in the dashboard (cursor NOT invoked yet)');
        store.transition(id, status, 'awaiting_escalation');
      }
      return;
    }
    return finish(task, status, 'failed', failSummary, extra);
  } catch (e) {
    ev(id, 'error', `orchestrator error: ${e.stack || e.message}`);
    const cur = store.getTask(id);
    if (cur && ['running', 'checking'].includes(cur.status)) finish(task, cur.status, 'failed', `orchestrator error: ${e.message}`);
  }
}

function cancel(id) {
  const slot = running.get(id);
  if (slot && slot.state) {
    slot.state.cancelled = true;
    if (slot.state.kill) slot.state.kill();
    ev(id, 'system', 'cancel requested by user');
    return true;
  }
  return false;
}

/** Which scheduler slot a task needs: cursor (engine cursor, or a resumed escalation/plan) or local (aider). */
function kindOf(task) {
  const resumed = !!task.worktree_path && (task.plan_state === 'approved' || task.escalation === 'approved');
  const engine = task.engine === 'auto' ? (resumed ? 'cursor' : 'local') : task.engine;
  return engine === 'cursor' ? 'cursor' : 'local';
}

/** Sequence dependency of a step: { state: 'ready'|'wait'|'blocked', base?, why? } */
function depState(task) {
  if (!task.group_id || !task.step_no || task.step_no <= 1) return { state: 'ready' };
  const group = store.getGroup(task.group_id);
  const prev = store.groupTasks(task.group_id).find((s) => s.step_no === task.step_no - 1);
  if (!group || !prev) return { state: 'ready' };
  if (group.dependency === 'independent') return { state: 'ready' }; // no ordering: steps (often in different repos) run on their own; one failure does not block the rest
  if (['failed', 'rejected'].includes(prev.status)) return { state: 'blocked', why: `previous step #${prev.id} (step ${prev.step_no}) is ${prev.status}` };
  if (prev.supervised) return { state: 'wait' };
  if (group.dependency === 'merged') return prev.status === 'done' ? { state: 'ready' } : { state: 'wait' };
  // stack: build on the previous step's branch once it passed its checks (status review); if it was already merged, plain default branch
  if (prev.status === 'review') return { state: 'ready', base: prev.branch };
  if (prev.status === 'done') return { state: 'ready' };
  return { state: 'wait' };
}

/** Scheduler scope of a task: the canonical repo (realpath) + the service subdir. Unknown scope = conflicts with everything (conservative). */
function scopeOf(task) {
  const svc = task.service_id ? store.getService(task.service_id) : null;
  return svc ? { repoKey: repo.repoKeyOf(svc), subdir: svc.path || '.', svc } : { repoKey: null, subdir: '.', svc: null };
}
const scopesConflict = (a, b) => {
  if (!a.repoKey || !b.repoKey) return true;
  if (a.repoKey !== b.repoKey) return false;
  const x = a.subdir, y = b.subdir;
  return x === '.' || y === '.' || x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
};

function canStart(kind, task, scope = scopeOf(task)) {
  const slots = [...running.values()];
  if (kind === 'local') return !slots.some((x) => x.kind === 'local');
  const cur = slots.filter((x) => x.kind === 'cursor');
  if (cur.length >= cfg.MAX_PARALLEL_CURSOR) return false;
  // never two concurrent Cursor tasks on the same repo + overlapping subdir (different repos run in parallel; '.' conflicts with every subdir)
  return !cur.some((x) => scopesConflict(x.scope || { repoKey: null }, scope));
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    for (const t0 of store.approvedAll()) {
      if (running.has(t0.id)) continue;
      const dep = depState(t0);
      if (dep.state === 'wait') continue;
      if (dep.state === 'blocked') {
        ev(t0.id, 'system', `sequence step not run: ${dep.why}`);
        finish(t0, 'approved', 'failed', `not run: ${dep.why}`);
        continue;
      }
      let t = t0;
      if (dep.base && !t0.base_ref) { store.updateFields(t0.id, { base_ref: dep.base }); t = store.getTask(t0.id); ev(t.id, 'git', `stacked sequence step: cutting the worktree from the previous step's branch ${dep.base}`); }
      const kind = kindOf(t);
      const scope = scopeOf(t);
      if (!canStart(kind, t, scope)) continue;
      running.set(t.id, { id: t.id, kind, project_id: t.project_id, service_id: t.service_id, scope, state: null });
      processTask(t).catch((e) => console.error('[runner] task error', e)).finally(() => running.delete(t.id));
    }
  } catch (e) {
    console.error('[runner] tick error', e);
  } finally { ticking = false; }
}

/**
 * Release a supervised task (hands-on session in Cursor IDE / CLI): run install+check in the (service) worktree, commit what is there on
 * the task branch and move the task to review (or failed). Takes the single local slot so checks never overlap another local task.
 */
async function releaseSupervised(id) {
  const task = store.getTask(id);
  if (!task || !task.supervised) throw new Error('task is not supervised');
  if ([...running.values()].some((x) => x.kind === 'local')) throw new Error('the runner is busy with another local task/check; try again in a moment');
  const project = store.getProject(task.project_id);
  const from = task.status;
  const wt = task.worktree_path;
  if (!wt || !fs.existsSync(wt)) throw new Error(`worktree ${wt} is gone`);
  const service = task.service_id ? store.getService(task.service_id) : null;
  if (!service) throw new Error('task has no service');
  const repoRoot = repo.assertUsable(service);
  const state = { id, cancelled: false, kill: null };
  running.set(id, { id, kind: 'local', project_id: task.project_id, service_id: task.service_id, scope: scopeOf(task), state });
  const onSpawn = (kill) => { state.kill = kill; };
  try {
    if (!store.transition(id, from, 'checking')) throw new Error(`status changed (${task.status})`);
    ev(id, 'system', 'supervised session RELEASED by human: running the check and committing the worktree state on the task branch');
    const root = real(path.join(wt, service.path)) || wt;
    const ctx = { task, project, wt, root, service, repoRoot, defaultBranch: service.default_branch, state, onSpawn, checkLines: [], engineLabel: 'supervised session (Cursor IDE/CLI)',
      checkCmd: task.check_cmd || service.check_cmd || project.check_cmd || cfg.DEFAULT_CHECK };
    const check = await runCheck(ctx);
    const commit = await commitIfChanged(ctx, check.ok ? '[supervised] ' : '[supervised][check failed] ');
    const base = baseOf(task, ctx.service);
    const ahead = Number((await git(wt, ['rev-list', '--count', `${base}..HEAD`])).out.trim()) || 0;
    const hasWork = commit.changed || ahead > 0;
    const stat = hasWork ? (await git(wt, ['diff', '--shortstat', `${base}...HEAD`])).out.trim() : '';
    const head = commit.head_sha;
    const ok = check.ok && hasWork;
    const summary = `supervised session released; check: ${check.note}; ${hasWork ? `commit ${head.slice(0, 7)} on ${task.branch} (${stat})` : 'no file changes on the branch'}`;
    finish(task, 'checking', ok ? 'review' : 'failed', summary, { head_sha: head, supervised: 0 });
    if (ok) await memory.proposeForTask(id);
    return { ok, status: ok ? 'review' : 'failed', summary };
  } catch (e) {
    ev(id, 'error', `release failed: ${e.message}`);
    const cur = store.getTask(id);
    if (cur && cur.status === 'checking') finish(task, 'checking', 'failed', `release failed: ${e.message}`, { supervised: 0 });
    throw e;
  } finally { running.delete(id); }
}

function start() {
  // crash recovery: anything left running/checking by a previous process is dead
  for (const t of store.inFlight()) {
    ev(t.id, 'error', `orchestrator restarted while task was ${t.status}; marking failed (branch/worktree left for inspection)`);
    store.updateFields(t.id, { result_summary: 'interrupted by orchestrator restart', supervised: 0 });
    store.transition(t.id, t.status, 'failed');
  }
  const timer = setInterval(tick, cfg.POLL_MS);
  tick();
  return timer;
}

function stopCurrent() { for (const x of running.values()) if (x.state && x.state.kill) x.state.kill(); }

module.exports = { start, cancel, stopCurrent, releaseSupervised, commitSpec, running, canStart, scopeOf, scopesConflict };
