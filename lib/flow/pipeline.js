'use strict';
// v2 task body. processTask calls it for a task stamped flow=v2 with engine auto, and for a follow-up iteration.
// Cursor is reached through the injected planWithCursor / codeWithCursor callbacks (runCursor stays in runner.js).
const path = require('node:path');
const cfg = require('../../config');
const store = require('../db');
const ollama = require('../ollama');
const { git } = require('../proc');
const memory = require('../memory');
const features = require('../features');
const { isMultiFile, planLocal, planCursor } = require('./plan');
const { decide } = require('./policy');
const { discover } = require('./reader');
const { editStep } = require('./coder');

const ev = (id, kind, msg) => store.addEvent(id, kind, msg);
const j = (obj) => JSON.stringify(obj);

async function installedModels() {
  const r = await ollama.listModels();
  return r && r.ok ? r.models.map((m) => m.name).filter(Boolean) : [];
}

async function unload(model, chat) {
  if (!model) return;
  const talk = chat || ((body) => ollama.chat('ollama', body));
  await talk({ model, messages: [{ role: 'user', content: 'ping' }], stream: false, keep_alive: 0, think: false, options: { num_predict: 1 } });
}

/** Free the previous local model (keep_alive 0) before another model or Cursor takes over; two 9B models do not fit in 16 GB. */
async function switchModel(prev, next, chat) {
  if (!prev || prev === next) return false;
  await unload(prev, chat);
  return true;
}

function stepsFrom(task, reader, planned, scope) {
  if (scope && scope.edit.length) {
    // the prompt named its files: plan steps may only touch those (created files first), every named file gets a step
    const fromPlan = planned && planned.ok && planned.plan ? planned.plan.steps.filter((s) => scope.edit.includes(s.file)) : [];
    const order = [...scope.created.filter((f) => scope.edit.includes(f)), ...scope.edit.filter((f) => !scope.created.includes(f))];
    const steps = order.map((file, i) => fromPlan.find((s) => s.file === file) || { id: String(i + 1), file, intent: task.prompt, acceptance: 'check passes', estLines: 20 });
    const risk = (planned && planned.ok && planned.plan && planned.plan.risk) || { files: steps.length, crossModule: false, contract: false, estDiff: 20 };
    return { targetBranch: (planned && planned.plan && planned.plan.targetBranch) || task.base_ref || null, steps, risk };
  }
  if (planned && planned.ok && planned.plan && planned.plan.steps.length) return planned.plan;
  const named = [...new Set([...(task.files || []), ...((reader && reader.files) || []).map((f) => f.path)])].filter(Boolean);
  return { targetBranch: task.base_ref || null, steps: named.map((file, i) => ({ id: String(i + 1), file, intent: task.prompt, acceptance: 'check passes', estLines: 20 })), risk: { files: named.length, crossModule: false, contract: false, estDiff: 20 } };
}

function readIn(ctx, rel) {
  try { return require('node:fs').readFileSync(path.join(ctx.root || ctx.wt, rel), 'utf8'); } catch { return null; }
}

/**
 * Edit / read-only files for a task. Pinned task files win (a split part keeps its own files; the rest of the prompt's Files
 * section becomes read-only context). Otherwise the prompt's Files section, else path-like tokens that exist or are marked (new).
 */
function promptScope(task, ctx) {
  const fs = require('node:fs');
  const exists = (f) => { try { return fs.existsSync(path.join(ctx.root || ctx.wt, f)); } catch { return false; } };
  const pf = require('./prompt-files').parsePromptFiles(task.prompt, { exists });
  const pinned = (task.files || []).filter((f) => f && require('./prompt-files').looksLikePath(f));
  if (!pinned.length) return pf;
  const read = [...new Set([...pf.read, ...pf.edit.filter((f) => !pinned.includes(f) && !pf.created.includes(f) && exists(f))])].filter((f) => !pinned.includes(f));
  return { edit: pinned, read, created: pf.created.filter((f) => pinned.includes(f)), section: pf.section };
}

async function runV2(task, ctx, hooks) {
  const id = task.id;
  const { planWithCursor, codeWithCursor, runCheck, commitIfChanged, pickPlan } = hooks;
  let status = hooks.status || 'running';
  const state = ctx.state;
  const finish = (to, summary, extra) => {
    const from = status;
    status = to;
    hooks.finish(from, to, summary, extra);
  };
  const base = task.base_ref || ctx.defaultBranch;

  async function conclude(eng) {
    if (state && state.cancelled) {
      const c = await commitIfChanged(ctx, '[cancelled] ');
      return finish('failed', 'cancelled by user', c.changed ? { head_sha: c.head_sha } : {});
    }
    let check = { ok: false, note: `skipped (${eng.label || 'engine'} failed)` };
    if (eng.ok) {
      if (status === 'running' && store.transition(id, 'running', 'checking')) status = 'checking';
      check = await runCheck(ctx);
    }
    const tag = !eng.ok ? (eng.tag || '') : !check.ok ? '[check failed] ' : '';
    const commit = await commitIfChanged(ctx, tag);
    const ahead = Number((await git(ctx.wt, ['rev-list', '--count', `${base}..HEAD`])).out.trim()) || 0;
    const hasWork = commit.changed || ahead > 0;
    const stat = hasWork ? (await git(ctx.wt, ['diff', '--shortstat', `${base}...HEAD`])).out.trim() : '';
    const bits = [eng.note || eng.label || '', `check: ${check.note}`, hasWork ? `commit ${String(commit.head_sha).slice(0, 7)} (${stat})` : 'no file changes were produced'].filter(Boolean);
    if (eng.ok && check.ok && hasWork) {
      finish('review', bits.join('; '), { head_sha: commit.head_sha });
      await features.onTaskReview(task);
      await memory.proposeForTask(id);
      return;
    }
    finish('failed', bits.join('; '), commit.changed ? { head_sha: commit.head_sha } : {});
  }

  // cancel is terminal for the whole task: checked before every phase, step, attempt, escalation and check
  const cancelled = () => !!(state && state.cancelled);
  const stopCancelled = () => conclude({ ok: false, label: 'cancel', note: 'cancelled by user' });
  const budgetChars = Math.floor(cfg.LOCAL_NUM_CTX * 4 * 0.6);
  if (task.service_id) {
    try {
      const svc = store.getService(task.service_id);
      const project = store.getProject(task.project_id);
      if (svc && !svc.archived) {
        const idx = await require('../index/build').ensureFresh(svc, project);
        if (idx.rebuilt) ev(id, 'system', `index: built ${(idx.commit_sha || '').slice(0, 8)} (${idx.file_count} files, ${(idx.changed || []).length} updated)`);
      }
    } catch (e) { ev(id, 'error', `index: ${e.message}`); }
  }
  let reader = { files: [], snippets: [], index: [] };
  try { reader = await discover({ wt: ctx.wt, root: ctx.root, prompt: task.prompt, budgetChars }); }
  catch (e) { ev(id, 'error', `reader: ${e.message}`); }

  if (cancelled()) return stopCancelled();
  const scope = promptScope(task, ctx);
  if (scope.edit.length || scope.read.length) ev(id, 'route', `files: edit [${scope.edit.join(', ')}]${scope.created.length ? ` (new: ${scope.created.join(', ')})` : ''}${scope.read.length ? `; read-only [${scope.read.join(', ')}]` : ''}${scope.section ? ' (from the Files section)' : ''}`);
  ctx.readOnly = scope.read;
  const decisionRaw = isMultiFile(task.prompt, { files: reader.files, index: reader.index });
  const decision = scope.edit.length ? { multi: scope.edit.length > 1, reason: scope.edit.length > 1 ? 'files' : null, paths: scope.edit } : decisionRaw;
  const named = scope.edit.length ? scope.edit : [...new Set([...(task.files || []), ...decision.paths])];
  const parts = decision.multi && !task.group_id ? require('./split').groupFiles(named, { max: cfg.LOCAL_MAX_FILES, created: scope.created, prompt: task.prompt, readFile: (f) => readIn(ctx, f) }) : [named];
  if (parts.length > 1) {
    // too many files for one local pass: split into a stacked sequence of small v2 tasks instead of one long Cursor run (task #7 timed out on 14 files)
    const splitMod = require('./split');
    const sp = splitMod.createSplit(task, named, { store, max: cfg.LOCAL_MAX_FILES, chunks: parts, readOnly: scope.read, readFile: (f) => readIn(ctx, f) });
    ev(id, 'route', `route split: ${named.length} files > ORCH_LOCAL_MAX_FILES=${cfg.LOCAL_MAX_FILES} → sequence #${sp.groupId} with ${sp.taskIds.length} part(s): ${sp.taskIds.map((t, i) => `#${t} [${sp.chunks[i].join(', ')}]`).join('; ')}${sp.autorun ? '; auto-run from this approval' : '; each part waits for approval (ORCH_SPLIT_AUTORUN=0)'}`);
    ev(id, 'route', j({ phase: 'route', engine: 'split', reason: 'files', group: sp.groupId, tasks: sp.taskIds, status: 'ok' }));
    store.updateFields(id, { routing_state: 'split' }); // shown as SPLIT, not as a failure (status stays 'failed': no schema change)
    return finish('failed', splitMod.sequenceProgress(id) || `split into sequence #${sp.groupId}: ${sp.taskIds.map((t) => `#${t}`).join(', ')}`);
  }
  if (decision.multi && cfg.V2_LOCAL_FAILS_BEFORE_CURSOR === 0) {
    const listed = decision.paths.slice(0, 8).join(', ');
    const model = task.model || cfg.CURSOR_MODEL;
    ev(id, 'route', `route ${decision.reason}: multi-file prompt (${listed || 'complex'}) → Cursor planner`);
    ev(id, 'route', j({ phase: 'route', engine: 'cursor', reason: decision.reason, reasons: [decision.reason], status: 'ok' }));
    store.updateFields(id, { engine_used: 'cursor' });
    ctx.engineLabel = `cursor ${model}`;
    const pl = await planWithCursor(ctx);
    if (state && state.cancelled) return finish('failed', 'cancelled by user');
    const picked = pickPlan(pl);
    if (!pl.ok || !picked.text) return finish('failed', `plan run failed: ${pl.note || 'empty plan'}`);
    if (picked.problem) { ev(id, 'error', `plan rejected: ${picked.problem}`); return finish('failed', `plan run failed: ${picked.problem}`); }
    store.updateFields(id, { plan_text: picked.text });
    ctx.plan = picked.text;
    ev(id, 'plan', `planner cursor ${model}: plan stored (${picked.text.length} chars, source: ${picked.source}); implementing with no plan-approval gate`);
    ev(id, 'plan', j({ phase: 'plan', engine: 'cursor', model, status: 'ok', reason: decision.reason }));
    const eng = await codeWithCursor(ctx);
    return conclude(eng);
  }

  if (decision.multi) ev(id, 'route', `route local: ${named.length} file(s) fit one local pass (≤ ${cfg.LOCAL_MAX_FILES}); Cursor only after ${cfg.V2_LOCAL_FAILS_BEFORE_CURSOR} failed local attempts`);
  const installed = await installedModels();
  const roles = require('./roles');
  const chainCfg = { ...cfg, V2_LOCAL_MODELS: roles.localChain(installed) }; // saved coding / debugging role models first
  for (const r of ['coder', 'repair']) { const w = roles.thinkWarning(r); if (w) ev(id, 'system', w); }
  const plannerModel = require('./roles').modelFor('planner', installed) || installed[0] || 'ornith:9b';
  let planned = await planLocal({ ...ctx, model: plannerModel }, reader, { model: plannerModel });
  if (cancelled()) return stopCancelled();
  if (!planned.ok) {
    ev(id, 'plan', j({ phase: 'plan', engine: 'local', model: planned.model, status: 'failed', reason: planned.error }));
    planned = await planCursor(ctx, reader, planWithCursor);
    if (cancelled()) return stopCancelled();
  }
  const plan = stepsFrom(task, reader, planned, scope.edit.length ? scope : null);
  if (!plan.steps.length) return finish('failed', 'planner produced no files');
  const planModel = (planned && planned.model) || plannerModel;
  const planEngine = planned && planned.source === 'local' ? 'local' : 'cursor';
  if (planned && planned.text) store.updateFields(id, { plan_text: planned.text });
  else store.updateFields(id, { plan_text: j(plan) });
  ev(id, 'plan', j({ phase: 'plan', engine: planEngine, model: planModel, status: 'ok' }));
  ctx.plan = store.getTask(id).plan_text;

  let verifyFailed = 0, noEdit = 0, local2Used = false, cursorRuns = 0, currentModel = planEngine === 'local' ? planModel : plannerModel;
  let last = { ok: false, label: 'aider', note: 'no attempt' };
  const started = Date.now();
  for (const step of plan.steps) {
    let stepFails = 0;
    if (cancelled()) return stopCancelled();
    for (let attempt = 1; attempt <= cfg.V2_STEP_ATTEMPTS; attempt++) {
      if (cancelled()) return stopCancelled();
      if (Date.now() - started > cfg.V2_MAX_MIN * 60 * 1000) {
        ev(id, 'escalation', j({ phase: 'escalation', to: 'fail', reasons: ['budget'], status: 'failed' }));
        return finish('failed', 'budget');
      }
      const dirs = new Set(plan.steps.map((s) => { const i = s.file.lastIndexOf('/'); return i < 0 ? '' : s.file.slice(0, i); }).filter(Boolean));
      const d = decide({
        files: plan.steps.length, dirs: dirs.size, pinnedFiles: (task.files || []).length,
        riskArea: !!(plan.risk && (plan.risk.crossModule || plan.risk.contract)), estDiff: plan.risk && plan.risk.estDiff,
        requestChars: String(task.prompt || '').length, verifyFailed, noEdit, loop: attempt - 1, cursorRuns,
        installed, currentModel, local2Used, localFails: stepFails,
      }, chainCfg);
      if (d.reasons.length) ev(id, 'escalation', j({ phase: 'escalation', to: d.engine, model: d.model, reasons: d.reasons, reason: d.reasons[0], file: step.file, status: d.engine === 'fail' ? 'failed' : 'running' }));
      if (d.engine === 'fail') return finish('failed', `budget: ${d.reasons.join(',')}`);
      if (d.engine === 'local2') local2Used = true;
      if (await switchModel(currentModel, d.engine === 'cursor' ? null : d.model)) ev(id, 'system', `unloaded ${currentModel} (keep_alive 0) before ${d.engine === 'cursor' ? 'Cursor' : d.model}`);
      const t0 = Date.now();
      if (d.engine === 'cursor') {
        cursorRuns++;
        currentModel = null;
        store.updateFields(id, { engine_used: local2Used ? 'local+cursor' : 'cursor' });
        ctx.engineLabel = `cursor ${task.model || cfg.CURSOR_MODEL}`;
        last = await codeWithCursor(ctx);
      } else {
        currentModel = d.model;
        ctx.engineLabel = `aider ${d.model}`;
        store.updateFields(id, { engine_used: d.engine === 'local2' ? 'local+local2' : 'local' });
        const rel = path.isAbsolute(step.file) ? step.file : step.file;
        last = await editStep(ctx, { ...step, file: rel }, { engine: 'aider', model: d.model, role: stepFails > 0 ? 'repair' : 'coder', snippets: (reader.snippets || []).filter((s) => s.path !== step.file),
          readOnly: ctx.readOnly || [], scope: scope.edit.length ? [...scope.edit, ...scope.read] : null });
        last.label = 'aider';
        last.note = last.ok ? `aider edited ${step.file}` : (last.error || last.reason || 'no edit');
      }
      if (cancelled()) { ev(id, 'attempt', j({ phase: 'attempt', file: step.file, engine: d.engine === 'local2' ? 'local' : d.engine, model: d.model, status: 'cancelled', reason: 'cancelled', ms: Date.now() - t0 })); return stopCancelled(); }
      const checkNote = last.ok ? null : null;
      let check = null;
      if (!last.ok) noEdit++;
      else {
        if (status === 'running' && store.transition(id, 'running', 'checking')) status = 'checking';
        check = await runCheck(ctx);
        if (status === 'checking' && store.transition(id, 'checking', 'running')) status = 'running';
        if (cancelled()) return stopCancelled();
        if (!check.ok) verifyFailed++;
      }
      ev(id, 'attempt', j({ phase: 'attempt', file: step.file, engine: d.engine === 'local2' ? 'local' : d.engine, model: d.model, status: last.ok && check && check.ok ? 'ok' : 'failed', reason: d.reasons[0] || (!last.ok ? 'no_edit' : (check && !check.ok ? 'verify_failed>=2' : null)), check: check ? check.note : checkNote, repair: attempt > 1, ms: Date.now() - t0 }));
      if (last.ok && check && check.ok) { last = { ...last, ok: true, label: last.label || 'aider', note: last.note }; break; }
      if (d.engine !== 'cursor') stepFails++;
      last = { ...last, ok: false };
    }
  }
  return conclude(last.ok ? last : { ...last, ok: false, label: last.label || 'aider' });
}

module.exports = { runV2, switchModel };
