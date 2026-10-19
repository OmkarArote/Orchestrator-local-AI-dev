#!/usr/bin/env node
// Stub of the Cursor `agent` CLI for orchestrator tests (no network, no Cursor usage).
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const LOG = process.env.STUB_LOG || '/tmp/stub-agent.log';
const log = (m) => fs.appendFileSync(LOG, `${new Date().toISOString()} pid=${process.pid} ${m}\n`);
if (a[0] === 'status') { console.log(JSON.stringify({ isAuthenticated: true, userInfo: { email: 'stub@local' }, status: 'ok' })); process.exit(0); }
if (a.includes('--version')) { console.log('stub-1.0'); process.exit(0); }
if (a.includes('--list-models')) { console.log('auto - Auto\nsonnet-4 - Sonnet 4'); process.exit(0); }
const prompt = a[a.length - 1];
const mode = a.includes('--mode') ? a[a.indexOf('--mode') + 1] : (a.includes('--force') ? 'force' : 'default');
const ws = a[a.indexOf('--workspace') + 1];
const sleepMs = Number(process.env.STUB_SLEEP_MS || 8000);
log(`START mode=${mode} cwd=${process.cwd()} workspace=${ws} model=${a[a.indexOf('--model') + 1]} args=${JSON.stringify(a.slice(0, -1))}`);
fs.writeFileSync(`${LOG}.prompt-${process.pid}.txt`, prompt);
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'system', subtype: 'init', model: 'stub-model-1 (resolved from auto)', session_id: 's' + process.pid, permissionMode: mode, cwd: process.cwd() });
setTimeout(() => {
  let text;
  if (mode === 'plan') {
    // like the real CLI: the full plan arrives as a createPlan tool call; the final `result` is only the assistant preamble.
    // STUB_PLAN_TINY: no createPlan and a short preamble (truncated plan). STUB_PLAN_TEXT_ONLY: no createPlan, long assistant answer.
    const plan = '1. Edit the service index.js\n2. Add a test\n3. Run the check\n(stub plan; context bundle present: ' + /PROJECT CONTEXT/.test(prompt) + ')';
    if (/STUB_PLAN_TINY/.test(prompt)) text = "I'll trace the code before proposing a plan.";
    else if (/STUB_PLAN_TEXT_ONLY/.test(prompt)) text = plan + '\n' + 'Details: '.padEnd(700, 'x');
    else {
      out({ type: 'tool_call', subtype: 'started', call_id: 'p1', tool_call: { createPlanToolCall: { args: { plan } } } });
      out({ type: 'tool_call', subtype: 'completed', call_id: 'p1', tool_call: { createPlanToolCall: { args: { plan }, result: { success: {} } } } });
      text = "I'll trace the code before proposing a plan.";
    }
  } else {
    const f = path.join(process.cwd(), `STUB-${process.pid}.md`);
    fs.writeFileSync(f, `stub change ${new Date().toISOString()}\n`);
    text = 'done (stub wrote ' + path.basename(f) + ')';
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] }, model_call_id: 'm1' });
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: sleepMs, result: text, usage: { inputTokens: 10, outputTokens: 5 } });
  log(`END mode=${mode}`);
  process.exit(0);
}, sleepMs);
