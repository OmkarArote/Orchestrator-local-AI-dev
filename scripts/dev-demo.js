'use strict';
// Starts an ISOLATED demo instance (temp dirs, fake Ollama, stub aider/cursor) seeded with sample data, for UI work and screenshots.
// Never touches the real data dir or any real repo. Usage: node scripts/dev-demo.js [stateFile]   (Ctrl-C to stop; temp dir is kept until then)
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo, git } = require('../test/helpers/harness');

(async () => {
  const stateFile = process.argv[2] || '/tmp/orch-demo.json';
  const S = await startServer({ keep: false, env: { STUB_SLEEP_MS: '300', ORCH_TEST_ALLOW_FILE: '1' } });
  const mk = (name, files) => { const d = path.join(S.work, name); makeRepo(d, files); return d; };
  const billing = mk('billing-api', { 'README.md': '# billing\n', 'src/invoice.js': "exports.total = (items) => items.reduce((a, b) => a + b.price, 0);\n", 'package.json': '{"name":"billing","scripts":{"test":"node --test"}}\n' });
  const web = mk('web-app', { 'README.md': '# web\n', 'index.html': '<h1>Hello</h1>\n', 'package.json': '{"name":"web"}\n' });
  // test-only local bare repo so the Import flow can be exercised without any network (ORCH_TEST_ALLOW_FILE=1 is a test hook, off in production)
  const seed = path.join(S.base, 'seed-remote'); makeRepo(seed, { 'README.md': '# hello\n', 'hello.txt': 'hi\n' });
  const bare = path.join(S.base, 'remotes', 'hello.git'); fs.mkdirSync(path.dirname(bare), { recursive: true }); git(S.base, 'clone', '--bare', seed, bare);
  const { project } = await S.post('/projects', { name: 'Acme-Platform', description: 'Billing API and the customer web app. Billing owns invoices; the web app renders them.' });
  const a = await S.post(`/projects/${project.id}/services/add-existing`, { path: billing, name: 'billing-api', type: 'api', check_cmd: 'true', description: 'Invoices, taxes and payment webhooks' });
  const b = await S.post(`/projects/${project.id}/services/add-existing`, { path: web, name: 'web-app', type: 'web', check_cmd: 'true', description: 'Customer-facing React-less web page' });
  await S.post('/projects', { name: 'Internal-Tools', description: 'Scripts and dashboards for the ops team.' });
  await S.post(`/projects/${project.id}/deps`, { action: 'add', service_id: b.service.id, depends_on_service_id: a.service.id, note: 'GET /invoices' });
  await S.post(`/projects/${project.id}/deps`, { action: 'add', service_id: a.service.id, external: 'postgres', note: 'invoices table' });
  const t1 = await S.post('/tasks', { project_id: project.id, service_id: a.service.id, title: 'Add VAT to invoice totals', prompt: 'Add a vat parameter to total() in src/invoice.js', engine: 'local' });
  await S.post(`/tasks/${t1.id}/approve-start`, {});
  await S.waitStatus(t1.id, ['review', 'failed']);
  const t2 = await S.post('/tasks', { project_id: project.id, service_id: b.service.id, title: 'Show VAT line on the invoice page', prompt: 'Render the vat line in index.html', engine: 'local' });
  await S.post('/tasks', { project_id: project.id, service_id: a.service.id, title: 'Rename total() to subtotal()', prompt: 'rename', engine: 'local' });
  await S.post(`/projects/${project.id}/groups`, { title: 'VAT end to end', dependency: 'independent', steps: [{ service_id: a.service.id, engine: 'local', title: 'API: vat field', prompt: 'add vat field' }, { service_id: b.service.id, engine: 'local', title: 'Web: vat line', prompt: 'show vat line' }] }).catch((e) => console.error('group:', e.message));
  fs.writeFileSync(stateFile, JSON.stringify({ url: S.url, base: S.base, pid: process.pid, project: project.id, remote: 'file://' + bare, review_task: t1.id, other_task: t2.id, billing: a.service.id, web: b.service.id }));
  console.log('DEMO READY', S.url, stateFile);
  const bye = async () => { await S.stop(); fs.writeFileSync(stateFile, ''); process.exit(0); }; // harness.stop() removes the temp dir (this script never deletes anything itself)
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  setInterval(() => {}, 1e6);
})().catch((e) => { console.error(e); process.exit(1); });
