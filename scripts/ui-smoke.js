'use strict';
// Drives the real UI in headless Chrome over CDP against a demo instance (scripts/dev-demo.js): loads every route, clicks through the main flows
// and fails on any uncaught exception / console.error. Usage: node scripts/ui-smoke.js http://127.0.0.1:PORT
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const base = process.argv[2], remote = process.argv[3];
if (!base) { console.error('usage: ui-smoke.js <base url>'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const prof = process.env.ORCH_SMOKE_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'orch-chrome-smoke-')); // fresh profile per run (scripts/ui-smoke.sh removes it; this script never deletes anything)
  const port = 9300 + Math.floor(Math.random() * 500);
  const ch = spawn(CH, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${prof}`, `--remote-debugging-port=${port}`, '--window-size=1360,1000', 'about:blank'], { stdio: 'ignore' });
  let ws, id = 0; const pending = new Map(); const errors = []; const log = [];
  try {
    let targets; for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.find((t) => t.type === 'page' && t.url === 'about:blank')) break; } catch { /* wait */ } await sleep(200); }
    ws = new WebSocket(targets.find((t) => t.type === 'page' && t.url === 'about:blank').webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
      if (d.method === 'Runtime.exceptionThrown') errors.push('EXC ' + (d.params.exceptionDetails.exception ? d.params.exceptionDetails.exception.description : d.params.exceptionDetails.text));
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push('CONSOLE ' + d.params.args.map((a) => a.value || a.description).join(' '));
    };
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error('eval failed: ' + expr.slice(0, 80) + ' => ' + JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description)); return r.result.result.value; };
    await send('Runtime.enable'); await send('Page.enable');
    const go = async (hash) => { const nr = await send('Page.navigate', { url: base + '/' + hash }); if (process.env.SMOKE_DEBUG) console.error('navigate', base + '/' + hash, JSON.stringify(nr).slice(0, 200)); await sleep(1200); };
    const waitFor = async (expr, what, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(150); } throw new Error('timeout: ' + what); };
    const step = async (name, fn) => { try { await fn(); log.push('ok   ' + name); } catch (e) { let why = ''; try { why = await ev("[...document.querySelectorAll('.modal .callout.bad, .toast')].filter((x) => x.offsetParent !== null || x.classList.contains('toast')).map((x) => x.textContent.trim()).join(' | ')"); } catch { /* */ } let st = ''; try { st = await ev("location.hash + ' | modal: ' + ((document.querySelector('.modal')||{}).innerText||'none').replace(/\\n+/g,' / ').slice(0,200)"); } catch { /* */ } log.push('FAIL ' + name + ': ' + e.message + ' {' + st + '}' + (why ? ' [ui says: ' + why.slice(0, 300) + ']' : '')); } console.error(log[log.length - 1]); };
    const setVal = (sel, v) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`;
    const clickText = (sel, text) => `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)}) && !x.disabled); if (!e) return false; e.click(); return true; })()`;

    for (const h of ['#/projects', '#/projects/1/services', '#/projects/1/deps', '#/projects/1/context', '#/projects/1/memory', '#/projects/1/sequences', '#/projects/1/settings', '#/tasks', '#/tasks/1?nostream=1', '#/tasks/1?nostream=1&tab=diff', '#/models'])
      await step('route ' + h, async () => { await go(h); await waitFor("document.querySelector('#main') && document.querySelector('#main').children.length > 0 && ![...document.querySelectorAll('#main .callout.bad')].some((x) => x.offsetParent !== null)", 'render'); });
    await step('live log stream (SSE) renders', async () => { await go('#/tasks/1'); await waitFor("document.querySelectorAll('.term-line').length > 3", 'log lines'); });
    await step('new project via modal', async () => {
      await go('#/projects'); await ev(clickText('button', '+ New project')); await waitFor("document.querySelector('.modal input')", 'modal');
      await ev(setVal('.modal input', 'smoke-proj-' + Date.now().toString(36))); await ev(clickText('.modal button', 'Create project')); await waitFor("location.hash.startsWith('#/projects/') && location.hash.endsWith('/services')", 'navigate'); await waitFor("document.body.innerText.includes('No services yet')", 'empty state');
    });
    await step('add service: create new repo', async () => {
      await ev(clickText('button', '+ Add service')); await waitFor("document.querySelector('.modal .tabs')", 'modal'); await ev(clickText('.modal .tabs button', 'Create new'));
      await waitFor("document.querySelector('.modal input[placeholder=\"billing-api\"]')", 'create tab'); await ev(setVal('.modal input[placeholder="billing-api"]', 'smoke-svc-' + Date.now().toString(36)));
      await ev(clickText('.modal button', 'Create repository')); await waitFor("document.body.innerText.includes('smoke-svc-') && !document.querySelector('.modal')", 'service card');
    });
    if (remote) await step('add service: import from (test-only local bare) remote with progress', async () => {
      await ev(clickText('button', '+ Add service')); await waitFor("document.querySelector('.modal .tabs')", 'modal');
      await ev(setVal('.modal input[placeholder^=\"https://github.com\"]', remote)); await ev(setVal('.modal input[placeholder=\"derived from the URL\"]', 'imported-svc-' + Date.now().toString(36)));
      await ev(`(() => { const i = document.querySelectorAll('.modal input[placeholder=\"derived from the URL\"]')[1]; i.value = 'clone-' + Date.now().toString(36); i.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`); await ev(clickText('.modal button', 'Clone & add')); await waitFor("document.body.innerText.includes('imported-svc-') && !document.querySelector('.modal')", 'imported service card', 15000);
    });
    await step('service repo status', async () => { await ev(clickText('button', 'Repo status')); await waitFor("document.body.innerText.includes('clean')", 'status chips'); });
    await step('edit service', async () => { await ev(clickText('button', 'Edit')); await waitFor("document.querySelector('.modal')", 'modal'); await ev(clickText('.modal button', 'Save')); await waitFor("!document.querySelector('.modal')", 'saved'); });
    await step('new task modal -> create', async () => {
      await ev(clickText('button', '+ New task')); await waitFor("document.querySelector('.modal textarea')", 'modal'); await ev(setVal('.modal input[placeholder=\"Short title\"]', 'smoke task')); await ev(setVal('.modal textarea[placeholder=\"What should the model do?\"]', 'do a thing'));
      await sleep(600); await ev(clickText('.modal button', 'Create')); await waitFor("location.hash.startsWith('#/tasks/')", 'task page', 10000);
    });
    await step('task detail has approve/reject', async () => { await waitFor("document.body.innerText.includes('smoke task')", 'title'); });
    await step('project settings save', async () => { await go('#/projects/1/settings'); await waitFor("document.querySelector('#main .btn.primary')", 'settings'); await ev(clickText('#main button', 'Save settings')); await waitFor("document.querySelector('.toast')", 'toast'); });
    await step('models: role edit modal', async () => { await go('#/models'); await waitFor("document.body.innerText.includes('Roles')", 'roles'); await ev(clickText('button', 'Edit')); await waitFor("document.querySelector('.modal')", 'modal'); });
    await step('models: download buttons disabled', async () => { await go('#/models'); await waitFor("[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Download')", 'catalog'); const bad = await ev("[...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Download' && !b.disabled).length"); if (bad) throw new Error(bad + ' enabled download buttons'); });
    await step('theme toggle', async () => { await ev(clickText('button', '\u25D0 Theme')); await waitFor("document.documentElement.dataset.theme", 'theme set'); });
    await step('Esc closes modal', async () => { await go('#/projects'); await ev(clickText('button', '+ New project')); await waitFor("document.querySelector('.modal')", 'open'); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await waitFor("!document.querySelector('.modal')", 'closed'); });
    if (remote) await step('approve & merge task #1 through the confirm modal', async () => {
      await go('#/tasks/1?nostream=1'); await waitFor("[...document.querySelectorAll('#main button')].some((b) => b.textContent.trim().startsWith('Approve & merge'))", 'merge button');
      await ev(clickText('#main button', 'Approve & merge')); await waitFor("document.querySelector('.modal')", 'confirm modal'); await ev(clickText('.modal button', 'Approve & merge'));
      await waitFor("[...document.querySelectorAll('#main .badge')].some((b) => b.textContent.trim() === 'done')", 'status done', 10000);
    });
  } finally { try { ws && ws.close(); } catch { /* */ } ch.kill('SIGKILL'); }
  console.log(log.join('\n')); if (errors.length) console.log('--- browser errors ---\n' + [...new Set(errors)].join('\n'));
  const failed = log.filter((l) => l.startsWith('FAIL')).length + errors.length;
  console.log(failed ? `UI SMOKE: ${failed} problem(s)` : 'UI SMOKE: all steps passed, no browser errors'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
