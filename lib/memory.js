'use strict';
// Memory proposals: after a task reaches `review`, the LOCAL model (free) drafts 1-5 durable notes (what changed, decisions, gotchas).
// They are stored as a pending memory_proposals row. NOTHING is appended to the project MEMORY.md without a human clicking Approve.
const cfg = require('../config');
const store = require('./db');
const context = require('./context');
const settings = require('./settings');
const llm = require('./llm');
const models = require('./models');
const repo = require('./repo');
const { git } = require('./proc');

const SCHEMA = { type: 'object', properties: { notes: { type: 'array', items: { type: 'string' }, maxItems: 5 } }, required: ['notes'] };

/** Validate {notes:[...]} -> up to 5 clean one-line bullets (dedupe against existing memory). */
function cleanNotes(j, existingMd = '') {
  if (!j || typeof j !== 'object' || !Array.isArray(j.notes)) return { ok: false, error: "reply has no 'notes' array" };
  const have = new Set(String(existingMd).split('\n').map((l) => l.replace(/^[-*]\s*/, '').trim().toLowerCase()).filter(Boolean));
  const out = [];
  for (const n of j.notes) {
    if (typeof n !== 'string') continue;
    const t = n.replace(/\s+/g, ' ').replace(/^[-*]\s*/, '').replace(/^\d{4}-\d{2}-\d{2}\s*[-:]\s*/, '').trim().slice(0, 300); // dates/headings are added on approval
    if (t.length < 8 || have.has(t.toLowerCase()) || out.includes(t)) continue;
    out.push(t);
    if (out.length === 5) break;
  }
  return { ok: true, notes: out };
}

/** Generate and store a pending proposal for a task. Returns the proposal id or null. Never throws. */
async function proposeForTask(taskId) {
  const ev = (m) => store.addEvent(taskId, 'memory', m);
  try {
    const task = store.getTask(taskId);
    const project = store.getProject(task.project_id);
    if (!settings.effective(project).memory_proposals) return null;
    const service = task.service_id ? store.getService(task.service_id) : null;
    if (!service) { ev('memory proposal skipped: task has no service'); return null; }
    const base = task.base_ref || service.default_branch;
    const cwd = task.worktree_path || repo.assertUsable(service);
    const stat = (await git(cwd, ['diff', '--stat', `${base}...${task.branch || 'HEAD'}`])).out.trim();
    let diff = (await git(cwd, ['diff', '-U1', `${base}...${task.branch || 'HEAD'}`])).out;
    if (diff.length > 5000) diff = diff.slice(0, 5000) + '\n[... diff truncated]';
    const existing = context.read(project, 'MEMORY.md') || '';
    const system = `You maintain a project's shared MEMORY file used by AI coding agents. Reply with ONE JSON object: {"notes": ["...", ...]}.
Write 1 to 5 short bullet strings (max ~200 chars each): first = what changed (one line); then durable decisions, conventions, or gotchas a future engineer/agent must know. No dates, no headings, no changelog fluff, no code blocks, nothing speculative, nothing already in the existing memory. Return {"notes": []} only if nothing durable happened.`;
    const user = `PROJECT: ${project.name}${service ? ` | SERVICE: ${service.name}` : ''}\nTASK: ${task.title}\n${String(task.prompt).slice(0, 1500)}\n\nRESULT: ${String(task.result_summary || '').slice(0, 500)}\n\nDIFF STAT:\n${stat}\n\nDIFF:\n${diff}\n\nEXISTING MEMORY (tail):\n${existing.slice(-1200) || '(empty)'}\n\nJSON:`;
    const role = models.effective('memory');
    ev(`generating memory proposal with local model ${role.model} (nothing is saved to memory without your approval)`);
    const r = await llm.chatJson({ system, user, api: 'ollama', numCtx: cfg.MEMORY_NUM_CTX, timeoutMs: cfg.MEMORY_TIMEOUT_MS, maxTokens: 500, schema: SCHEMA, model: role.model, options: role.options });
    if (!r.ok) { ev(`memory proposal unavailable: ${r.error}`); return null; }
    const c = cleanNotes(r.json, existing);
    if (!c.ok) { ev(`memory proposal unavailable: ${c.error}`); return null; }
    if (!c.notes.length) { ev('memory proposal: model found nothing durable to record (no proposal created)'); return null; }
    const id = store.createProposal({ project_id: project.id, task_id: taskId, service_id: service ? service.id : null, text: c.notes.map((n) => `- ${n}`).join('\n') });
    ev(`memory proposal #${id} created (${c.notes.length} note(s), prompt_tokens=${r.prompt_tokens ?? '?'}, ${r.ms}ms): pending your approval in the dashboard`);
    return id;
  } catch (e) { ev(`memory proposal failed: ${e.message}`); return null; }
}

/** Approve: append (possibly edited) text to the managed MEMORY.md. */
function approve(proposal, { text } = {}) {
  const project = store.getProject(proposal.project_id);
  const final = String(text !== undefined ? text : proposal.text).trim();
  if (!final) throw new Error('empty memory text');
  if (final.length > 4000) throw new Error('memory text too long (max 4000 chars)');
  if (proposal.status !== 'pending') throw new Error('proposal is not pending');
  context.appendMemory(project, { text: final, taskId: proposal.task_id, serviceName: proposal.service_name }); // write first: a failure leaves it pending
  if (!store.decideProposal(proposal.id, 'approved', null)) throw new Error('proposal is not pending');
  store.setProposalTextForce(proposal.id, final);
  return final;
}

module.exports = { proposeForTask, approve, cleanNotes };
