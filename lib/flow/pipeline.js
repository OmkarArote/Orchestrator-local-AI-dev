'use strict';
// v2 task body. Called from processTask only when ORCH_FLOW=v2 and the engine is auto.
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

async function unload(model) {
  if (!model) return;
  await ollama.chat('ollama', { model, messages: [{ role: 'user', content: 'ping' }], stream: false, keep_alive: 0, think: false, options: { num_predict: 1 } });
}

function stepsFrom(task, reader, planned) {
  if (planned && planned.ok && planned.plan && planned.plan.steps.length) return planned.plan;
  const named = [...new Set([...(task.files || []), ...((reader && reader.files) || []).map((f) => f.path)])].filter(Boolean);
  return { targetBranch: task.base_ref || null, steps: named.map((file, i) => ({ id: String(i + 1), file, intent: task.prompt, acceptance: 'check passes', estLines: 20 })), risk: { files: named.length, crossModule: false, contract: false, estDiff: 20 } };
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

  const budgetChars = Math.floor(cfg.LOCAL_NUM_CTX * 4 * 0.6);
  let reader = { files: [], snippets: [], index: [] };
  try { reader = await discover({ wt: ctx.wt, root: ctx.root, prompt: task.prompt, budgetChars }); }
  catch (e) { ev(id, 'error', `reader: ${e.message}`); }

  const decision = isMultiFile(task.prompt, { files: reader.files, index: reader.index });
  if (decision.multi) {
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

  const installed = await installedModels();
  let planned = await planLocal({ ...ctx, model: installed[0] || 'ornith:9b' }, reader, { model: installed[0] || 'ornith:9b' });
  if (!planned.ok) {
    ev(id, 'plan', j({ phase: 'plan', engine: 'local', model: planned.model, status: 'failed', reason: planned.error }));
    planned = await planCursor(ctx, reader, planWithCursor);
  }
  const plan = stepsFrom(task, reader, planned);
  if (!plan.steps.length) return finish('failed', 'planner produced no files');
  const planModel = (planned && planned.model) || (installed[0] || null);
  const planEngine = planned && planned.source === 'local' ? 'local' : 'cursor';
  if (planned && planned.text) store.updateFields(id, { plan_text: planned.text });
  else store.updateFields(id, { plan_text: j(plan) });
  ev(id, 'plan', j({ phase: 'plan', engine: planEngine, model: planModel, status: 'ok' }));
  ctx.plan = store.getTask(id).plan_text;

  let verifyFailed = 0, noEdit = 0, local2Used = false, cursorRuns = 0, currentModel = planEngine === 'local' ? planModel : (installed[0] || null);
  let last = { ok: false, label: 'aider', note: 'no attempt' };
  const started = Date.now();
  for (const step of plan.steps) {
    for (let attempt = 1; attempt <= cfg.V2_STEP_ATTEMPTS; attempt++) {
      if (Date.now() - started > cfg.V2_MAX_MIN * 60 * 1000) {
        ev(id, 'escalation', j({ phase: 'escalation', to: 'fail', reasons: ['budget'], status: 'failed' }));
        return finish('failed', 'budget');
      }
      const dirs = new Set(plan.steps.map((s) => { const i = s.file.lastIndexOf('/'); return i < 0 ? '' : s.file.slice(0, i); }).filter(Boolean));
      const d = decide({
        files: plan.steps.length, dirs: dirs.size, pinnedFiles: (task.files || []).length,
        riskArea: !!(plan.risk && (plan.risk.crossModule || plan.risk.contract)), estDiff: plan.risk && plan.risk.estDiff,
        requestChars: String(task.prompt || '').length, verifyFailed, noEdit, loop: attempt - 1, cursorRuns,
        installed, currentModel, local2Used,
      }, cfg);
      if (d.reasons.length) ev(id, 'escalation', j({ phase: 'escalation', to: d.engine, model: d.model, reasons: d.reasons, reason: d.reasons[0], file: step.file, status: d.engine === 'fail' ? 'failed' : 'running' }));
      if (d.engine === 'fail') return finish('failed', `budget: ${d.reasons.join(',')}`);
      if (d.engine === 'local2') { await unload(currentModel); local2Used = true; }
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
        last = await editStep(ctx, { ...step, file: rel }, { engine: 'aider', model: d.model, snippets: (reader.snippets || []).filter((s) => s.path !== step.file) });
        last.label = 'aider';
        last.note = last.ok ? `aider edited ${step.file}` : (last.error || last.reason || 'no edit');
      }
      const checkNote = last.ok ? null : null;
      let check = null;
      if (!last.ok) noEdit++;
      else {
        if (status === 'running' && store.transition(id, 'running', 'checking')) status = 'checking';
        check = await runCheck(ctx);
        if (status === 'checking' && store.transition(id, 'checking', 'running')) status = 'running';
        if (!check.ok) verifyFailed++;
      }
      ev(id, 'attempt', j({ phase: 'attempt', file: step.file, engine: d.engine === 'local2' ? 'local' : d.engine, model: d.model, status: last.ok && check && check.ok ? 'ok' : 'failed', reason: d.reasons[0] || (!last.ok ? 'no_edit' : (check && !check.ok ? 'verify_failed>=2' : null)), check: check ? check.note : checkNote, repair: attempt > 1, ms: Date.now() - t0 }));
      if (last.ok && check && check.ok) { last = { ...last, ok: true, label: last.label || 'aider', note: last.note }; break; }
      last = { ...last, ok: false };
    }
  }
  return conclude(last.ok ? last : { ...last, ok: false, label: last.label || 'aider' });
}

module.exports = { runV2 };
