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
const features = require('./features');

const GIT_ID = ['-c', 'user.name=AI Dev Orchestrator', '-c', 'user.email=ai-orchestrator@localhost'];
const AIDER_EDIT_FORMATS = ['whole', 'diff', 'udiff', 'diff-fenced'];
const AIDER_WHOLE_BELOW_BYTES = 4096;

/**
 * Edit format for one aider run. Unset or `diff` falls back to `whole` when any pinned file is missing or under 4 KB.
 * An explicit whole/udiff/diff-fenced is used as given. Anything else is an error (the local run is refused).
 */
function resolveAiderEditFormat({ format, pinned = [] } = {}) {
  const raw = format == null || format === '' ? null : String(format);
  if (raw !== null && !AIDER_EDIT_FORMATS.includes(raw)) return { error: `ORCH_AIDER_EDIT_FORMAT '${raw}' is not one of ${AIDER_EDIT_FORMATS.join('|')}` };
  const chosen = raw || 'diff';
  if (chosen !== 'diff') return { format: chosen };
  const whole = pinned.some((p) => p && (p.missing || (Number.isFinite(p.bytes) && p.bytes < AIDER_WHOLE_BELOW_BYTES)));
  return { format: whole ? 'whole' : 'diff' };
}

function aiderEditRule(format) {
  if (format === 'whole') return 'return the complete file';
  if (format === 'udiff') return 'return a unified diff, not the complete file';
  return 'return a search/replace diff, not the complete file';
}

/** Rough token estimate used before aider prints its own `Tokens:` line. */
function charsToTokens(n) { return Math.ceil(Number(n) / 4); }

/** Aider's `Tokens: 11k sent, 3.5k received.` (also plain integers). */
function parseAiderTokenCount(raw) {
  const s = String(raw).trim().toLowerCase().replace(/,/g, '');
  const km = s.match(/^(\d+(?:\.\d+)?)k$/);
  if (km) return Math.round(Number(km[1]) * 1000);
  if (/^\d+$/.test(s)) return Number(s);
  return null;
}
function parseAiderTokens(line) {
  const m = String(line).trim().match(/^Tokens:\s*([\d.,]+k?)\s+sent,\s*([\d.,]+k?)\s+received/i);
  if (!m) return null;
  const sent = parseAiderTokenCount(m[1]);
  const received = parseAiderTokenCount(m[2]);
  if (sent == null || received == null) return null;
  return { sent, received };
}

/**
 * Files aider named, in order, that still fit the char cap and the context window.
 * `promptTokens` is the history already in the next request (sent + received). When unset, the char estimate is used.
 */
function filesThatFit({ baseChars, numCtx, cap, files, promptTokens }) {
  const fit = [];
  let bytes = 0;
  let tokens = promptTokens != null ? promptTokens : charsToTokens(baseChars);
  for (const file of files) {
    const nextBytes = bytes + file.bytes;
    const nextTokens = tokens + charsToTokens(file.bytes);
    if (baseChars + nextBytes > cap || nextTokens > numCtx) break;
    fit.push(file.path);
    bytes = nextBytes;
    tokens = nextTokens;
  }
  return { fit, bytes, tokens };
}

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
  const refuse = (why) => { ev(id, 'error', `local engine refused: ${why}`); return { ok: false, label: 'aider', note: `aider: REFUSED (${why})`, tag: '[aider refused] ', cancelled: false }; };
  // ---- request hygiene (lib/aider-prep.js): too many pinned files, "do not open" lists, ignore file, size budget, repo map
  if (files.length > cfg.LOCAL_MAX_FILES) return refuse(`${files.length} pinned files > ORCH_LOCAL_MAX_FILES=${cfg.LOCAL_MAX_FILES}: a multi-file change is too big for one local pass; use Cursor or split the task`);
  const prep = require('./aider-prep');
  const prefix = path.relative(wt, root).split(path.sep).join('/');
  const strip = prep.stripDoNotOpen(task.prompt, { root, prefix });
  if (strip.patterns.length) ev(id, 'system', `aider: moved a "do not open" list out of the message (${strip.patterns.length} path(s): ${strip.patterns.slice(0, 12).join(', ')}${strip.patterns.length > 12 ? ', ...' : ''}) into the ignore file; aider auto-adds every file named in the message`);
  const sizes = await prep.trackedSizes(wt);
  const pinnedRel = files.map((f) => path.relative(wt, path.join(root, f)).split(path.sep).join('/'));
  const pinnedInfo = files.map((f, i) => {
    const abs = path.join(root, f);
    const exists = fs.existsSync(abs);
    const tracked = sizes.get(pinnedRel[i]);
    return { missing: !exists, bytes: exists ? (Number.isFinite(tracked) ? tracked : fs.statSync(abs).size) : 0 };
  });
  const edit = resolveAiderEditFormat({ format: cfg.AIDER_EDIT_FORMAT, pinned: pinnedInfo });
  if (edit.error) return refuse(edit.error);
  const ignoreFile = path.join(cfg.LOG_DIR, `aider-task-${id}.aiderignore`);
  fs.mkdirSync(cfg.LOG_DIR, { recursive: true });
  const pinOnly = cfg.AIDER_PIN_ONLY && pinnedRel.length > 0;
  fs.writeFileSync(ignoreFile, prep.ignoreFileText({ wt, extra: strip.patterns, sizes, maxFileBytes: cfg.LOCAL_MAX_FILE_BYTES, pinned: pinnedRel, pinOnly }));
  if (pinOnly) ev(id, 'system', `aider: pin-only run, every non-pinned file is in the ignore file so mentioned files are not auto-added (ORCH_AIDER_PIN_ONLY=0 turns this off)`);
  const ctxNote = ctx.bundleFile ? `\n\nA read-only project context file (RULES, service map, memory) is attached as ${path.basename(ctx.bundleFile)}; follow its RULES. Do not edit that file.` : '';
  const message = `${strip.text}${ctxNote}\n\nRules: only change what is needed for this request, keep the existing code style, imports and unrelated code unchanged, and ${aiderEditRule(edit.format)}.`;
  const mapTokens = files.length ? cfg.LOCAL_MAP_TOKENS_WITH_FILES : cfg.LOCAL_MAP_TOKENS;
  const pinnedBytes = pinnedRel.reduce((n, f) => n + (sizes.get(f) || 0), 0);
  const baseChars = message.length + (ctx.bundleText ? ctx.bundleText.length : 0) + pinnedBytes + mapTokens * 4;
  if (baseChars > cfg.LOCAL_MAX_REQUEST_CHARS) return refuse(`request would be ~${baseChars} chars (message ${message.length}, context ${ctx.bundleText ? ctx.bundleText.length : 0}, pinned files ${pinnedBytes}, repo map ~${mapTokens * 4}) > ORCH_LOCAL_MAX_REQUEST_CHARS=${cfg.LOCAL_MAX_REQUEST_CHARS}; pin fewer/smaller files, shorten the prompt, or use Cursor`);
  if (!files.length) ev(id, 'system', `aider: no files pinned - the model only sees a ${mapTokens}-token repo map and asks for files itself; pin the files to change (task files) for accurate edits${task.prompt.length > 4000 ? `. This prompt is ${task.prompt.length} chars: probably a multi-file task, Cursor (or a plan + split) fits better` : ''}`);
  let modelArg = models.aiderModelArg();
  const coding = models.effective('coding');
  // task.model on engine auto/cursor is the Cursor model. Its default is the string "auto", which is not a request to pick an Ollama model.
  const localModel = task.engine === 'local' ? task.model : null;
  if (localModel && localModel !== 'auto') modelArg = `ollama_chat/${models.stripPrefix(localModel)}`;
  else if (localModel === 'auto' || coding.model === 'auto') {
    const sel = await models.resolve('coding', { taskKind: 'code_edit', conversationModel: localModel === 'auto' ? 'auto' : undefined, taskRunning: store.localTasksRunning().some((t) => t.id !== id) });
    if (!sel.model || sel.rule === 'none' || sel.rule === 'defer') throw new Error((sel.reason || ['no local model']).join('; '));
    modelArg = `ollama_chat/${sel.model}`;
    ev(id, 'system', `auto → ${sel.model} (${sel.rule}): ${(sel.reason || []).slice(0, 2).join('; ')}`);
  }
  // coding role options (num_ctx, temperature, ...) and think:false (thinking-capable models) reach aider through its model-settings file,
  // written for the model actually used; nothing to send = no file
  let settingsFile = null;
  const { yaml, think: sentThink } = await models.aiderSettingsFor(modelArg);
  if (sentThink !== undefined && sentThink !== false) ev(id, 'system', require('./flow/roles').thinkWarning('coder') || `warning: aider runs with think:${JSON.stringify(sentThink)} (slow on 9B models)`);
  if (yaml) { fs.mkdirSync(cfg.LOG_DIR, { recursive: true }); settingsFile = path.join(cfg.LOG_DIR, `aider-task-${id}.model-settings.yml`); fs.writeFileSync(settingsFile, yaml); }
  const aiderArgs = [
    '--model', modelArg, ...(settingsFile ? ['--model-settings-file', settingsFile] : []), '--no-show-model-warnings', '--yes-always', '--no-auto-commits', '--no-dirty-commits',
    '--no-check-update', '--no-analytics', '--edit-format', edit.format, '--no-pretty', '--no-fancy-input',
    '--no-gitignore', '--map-tokens', String(mapTokens), '--aiderignore', ignoreFile, '--no-restore-chat-history', '--no-detect-urls', '--no-suggest-shell-commands',
    '--no-show-release-notes',
    ...(ctx.bundleFile ? ['--read', ctx.bundleFile] : []),
    '--chat-history-file', path.join(cfg.LOG_DIR, `aider-task-${id}.chat.md`),
    '--input-history-file', path.join(cfg.LOG_DIR, `aider-task-${id}.input`),
    '--llm-history-file', path.join(cfg.LOG_DIR, `aider-task-${id}.llm.log`),
    '--message', message, ...files,
  ];
  const bundleChars = ctx.bundleText ? ctx.bundleText.length : 0;
  const numCtx = Number.isInteger(coding.options && coding.options.num_ctx) ? coding.options.num_ctx : cfg.LOCAL_NUM_CTX;
  ev(id, 'system', `engine local: aider ${modelArg}${settingsFile ? ' (settings: ' + yaml.split('\n').slice(2).map((x) => x.trim()).filter(Boolean).join(', ') + ')' : ''} in ${ctx.service ? ctx.service.path : '.'} on [${files.join(', ')}]${ctx.bundleFile ? ' + --read context bundle' : ''} (timeout ${Math.round(cfg.AIDER_TIMEOUT_MS / 1000)}s)`);
  ev(id, 'system', `tokens: ~${charsToTokens(baseChars)} estimated (${message.length} prompt + ${bundleChars} context + ${pinnedBytes} pinned + ~${mapTokens * 4} repo map) / num_ctx ${numCtx}; cap ${cfg.LOCAL_MAX_REQUEST_CHARS} chars`);
  // mention budget: aider prints the path of every file it auto-adds from a mention; stop before an oversized request stalls the model
  const added = new Set(pinnedRel);
  const named = [];
  let addedBytes = 0, overBudget = null, kill = null, lastTokens = null;
  const aider = await run(cfg.AIDER_BIN, aiderArgs, {
    cwd: root, timeoutMs: cfg.AIDER_TIMEOUT_MS, env: { OLLAMA_API_BASE: cfg.OLLAMA_API_BASE },
    onSpawn: (k) => { kill = k; if (onSpawn) onSpawn(k); },
    onLine: (l) => {
      ev(id, 'aider', l);
      const tok = parseAiderTokens(l);
      if (tok) {
        lastTokens = tok;
        ev(id, 'system', `tokens: ${tok.sent} sent + ${tok.received} received = ${tok.sent + tok.received} / num_ctx ${numCtx}`);
      }
      const f = l.trim();
      if (overBudget || !sizes.has(f) || added.has(f)) return;
      added.add(f); addedBytes += sizes.get(f);
      named.push({ path: f, bytes: sizes.get(f) });
      const promptTokens = lastTokens ? lastTokens.sent + lastTokens.received : charsToTokens(baseChars);
      const nextTok = promptTokens + charsToTokens(addedBytes);
      const overChars = baseChars + addedBytes > cfg.LOCAL_MAX_REQUEST_CHARS;
      const overTokens = nextTok > numCtx;
      const tokenLine = `tokens: next request ~${nextTok} / num_ctx ${numCtx} after ${f} (${sizes.get(f)} bytes)`;
      if (!overChars && !overTokens) { ev(id, 'system', tokenLine); return; }
      const fit = filesThatFit({ baseChars, numCtx, cap: cfg.LOCAL_MAX_REQUEST_CHARS, files: named, promptTokens });
      const pin = `pin only what still fits${fit.fit.length ? ': ' + fit.fit.join(', ') : ' (none. Shorten the prompt or use Cursor)'}`;
      const why = overChars
        ? `aider auto-added ${added.size - pinnedRel.length} mentioned file(s) (${addedBytes} bytes, last ${f}); the request would exceed ORCH_LOCAL_MAX_REQUEST_CHARS=${cfg.LOCAL_MAX_REQUEST_CHARS}`
        : `aider auto-added ${added.size - pinnedRel.length} mentioned file(s) (${addedBytes} bytes, last ${f}); the next request would be ~${nextTok} tokens > num_ctx ${numCtx}`;
      const turn = lastTokens ? `last turn ${lastTokens.sent} sent + ${lastTokens.received} received` : 'estimated, no Tokens line yet';
      overBudget = `${why}; tokens: next request ~${nextTok} / num_ctx ${numCtx} (${turn}); ${pin}`;
      ev(id, 'system', `${tokenLine}; ${pin}`);
      ev(id, 'error', `stopping aider: ${overBudget}`);
      if (kill) kill();
    },
  });
  ev(id, 'system', `aider finished: exit=${aider.code} signal=${aider.signal || '-'} timedOut=${aider.timedOut}${aider.error ? ' error=' + aider.error : ''}`);
  if (overBudget) return { ok: false, label: 'aider', note: `aider: STOPPED (request too large: ${overBudget})`, tag: '[aider failed] ', cancelled: state.cancelled };
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

/** Run the Cursor CLI in the worktree. kind: 'task' (can edit) | 'review' (read-only, --mode ask). Counted in the usage counters (db.cursorStats); there is NO cap: callers only get here after an explicit human approval click. */
async function runCursor(ctx, { kind, model, prompt, timeoutMs }) {
  const { task, wt, onSpawn } = ctx, id = task.id;
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
  store.recordCursorUse(id, kind, model);
  const u = store.cursorStats();
  ev(id, 'cursor', `RUNS ON CURSOR SERVERS (uses Pro usage): ${kind === 'task' ? 'agent --force' : kind === 'plan' ? 'agent --mode plan' : 'agent --mode ask'} --sandbox enabled --model ${model} in ${wt} (timeout ${Math.round(timeoutMs / 1000)}s). Cursor usage (counted, no cap): ${u.today.tasks} task(s) / ${u.today.runs} run(s) today, ${u.total.tasks} task(s) / ${u.total.runs} run(s) total. Raw stream: ${rawFile}`);

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
  return { ok, model_used: parser.model || null, text: res && res.result ? String(res.result) : '', plan: parser.plan, fullText: parser.fullText, note: `cursor(${model}): ${why}`, why, tag: '[cursor failed] ', timedOut: r.timedOut };
}

const svcLine = (ctx) => (ctx.service ? `\n- This task belongs to the service '${ctx.service.name}' (directory ${ctx.service.path}/ inside the repo). Keep changes inside it unless the task clearly requires otherwise.` : '');

/**
 * Install dependencies in the (service) worktree before Cursor starts, so the agent does not spend its time budget on `npm install`
 * (task #7: prettier failed twice on a missing node_modules). Only when a lockfile is present and node_modules is missing. Uses the
 * service/project install_cmd when set, otherwise `npm ci` (does not rewrite the lockfile). Never fatal: Cursor can still try.
 */
async function preinstall(ctx) {
  const { task, project, onSpawn } = ctx, id = task.id, root = ctx.root;
  if (!cfg.CURSOR_PREINSTALL || !fs.existsSync(path.join(root, 'package.json')) || fs.existsSync(path.join(root, 'node_modules'))) return null;
  const lock = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'].find((f) => fs.existsSync(path.join(root, f)));
  if (!lock) return null;
  const installCmd = (ctx.service && ctx.service.install_cmd) || project.install_cmd;
  if (!installCmd && lock !== 'package-lock.json' && lock !== 'npm-shrinkwrap.json') { ev(id, 'system', `deps: ${lock} found but no install_cmd set; not guessing the package manager (Cursor may install)`); return null; }
  const [bin, args] = installCmd ? ['/bin/sh', ['-c', installCmd]] : ['npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error']];
  ev(id, 'system', `deps: ${lock} present, node_modules missing -> ${installCmd ? `sh -c '${installCmd}'` : 'npm ci'} before Cursor (timeout ${Math.round(cfg.INSTALL_TIMEOUT_MS / 1000)}s)`);
  const r = await run(bin, args, { cwd: root, timeoutMs: cfg.INSTALL_TIMEOUT_MS, onSpawn, onLine: (l) => ev(id, 'check', l) });
  ev(id, 'system', `deps: exit=${r.code} timedOut=${r.timedOut}${r.code === 0 ? '' : ' (continuing; Cursor is told the install failed)'}`);
  return r.code === 0 && !r.timedOut;
}

async function cursorPhase(ctx) {
  const { task, project, wt, checkCmd } = ctx;
  const deps = await preinstall(ctx);
  if (ctx.state.cancelled) return { ok: false, note: 'cancelled', label: 'cursor', tag: '[cursor failed] ' };
  const mins = Math.round(cfg.CURSOR_TIMEOUT_MS / 60000);
  const model = task.model || cfg.CURSOR_MODEL;
  const files = (task.files || []).length ? `\n- Files most likely involved: ${task.files.join(', ')}` : '';
  const bundle = ctx.bundleText ? `${ctx.bundleText}\n---\n\n` : '';
  let prompt = `${bundle}TASK:\n${task.prompt}\n\nContext and rules from the orchestrator:\n- You are in an isolated git worktree on branch ${branchFor(task)} (project ${project.name}); edit files in this directory only.${svcLine(ctx)}\n- Make the smallest change that satisfies the request; keep the existing code style; do not touch unrelated code.\n- Do NOT run git commit/push/checkout/branch/reset; the orchestrator commits your changes afterwards.${files}\n- After your change this check command must pass: \`${checkCmd}\`${ctx.service ? ` (run from ${ctx.service.path}/)` : ''} (you may run it yourself).
- Time budget: about ${mins} minutes in total, then the run is killed. Edit first; keep verification short.
- Dependencies: ${deps === true ? 'already installed by the orchestrator; do not run npm install/ci again.' : deps === false ? 'the orchestrator install FAILED; install only if a test you need cannot start without it.' : 'not pre-installed (no lockfile or node_modules already present).'}
- Tests: run only the targeted unit tests for the files you change (for node: \`node --test --test-force-exit tests/<file>.test.js\`), never the whole suite, integration tests or a dev/start server. MongoDB, Redis and other services may be absent: if a test hangs on a connection or retries, stop it and report it as not run instead of waiting.`;
  if (ctx.plan) prompt += `\n\nA human-approved implementation plan (produced earlier by a read-only planning run) follows. Implement it:\n<plan>\n${ctx.plan}\n</plan>`;
  if (ctx.escalation) {
    prompt += `\n\nA previous attempt by a small local model failed (${ctx.escalation.reason}). Its changes (if any) are committed on this branch; inspect \`git log\`/\`git diff ${ctx.defaultBranch}...HEAD\`, then fix or redo them as needed.${ctx.escalation.checkTail ? `\nLast check output:\n${ctx.escalation.checkTail}` : ''}`;
  }
  const r = await runCursor(ctx, { kind: 'task', model, prompt, timeoutMs: cfg.CURSOR_TIMEOUT_MS });
  return { ...r, label: 'cursor' };
}

/**
 * Choose the plan text of a plan run: the createPlan tool body (complete plan) > all assistant segments > the final result.
 * Without a createPlan body, a short text is almost always the preamble of a cut-off answer, so it is rejected (problem) instead of
 * being stored and "implemented" by a run that has to rediscover everything (task #7: 353-char plan, then a 15-minute timeout).
 */
function pickPlan(r) {
  const tool = (r.plan || '').trim(), all = (r.fullText || '').trim(), res = (r.text || '').trim();
  if (tool) return tool.length >= cfg.PLAN_MIN_CHARS_TOOL ? { text: tool, source: 'createPlan' } : { text: tool, source: 'createPlan', problem: `plan is only ${tool.length} chars (min ${cfg.PLAN_MIN_CHARS_TOOL}); re-run the plan` };
  const text = all.length > res.length ? all : res;
  const source = text === all && all ? 'assistant text' : 'result';
  if (!text) return { text: '', source };
  if (text.length < cfg.PLAN_MIN_CHARS) return { text, source, problem: `no createPlan output and the answer is only ${text.length} chars (min ${cfg.PLAN_MIN_CHARS}): the plan looks truncated; re-run the plan (ORCH_PLAN_MIN_CHARS to tune)` };
  return { text, source };
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
  { // a check must terminate: refuse dev/start servers and watchers up front (they would only end at the check timeout)
    let scripts = {};
    if (hasPkg) { try { scripts = JSON.parse(fs.readFileSync(path.join(wt, 'package.json'), 'utf8')).scripts || {}; } catch { /* unreadable package.json: judge the command text only */ } }
    const why = require('./check-guard').longRunningReason(ctx.checkCmd, scripts);
    if (why) { ev(id, 'error', `check refused: ${why}. ${require('./check-guard').HINT}. Change the service/project check command.`); return { ok: false, note: `REFUSED (long-running check: ${ctx.checkCmd})` }; }
  }
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
const commitSpec = () => ['.', ':(exclude,glob).aider*', ':(exclude,glob).aider*/**', ':(exclude,glob)**/.aider*', ':(exclude,glob)**/.aider*/**', ':(exclude,glob)**/*.tsbuildinfo', ':(exclude,glob)**/dist/**', ':(exclude,glob)**/node_modules/**', ':(exclude,glob)**/.cursor/rules/orch-context.mdc'];

/** Whether a task branch can be created ('new'), checked out again ('reuse'), or is held by another worktree ('busy', with `at`). */
async function branchPlan(repoRoot, branch) {
  const exists = (await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
  if (!exists) return { mode: 'new' };
  const list = (await git(repoRoot, ['worktree', 'list', '--porcelain'])).out.split('\n\n');
  const holder = list.find((blk) => blk.split('\n').includes(`branch refs/heads/${branch}`));
  if (holder) return { mode: 'busy', at: (holder.match(/^worktree (.+)$/m) || [])[1] || '?' };
  return { mode: 'reuse' };
}

/** `git diff --numstat` text where every entry adds and removes 0 lines (binary entries are "-\t-" and count as content). */
function onlyEmptyChanges(numstat) {
  const lines = String(numstat || '').split('\n').filter((l) => l.trim());
  return lines.length > 0 && lines.every((l) => /^0\t0\t/.test(l));
}

/** A path is aider scratch when any segment is named `.aider…` (for example `.aider.tags.cache.v4/cache`). */
function aiderArtifact(p) { return String(p).split('/').some((seg) => seg.startsWith('.aider')); }

/** Worktree-local exclude so `git add` and `git status` never pick up aider scratch. Idempotent. */
async function excludeAiderArtifacts(wt, id) {
  const gp = await git(wt, ['rev-parse', '--git-path', 'info/exclude']);
  if (gp.code !== 0 || !gp.out.trim()) return;
  const rel = gp.out.trim();
  const file = path.isAbsolute(rel) ? rel : path.resolve(wt, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  if (cur.split('\n').some((l) => l.trim() === '.aider*')) return;
  fs.writeFileSync(file, `${cur.replace(/\s*$/, '')}\n.aider*\n`);
  if (id) ev(id, 'git', 'worktree exclude: .aider* (aider scratch is never committed)');
}

/** Commit worktree changes (excluding aider scratch files and an untracked npm lockfile). */
async function commitIfChanged(ctx, prefix) {
  const { task, wt } = ctx, id = task.id;
  await excludeAiderArtifacts(wt, id);
  const spec = commitSpec();
  const tracked = await git(wt, ['ls-files', '--error-unmatch', 'package-lock.json']);
  if (tracked.code !== 0) spec.push(':(exclude)package-lock.json');
  await git(wt, ['add', '-A', '--', ...spec]);
  const staged = await git(wt, ['diff', '--cached', '--name-only', '-z']);
  const scratch = staged.out.split('\0').filter((p) => p && aiderArtifact(p));
  if (scratch.length) {
    const un = await git(wt, ['reset', '-q', '--', ...scratch]);
    if (un.code !== 0) ev(id, 'error', `could not unstage aider artifacts: ${(un.err || un.error || '').slice(0, 200)}`);
    else ev(id, 'git', `skipped aider artifacts: ${scratch.join(', ')}`);
  }
  // mode-only / empty-file changes ("3 files changed, 0 insertions(+), 0 deletions(-)" on tasks #15-#30) are not work: unstage them
  const num = await git(wt, ['diff', '--cached', '--numstat']);
  if (num.out.trim() && onlyEmptyChanges(num.out)) {
    const paths = num.out.trim().split('\n').map((l) => l.split('\t').slice(2).join('\t')).filter(Boolean);
    await git(wt, ['reset', '-q', '--', ...paths]);
    ev(id, 'git', `skipped ${paths.length} change(s) with no content (mode or empty file only): ${paths.slice(0, 6).join(', ')}`);
  }
  const diff = await git(wt, ['diff', '--cached', '--shortstat']);
  const head = async () => (await git(wt, ['rev-parse', 'HEAD'])).out.trim();
  if (!diff.out.trim()) {
    ev(id, 'git', scratch.length ? 'no real file changes to commit (aider artifacts skipped)' : 'no changes to commit');
    return { changed: false, head_sha: await head() };
  }
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
  const followUp = !resume && Number(task.iteration) > 1 && !!task.branch;

  if (!store.transition(id, 'approved', 'running', { branch })) return;
  ev(id, 'system', `Task #${id} started: ${task.title} [project ${project ? project.name : '?'}, engine ${task.engine}${escResume ? ', ESCALATED to cursor' : ''}${planResume ? ', PLAN APPROVED -> implementing with cursor' : ''}]`);

  const lane = require('./extract/lane');
  const localLane = (task.engine === 'local' || task.engine === 'auto') && !resume;
  if (localLane) lane.hold();
  try {
    if (!project) return finish(task, status, 'failed', `project #${task.project_id} not found`);
    const service = task.service_id ? store.getService(task.service_id) : null;
    if (!service) return finish(task, status, 'failed', 'task has no service; every task runs inside one service (one git repo)');
    let repoRoot;
    try { repoRoot = repo.assertUsable(service); } catch (e) { return finish(task, status, 'failed', e.message); } // clear message BEFORE any git command
    const base = baseOf(task, service); // the service's default branch, or the previous step's branch for stacked sequence steps
    const wt = (resume || (followUp && task.worktree_path)) ? task.worktree_path : repo.worktreeFor({ ...task, worktree_path: null }, project, service);
    const ctx = {
      task, project, wt, root: wt, service, repoRoot, defaultBranch: service.default_branch, state, onSpawn, checkLines: [], escalation: null, plan: planResume ? task.plan_text : null,
      checkCmd: task.check_cmd || service.check_cmd || project.check_cmd || cfg.DEFAULT_CHECK, engineLabel: '',
    };

    // ---- 1. worktree + branch from the project's default branch (skipped when resuming an escalated task)
    if (resume) {
      if (!fs.existsSync(wt)) return finish(task, status, 'failed', `worktree ${wt} is gone; cannot escalate`);
      ev(id, 'git', `resuming in existing worktree ${wt}`);
    } else if (followUp) {
      ev(id, 'git', `follow-up iteration ${task.iteration} stays on ${task.branch}`);
      if (!fs.existsSync(wt)) {
        fs.mkdirSync(path.dirname(wt), { recursive: true });
        const add = await git(repoRoot, ['worktree', 'add', wt, task.branch]);
        ev(id, 'git', `git worktree add ${wt} ${task.branch} -> exit ${add.code} ${(add.err || '').trim().split('\n').pop() || ''}`);
        if (add.code !== 0) return finish(task, status, 'failed', `worktree creation failed: ${(add.err || add.error || '').trim().slice(0, 300)}`);
        await excludeAiderArtifacts(wt, id);
        store.updateFields(id, { worktree_path: wt });
      } else ev(id, 'git', `reusing worktree ${wt} on ${task.branch}`);
      const head = (await git(wt, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
      if (head !== task.branch) return finish(task, status, 'failed', `follow-up worktree is on '${head}', not ${task.branch}`);
    } else {
      const baseSource = task.base_ref ? 'task.base_ref' : 'service.default_branch';
      ev(id, 'git', `base ${base} from ${baseSource}`);
      if (task.base_ref && cfg.PROTECTED_BRANCHES.includes(task.base_ref)) {
        return finish(task, status, 'failed', `refusing protected base '${task.base_ref}' from task.base_ref (ORCH_PROTECTED_BRANCHES=${cfg.PROTECTED_BRANCHES.join(',')})`);
      }
      const expected = cfg.EXPECTED_BASE[service.name];
      if (expected && base !== expected) {
        if (task.base_ref) ev(id, 'git', `explicit base '${base}' overrides expected base '${expected}' for service ${service.name}`);
        else if (task.flow === 'v2') return finish(task, status, 'failed', `base_mismatch: service '${service.name}' resolved '${base}' from ${baseSource}, ORCH_EXPECTED_BASE expects '${expected}'`);
        else ev(id, 'git', `WARNING: base '${base}' from ${baseSource} does not match expected '${expected}' for service ${service.name} (ORCH_FLOW=v1, continuing)`);
      }
      const remote = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]);
      if (remote.code === 0) {
        const behind = await git(repoRoot, ['rev-list', '--count', `${base}..origin/${base}`]);
        const n = Number(String(behind.out).trim());
        if (Number.isInteger(n) && n > 0) ev(id, 'git', `base ${base} from ${baseSource} is ${n} commit(s) behind origin/${base} (local ref only, not fetched)`);
      }
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      if (fs.existsSync(wt)) return finish(task, status, 'failed', `worktree path already exists: ${wt}`);
      const b = await git(repoRoot, ['rev-parse', '--verify', `${base}^{commit}`]);
      if (b.code !== 0) return finish(task, status, 'failed', `base branch '${base}' not found in ${repoRoot}`);
      if (!task.branch) { // pick a free branch name (stale branches from older runs must not block a task)
        const root0 = branch; let n = 2;
        while ((await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0 && n < 50) branch = `${root0}-${n++}`;
        if (branch !== root0) { ev(id, 'git', `branch ${root0} already exists; using ${branch}`); store.updateFields(id, { branch }); }
      }
      // the task's own branch left over from an earlier run (task #1: "a branch named 'ai/task-1' already exists"): check it out again instead of failing
      const bp = task.branch ? await branchPlan(repoRoot, branch) : { mode: 'new' };
      if (bp.mode === 'busy') return finish(task, status, 'failed', `branch ${branch} is checked out in another worktree (${bp.at}); remove that worktree or reject the old task first`);
      const addArgs = bp.mode === 'reuse' ? ['worktree', 'add', wt, branch] : ['worktree', 'add', '-b', branch, wt, base];
      if (bp.mode === 'reuse') ev(id, 'git', `branch ${branch} already exists and is not checked out; reusing it (its commits stay)`);
      const add = await git(repoRoot, addArgs);
      ev(id, 'git', `git ${addArgs.join(' ')} -> exit ${add.code} ${add.err.trim().split('\n').pop() || ''}`);
      if (add.code !== 0) return finish(task, status, 'failed', `worktree creation failed: ${(add.err || add.error || '').trim().slice(0, 300)}`);
      ev(id, 'git', `base ${base} @ ${b.out.trim().slice(0, 7)}; worktree ${wt}`);
      await excludeAiderArtifacts(wt, id);
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
      const cloud = task.engine !== 'local';
      let extra = features.contextParts(task);
      try {
        const exp = require('./attachments').exposeFor({ taskId: id, cloud, maxChars: Math.floor(settings.effective(project).context_max_chars * 0.2) });
        if (exp.text) extra = extra.concat([{ title: 'ATTACHMENTS', source: 'derived-text', body: require('./prompt-compact').compact(exp.text, { kind: 'prose' }).text, share: 0.2 }]);
        ev(id, 'system', `attachments: sent to Cursor: ${cloud && exp.manifest.some((m) => m.included) ? 'yes' : 'no'}`);
      } catch (e) { ev(id, 'error', `attachments: ${e.message}`); }
      const b = context.buildBundle({ project, service, services: store.listServices(project.id), taskText: `${task.title}\n${task.prompt}`, maxChars: settings.effective(project).context_max_chars, extraParts: extra });
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
    // v2 auto tasks leave the v1 lane here. v1, and v2 engine=local, keep the path below.
    if (!resume && (Number(task.iteration) > 1 || (task.flow === 'v2' && task.engine === 'auto'))) {
      let runTask = task;
      if (Number(task.iteration) > 1) {
        const prompt = await require('./flow/follow-up').promptFor(task, ctx);
        runTask = { ...task, prompt };
        ctx.task = runTask;
      }
      return require('./flow/pipeline').runV2(runTask, ctx, {
        status, planWithCursor: planPhase, codeWithCursor: cursorPhase, runCheck, commitIfChanged, pickPlan,
        finish: (from, to, summary, extra) => finish(task, from, to, summary, extra),
      });
    }
    const engine = task.engine === 'auto' ? (resume ? 'cursor' : 'local') : task.engine;
    const model = task.model || cfg.CURSOR_MODEL;
    ctx.engineLabel = engine === 'local' ? `aider ${models.aiderModelArg()}` : `cursor ${model}`;
    store.updateFields(id, { engine_used: escResume ? 'local+cursor' : engine });
    let v2Planned = false;
    if (task.engine === 'auto' && engine === 'local' && !resume) {
      const decision = require('./flow/plan').isMultiFile(task.prompt, null);
      if (decision.multi) {
        const listed = decision.paths.slice(0, 8).join(', ');
        if (task.flow !== 'v2') {
          ev(id, 'system', `WARNING: multi-file prompt (${listed || decision.reason}); v1 stays on the local engine`);
        } else {
          ev(id, 'route', `route ${decision.reason}: multi-file prompt (${listed || 'complex'}) → Cursor planner`);
          store.updateFields(id, { engine_used: 'cursor' });
          ctx.engineLabel = `cursor ${model}`;
          const pl = await planPhase(ctx);
          if (state.cancelled) return finish(task, status, 'failed', 'cancelled by user');
          const picked = pickPlan(pl);
          if (!pl.ok || !picked.text) return finish(task, status, 'failed', `plan run failed: ${pl.note || 'empty plan'}`);
          try { fs.writeFileSync(path.join(cfg.LOG_DIR, `cursor-task-${id}-plan.md`), picked.text + '\n'); } catch { /* the DB copy is the source of truth */ }
          if (picked.problem) { ev(id, 'error', `plan rejected: ${picked.problem}`); return finish(task, status, 'failed', `plan run failed: ${picked.problem}`); }
          store.updateFields(id, { plan_text: picked.text });
          ctx.plan = picked.text;
          ev(id, 'plan', `planner cursor ${model}: plan stored (${picked.text.length} chars, source: ${picked.source}); implementing with no plan-approval gate`);
          v2Planned = true;
        }
      }
    }
    if (escResume) {
      const reason = (task.result_summary || 'local attempt failed').replace(/; escalation to Cursor requested$/, '').slice(0, 400);
      ctx.escalation = { reason, checkTail: '' };
      const ch = (store.eventsAfter(id, 0, 5000).filter((e) => e.kind === 'check').slice(-25).map((e) => e.message)).join('\n');
      ctx.escalation.checkTail = ch.slice(-2500);
    }
    if (!v2Planned && engine === 'cursor' && task.plan_first && !task.plan_state && !resume) { // plan-first: read-only plan run, then wait for a human to approve it
      ev(id, 'system', 'plan_first: running Cursor in --mode plan first; implementation only starts after you approve the plan');
      const pl = await planPhase(ctx);
      if (state.cancelled) return finish(task, status, 'failed', 'cancelled by user');
      const picked = pickPlan(pl);
      if (!pl.ok || !picked.text) return finish(task, status, 'failed', `plan run failed: ${pl.note || 'empty plan'}`);
      try { fs.writeFileSync(path.join(cfg.LOG_DIR, `cursor-task-${id}-plan.md`), picked.text + '\n'); } catch { /* the DB copy is the source of truth */ }
      if (picked.problem) { ev(id, 'error', `plan rejected: ${picked.problem}`); return finish(task, status, 'failed', `plan run failed: ${picked.problem}`); }
      store.updateFields(id, { plan_text: picked.text, plan_state: 'pending', result_summary: `plan ready (${pl.note}); waiting for plan approval` });
      ev(id, 'cursor', `PLAN stored on the task (${picked.text.length} chars, source: ${picked.source}); waiting for approve-plan`);
      store.transition(id, status, 'awaiting_plan');
      return;
    }
    const eng = (v2Planned || engine !== 'local') ? await cursorPhase(ctx) : await aiderPhase(ctx);
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
      await features.onTaskReview(task); // provider of a cross-repo feature: extract the actual API + drift check (deterministic, no LLM)
      await memory.proposeForTask(id); // local LLM, pending human approval; never writes memory by itself
      return;
    }

    // ---- 5. failed: engine=auto may escalate local -> cursor (explicit; by default needs a human click)
    const reason = !hasWork && eng.ok ? `${eng.label} made no changes` : !eng.ok ? eng.note : `check failed: ${check.note}`;
    const failSummary = [!hasWork && eng.ok ? `${eng.label} made no changes` : '', ...bits].filter(Boolean).join('; ');
    const extra = hasWork ? { head_sha: commit.head_sha } : {};
    if (task.engine === 'auto' && !resume && !eng.cancelled) {
      if (!task.allow_escalation) { ev(id, 'escalation', 'local attempt failed; escalation NOT allowed for this task (allow_escalation=false)'); return finish(task, status, 'failed', `${failSummary}; escalation not allowed`, extra); }
      const u = store.cursorStats(); // escalation 'blocked' is kept in the enum for old rows only; it is never produced now (no cap)
      ev(id, 'escalation', `local attempt failed (${reason}). Escalating to Cursor (model ${model}, runs on Cursor servers, uses Pro usage). Cursor runs so far: ${u.today.runs} today, ${u.total.runs} total.`);
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
  } finally { if (localLane) lane.release(); }
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
  const gate = features.gateState(task); // cross-repo features: contract approved + provider reviewed (and no drift) before a consumer starts
  if (gate) return gate;
  if (!task.group_id || !task.step_no || task.step_no <= 1) return { state: 'ready' };
  const group = store.getGroup(task.group_id);
  const prev = store.groupTasks(task.group_id).find((s) => s.step_no === task.step_no - 1);
  if (!group || !prev) return { state: 'ready' };
  if (group.dependency === 'independent') return { state: 'ready' }; // no ordering: steps (often in different repos) run on their own; one failure does not block the rest
  if (['failed', 'rejected'].includes(prev.status)) return { state: 'blocked', why: `previous step #${prev.id} (step ${prev.step_no}) is ${prev.status}` };
  if (prev.supervised) return { state: 'wait' };
  if (group.dependency === 'merged') return store.mergedToDefault(prev) ? { state: 'ready' } : { state: 'wait' };
  // stack: build on the previous step's branch once it passed its checks; a default-branch merge uses that branch instead
  if (prev.status === 'review' || (prev.status === 'done' && !store.mergedToDefault(prev))) return { state: 'ready', base: prev.branch };
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
  if (kind === 'local') return !slots.some((x) => x.kind === 'local') && !require('./extract/lane').heldNow();
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
  if ([...running.values()].some((x) => x.kind === 'local') || require('./extract/lane').heldNow()) throw new Error('the runner is busy with another local task/check; try again in a moment');
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
    if (ok) { await features.onTaskReview(task); await memory.proposeForTask(id); }
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

module.exports = { start, cancel, stopCurrent, releaseSupervised, commitSpec, running, canStart, scopeOf, scopesConflict, pickPlan, resolveAiderEditFormat, parseAiderTokens, charsToTokens, filesThatFit, runCheck, onlyEmptyChanges, branchPlan };
