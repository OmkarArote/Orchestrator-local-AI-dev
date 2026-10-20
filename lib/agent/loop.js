'use strict';
// Plan, one tool, check, repeat. The same error twice, or a spent budget, escalates with a short summary.
const cfg = require('../../config');
const tools = require('./tools');

function summarize(findings) {
  return findings.filter(Boolean).slice(-8).join('\n').slice(0, 1500);
}

async function run({ chat, model, prompt, root, service, approved, runCheck, onEvent, maxIter, tokenBudget } = {}) {
  const limit = maxIter || cfg.AGENT_MAX_ITER;
  const budget = tokenBudget || cfg.AGENT_TOKEN_BUDGET;
  let tokens = 0;
  let lastErr = null;
  const findings = [];
  for (let i = 1; i <= limit; i++) {
    const t0 = Date.now();
    const reply = await chat({
      model: model || 'ornith:9b',
      prompt,
      findings: findings.slice(-4),
    });
    const used = Number(reply && (reply.tokens || reply.completion_tokens)) || 0;
    tokens += used;
    if (tokens > budget) {
      const summary = summarize([...findings, 'token budget spent']);
      if (onEvent) onEvent({ tool: 'budget', status: 'escalate', model, tokens, ms: Date.now() - t0, reason: 'token budget' });
      return { ok: false, escalate: true, summary };
    }
    const call = tools.parseCall(reply && (reply.content || reply.text));
    if (!call.ok) {
      findings.push(call.error);
      if (onEvent) onEvent({ tool: 'parse', status: 'failed', model, tokens: used, ms: Date.now() - t0, reason: call.error });
      if (lastErr === call.error) return { ok: false, escalate: true, summary: summarize(findings) };
      lastErr = call.error;
      continue;
    }
    let result;
    try {
      result = await tools.exec(call, { root, service, approved, runCheck });
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    if (onEvent) onEvent({ tool: call.tool, status: result.escalate ? 'escalate' : (result.ok ? 'ok' : 'failed'), model, tokens: used, ms: Date.now() - t0, reason: result.note || result.error || null });
    if (result.escalate) return { ok: false, escalate: true, summary: result.summary || summarize(findings) };
    if (!result.ok) {
      const err = result.error || 'tool failed';
      findings.push(`${call.tool}: ${err}`);
      if (lastErr === err) return { ok: false, escalate: true, summary: summarize(findings) };
      lastErr = err;
      continue;
    }
    lastErr = null;
    findings.push(`${call.tool}: ${result.note || 'ok'}`);
    if (call.tool === 'apply_patch' && typeof runCheck === 'function') {
      const check = await runCheck();
      if (check && check.ok) return { ok: true, escalate: false, summary: summarize(findings) };
      const err = (check && check.note) || 'check failed';
      findings.push(err);
      if (lastErr === err) return { ok: false, escalate: true, summary: summarize(findings) };
      lastErr = err;
    }
  }
  return { ok: false, escalate: true, summary: summarize([...findings, 'iteration budget']) };
}

module.exports = { run, summarize };
