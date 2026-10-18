'use strict';
// M13 (plan M3): @project / @service mentions in chat: parsing, resolution, lexical retrieval inside a budget, secret exclusion, authorized-root gate,
// manifest persistence, autocomplete, read-only guarantees. Fake Ollama only; repos are throw-away git repos under the test HOME.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { startServer, makeRepo, git, fingerprint, ROOT, sleep } = require('./helpers/harness');

function probe(code, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-m13-'));
  return new Promise((resolve, reject) => execFile(process.execPath, ['--no-warnings', '-e', code], { cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, ORCH_DB: path.join(dir, 'o.db'), ORCH_LOG_DIR: path.join(dir, 'logs'), ORCH_WORKTREES: path.join(dir, 'wt'), ...env } },
  (err, stdout, stderr) => { fs.rmSync(dir, { recursive: true, force: true }); if (err) return reject(new Error(`${err.message}\n${stderr}`)); resolve(JSON.parse(stdout.trim().split('\n').pop())); }));
}

async function chatPost(S, id, body) {
  const r = await fetch(`${S.url}/api/conversations/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = { status: r.status, events: [], json: null };
  if (!(r.headers.get('content-type') || '').includes('text/event-stream')) { out.json = await r.json().catch(() => null); return out; }
  let buf = ''; const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /^event: (.+)$/m.exec(b), d = /^data: (.+)$/m.exec(b); if (ev && d) out.events.push({ event: ev[1], data: JSON.parse(d[1]) }); }
  }
  return out;
}
const lastSystem = (S) => { const rs = S.fake.state.requests.filter((r) => r.path === '/api/chat' && r.body && r.body.stream === true); return rs[rs.length - 1].body.messages[0].content; };
const lastMessages = (S) => { const rs = S.fake.state.requests.filter((r) => r.path === '/api/chat' && r.body && r.body.stream === true); return rs[rs.length - 1].body.messages; };

describe('M13 mentions: pure units', () => {
  it('parsing: emails, code spans/fences, escaped @, punctuation, file pins, duplicates', async () => {
    const r = await probe(`const m = require('./lib/mentions');
      const p = (t) => m.parseMentions(t).map((x) => x.raw);
      console.log(JSON.stringify({
        email: p('mail me@example.com or a.b@c.io'), inline: p('use \`@code\` here'), fence: p('hi\\n\`\`\`js\\n@infence x\\n\`\`\`\\nthen @after'), unclosed: p('start @one\\n\`\`\`\\n@hidden'),
        esc: p('literally \\\\@billing and @real'), punct: p('(see @billing-api.) and @web, plus "@quoted" and @a/b:src/x.js, then @a/b:README.md?'), dup: p('@x @X @x'),
        dbl: p('@@weird and @ alone and @-bad'), start: p('@first at start'), multi: p('@p1/svc1:src/a.b.js and @p2'), long: p('@' + 'a'.repeat(80)),
      }));`);
    assert.deepEqual(r.email, []); assert.deepEqual(r.inline, []);
    assert.deepEqual(r.fence, ['@after']); assert.deepEqual(r.unclosed, ['@one']); assert.deepEqual(r.esc, ['@real']);
    assert.deepEqual(r.punct, ['@billing-api', '@web', '@quoted', '@a/b:src/x.js', '@a/b:README.md']);
    assert.deepEqual(r.dup, ['@x']); assert.deepEqual(r.dbl, []); assert.deepEqual(r.start, ['@first']); assert.deepEqual(r.multi, ['@p1/svc1:src/a.b.js', '@p2']);
    assert.equal(r.long.length, 1, 'over-long names are cut at 64 chars, not rejected');
  });

  it('keywords: quoted strings, paths and identifiers outrank plain words; stop words dropped', async () => {
    const r = await probe(`const c = require('./lib/chat-context'); console.log(JSON.stringify([
      c.keywordsOf('why does computeBackoffDelay fail with "ECONNRESET" in src/net/retry.js? please explain how the code works').map((k) => k.kw),
      c.keywordsOf('what is this and how does it work').map((k) => k.kw)]));`);
    assert.deepEqual(r[0].slice(0, 4).sort(), ['computebackoffdelay', 'econnreset', 'retry.js', 'src/net/retry.js'].sort());
    assert.ok(!r[0].includes('please') && !r[0].includes('explain') && !r[0].includes('code'));
    assert.deepEqual(r[1], []);
  });

  it('deny list, redaction', async () => {
    const r = await probe(`const rr = require('./lib/repo-reader');
      const paths = ['src/a.js', '.env', '.env.local', '.env.example', 'cfg/.env.production', 'k/server.pem', 'id_rsa', 'id_ed25519.pub', 'a/.ssh/config', '.aws/credentials', 'credentials.json', 'secrets/x.txt', 'config/secrets.yml', 'node_modules/p/i.js', 'dist/b.js', 'build/x', '.git/config', '.kube/config', 'terraform.tfstate', 'prod.tfvars', 'service-account-prod.json', 'package-lock.json', 'yarn.lock', 'app.min.js', 'app.js.map', 'data.sqlite', 'logo.png', 'doc.pdf', '.npmrc', 'vendor/x.go', 'README.md', 'docs/guide.md', 'src/secrets_helper.js', 'a/../b.js'];
      const redact = rr.redact('const dbPassword = "hunter2hunter2";\\napi_key: abcdef1234567890\\nghp_abcdefghijklmnopqrstuvwxyz0123456789\\nAKIAABCDEFGHIJKLMNOP\\n-----BEGIN RSA PRIVATE KEY-----\\nMIIabc\\n-----END RSA PRIVATE KEY-----\\nauthor: Alice\\nconst token = short;');
      console.log(JSON.stringify({ d: Object.fromEntries(paths.map((p) => [p, rr.denyReason(p)])), redact }));`);
    const denied = Object.entries(r.d).filter(([, v]) => v).map(([k]) => k), allowed = Object.entries(r.d).filter(([, v]) => !v).map(([k]) => k);
    assert.deepEqual(allowed.sort(), ['.env.example', 'README.md', 'a/../b.js', 'docs/guide.md', 'src/a.js'].sort(), `denied: ${denied}`);
    assert.equal(r.redact.count, 5); assert.doesNotMatch(r.redact.text, /hunter2hunter2|abcdef1234567890|ghp_|AKIA|MIIabc|BEGIN RSA/); assert.match(r.redact.text, /author: Alice/); assert.match(r.redact.text, /token = short/);
  });
});

describe('M13 composer helper (public/js/md-parse.js mentionAt, pure)', () => {
  it('finds the @token at the caret; emails, code fences and plain text give none', async () => {
    const { pathToFileURL } = require('node:url');
    const { mentionAt } = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'md-parse.js')).href);
    assert.deepEqual(mentionAt('hello @bil', 10), { start: 6, end: 10, query: 'bil' });
    assert.deepEqual(mentionAt('@', 1), { start: 0, end: 1, query: '' });
    assert.deepEqual(mentionAt('see (@acme/bill', 15), { start: 5, end: 15, query: 'acme/bill' });
    assert.deepEqual(mentionAt('x @svc:src/a', 12), { start: 2, end: 12, query: 'svc:src/a' });
    assert.deepEqual(mentionAt('hello @bil rest', 10), { start: 6, end: 10, query: 'bil' });
    assert.equal(mentionAt('mail me@example', 15), null, 'glued to a word = email');
    assert.equal(mentionAt('no mention here', 5), null);
    assert.equal(mentionAt('@done and more', 14), null, 'caret after a space');
    assert.equal(mentionAt('```js\n@inside', 13), null, 'inside an open fence');
  });
});

describe('M13 mentions: resolution, retrieval, safety (fake Ollama, real git repos)', () => {
  let S, repos, P1, P2, out;
  const pv = (text, o = {}) => S.post('/mentions/resolve', { text, ...o });
  const entryOf = (r, i = 0) => r.context.manifest.mentions[i];
  const setLocalPath = (serviceId, p) => { const db = new DatabaseSync(S.dbPath); try { db.exec('PRAGMA busy_timeout = 5000'); db.prepare('UPDATE services SET local_path = ? WHERE id = ?').run(p, serviceId); } finally { db.close(); } };

  before(async () => {
    S = await startServer();
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-m13-out-')); // OUTSIDE every authorized root
    fs.writeFileSync(path.join(out, 'outside-secret.txt'), 'OUTSIDE_SECRET_TOKEN\n');
    const filler = (kw, n) => Array.from({ length: n }, (_, i) => `// ${kw} line ${i}: ${'x'.repeat(60)}`).join('\n');
    const billing = path.join(S.work, 'billing-api');
    makeRepo(billing, {
      'README.md': '# Billing API\n\nIntro: invoices, taxes and payment webhooks.\n\n## Retry policy\nWebhook deliveries use exponential backoff via computeBackoffDelay, capped at five attempts.\n\n## Unrelated\nlorem ipsum dolor sit amet\n',
      'src/invoice.js': 'exports.computeInvoiceTotal = (items) => items.reduce((a, b) => a + b.price, 0);\n',
      'src/webhook.js': `// delivers webhooks\n${filler('filler', 30)}\nfunction computeBackoffDelay(attempt) {\n  return Math.min(2 ** attempt * 100, 30000);\n}\nmodule.exports = { computeBackoffDelay };\n`,
      'src/config.js': 'const dbPassword = "hunter2hunter2";\nconst github = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\nexports.region = "eu-1";\n',
      '.env': 'API_KEY=supersecretvalue123456\n', '.env.example': 'API_KEY=changeme-placeholder-123\nREGION=eu-1\n', 'config/key.pem': '-----BEGIN PRIVATE KEY-----\nMIIEvQ_PEM_BODY\n-----END PRIVATE KEY-----\n',
      'node_modules/pkg/index.js': 'function computeBackoffDelay() { return "NODE_MODULES_MARKER"; }\n', 'package-lock.json': '{"computeBackoffDelay": "LOCKFILE_MARKER"}\n',
      'big.js': `${'// computeBackoffDelay BIG_FILE_MARKER\n'.repeat(2400)}`, 'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]).toString('latin1') + 'computeBackoffDelay',
    });
    fs.symlinkSync(path.join(out, 'outside-secret.txt'), path.join(billing, 'link-secret'));
    git(billing, 'add', '-A'); git(billing, 'commit', '-q', '-m', 'add symlink');
    fs.writeFileSync(path.join(billing, '.env.local'), 'UNTRACKED_SECRET=zzzzzzzzzzzz\n');                        // untracked
    fs.appendFileSync(path.join(billing, 'src/invoice.js'), '// UNCOMMITTED_MARKER\n');                           // dirty working tree
    const web = path.join(S.work, 'web-app');
    makeRepo(web, { 'README.md': '# Web app\n\nRenders invoices for customers.\n', 'src/page.js': `${filler('sharedtoken', 120)}\nfunction renderInvoicePage() { return sharedtoken; }\n`, 'src/other.js': `${filler('sharedtoken', 120)}\n` });
    const beta = path.join(S.work, 'beta-web');
    makeRepo(beta, { 'README.md': '# Beta web\n\nSecond app named web-app in another project.\n', 'src/beta.js': `${filler('sharedtoken', 200)}\nfunction betaOnly() { return sharedtoken; }\n` });
    const small = path.join(S.work, 'tiny');
    makeRepo(small, { 'README.md': '# Tiny\n\nA very small service.\n' });
    repos = { billing, web, beta, small };
    P1 = (await S.post('/projects', { name: 'Acme', description: 'billing and web' })).project;
    P2 = (await S.post('/projects', { name: 'Beta', description: 'second' })).project;
    const add = (pid, p, name, description) => S.post(`/projects/${pid}/services/add-existing`, { path: p, name, type: 'api', check_cmd: 'true', description });
    P1.billing = (await add(P1.id, billing, 'billing-api', 'invoices and webhooks')).service;
    P1.web = (await add(P1.id, web, 'web-app', 'customer page')).service;
    P2.web = (await add(P2.id, beta, 'web-app', 'beta page')).service;
    P2.tiny = (await add(P2.id, small, 'tiny-svc', 'very small')).service;
    await S.post(`/projects/${P1.id}/context/save`, { file: 'MEMORY.md', content: '# Memory\n\n## 2026-01-01 - task #1 (billing-api)\n- Webhook retries are capped at 5 attempts (decision MEM_MARKER_RETRY).\n\n## 2026-01-02\n- Unrelated: invoices use UTC.\n' });
    await S.post(`/projects/${P1.id}/context/save`, { file: 'RULES.md', content: '# Rules\n- RULES_MARKER keep functions small\n' });
    await S.post(`/projects/${P1.id}/context/save`, { file: 'ARCHITECTURE.md', content: '# Architecture\nARCH_MARKER: billing talks to web over REST\n' });
  });
  after(async () => { await S.stop(); fs.rmSync(out, { recursive: true, force: true }); });

  it('resolution: project, service, project/service, case, slug, ambiguity, unknown, scoped by the conversation project', async () => {
    const r = await pv('@Acme and @acme/BILLING-API and @billing-api and @web-app and @Beta/web-app and @nosuch and @Acme/nosuch and @Acme:README.md');
    const by = Object.fromEntries(r.mentions.map((m) => [m.raw, m]));
    assert.equal(by['@Acme'].status, 'ok'); assert.equal(by['@Acme'].ref.kind, 'project');
    assert.equal(by['@acme/BILLING-API'].ref.service, 'billing-api');
    assert.equal(by['@billing-api'].ref.project, 'Acme');
    assert.equal(by['@web-app'].status, 'ambiguous'); assert.deepEqual(by['@web-app'].candidates.sort(), ['Acme/web-app', 'Beta/web-app']);
    assert.equal(by['@Beta/web-app'].ref.project, 'Beta');
    assert.equal(by['@nosuch'].status, 'unknown'); assert.equal(by['@Acme/nosuch'].status, 'unknown'); assert.deepEqual(by['@Acme/nosuch'].candidates.sort(), ['Acme/billing-api', 'Acme/web-app']);
    assert.equal(by['@Acme:README.md'].status, 'unknown', 'a project cannot carry a file pin');
    const conv = await S.post('/conversations', { project_id: P1.id });
    const scoped = await pv('@web-app', { conversation_id: conv.id });
    assert.equal(scoped.mentions[0].status, 'ok'); assert.equal(scoped.mentions[0].ref.project, 'Acme');
    assert.equal((await S.raw('POST', '/api/mentions/resolve', { text: '@x', conversation_id: 99999 })).status, 404);
    assert.equal((await S.raw('POST', '/api/mentions/resolve', { text: '  ' })).status, 400);
  });

  it('@service pulls managed files (RULES/ARCHITECTURE/MEMORY), the README section, a file tree and the code that matches the question', async () => {
    const r = await pv('@billing-api how does computeBackoffDelay decide the retry delay?');
    const e = entryOf(r); const txt = r.context.text;
    assert.equal(e.status, 'ok'); assert.equal(e.branch, 'main'); assert.match(e.commit, /^[0-9a-f]{8}$/);
    for (const m of ['RULES_MARKER', 'ARCH_MARKER', 'MEM_MARKER_RETRY']) assert.match(txt, new RegExp(m), `managed file part ${m}`);
    assert.match(txt, /exponential backoff via computeBackoffDelay/, 'README section ranked by keyword');
    assert.ok(!/lorem ipsum/.test(txt), 'unrelated README section left out');
    assert.match(txt, /function computeBackoffDelay\(attempt\)/); assert.match(txt, /<context source="Acme\/billing-api:src\/webhook\.js" lines="\d+-\d+"/);
    assert.match(txt, /src\/invoice\.js/, 'file tree lists committed files');
    const layers = new Set(e.included.map((i) => i.layer)); for (const l of ['managed', 'docs', 'tree', 'code']) assert.ok(layers.has(l), `layer ${l}`);
    assert.ok(e.included.every((i) => i.chars > 0 && i.source)); assert.ok(e.chars <= e.allocated && r.context.manifest.used_chars <= r.budget.context_max_chars + 400);
    assert.ok(e.redactions >= 0 && typeof r.context.manifest.redactions === 'number');
    const big = e.skipped.find((s) => /big\.js/.test(s.source)); assert.ok(big && /too large/.test(big.reason), JSON.stringify(e.skipped));
    assert.ok(!r.context.text.includes('BIG_FILE_MARKER'));
  });

  it('secrets and ignored files never reach the context; only committed content of the default branch is read', async () => {
    const r = await pv('@billing-api computeBackoffDelay config password token api key env pem lockfile node_modules secret UNCOMMITTED_MARKER UNTRACKED_SECRET');
    const txt = r.context.text;
    for (const bad of ['supersecretvalue123456', 'PRIVATE KEY', 'MIIEvQ_PEM_BODY', 'NODE_MODULES_MARKER', 'LOCKFILE_MARKER', 'UNTRACKED_SECRET', 'UNCOMMITTED_MARKER', 'OUTSIDE_SECRET_TOKEN', 'zzzzzzzzzzzz', 'BIG_FILE_MARKER']) assert.ok(!txt.includes(bad), `leaked ${bad}`);
    const e = entryOf(r);
    assert.ok(e.tree_left_out.denied >= 5 && e.tree_left_out.symlink === 1, JSON.stringify(e.tree_left_out));
    assert.ok(!/\.env\b(?!\.example)/.test(e.included.map((i) => i.source).join(' ')) && !/key\.pem|node_modules|package-lock|link-secret|logo\.png/.test(txt.replace(/\n/g, ' ').match(/<context source="[^"]*"/g).join(' ')));
    // explicit pins of forbidden files are refused WITH a reason, the chat still works
    const pins = { '.env': /secret-like file name/, 'config/key.pem': /secret-like/, 'node_modules/pkg/index.js': /ignored directory/, 'package-lock.json': /lockfile/, 'big.js': /too large/, 'logo.png': /binary/, 'link-secret': /not found.*symlink/, '../../etc/passwd': /invalid path/, '/etc/passwd': /invalid path/, 'nope.js': /not found/ };
    for (const [pin, re] of Object.entries(pins)) {
      const q = await pv(`@billing-api:${pin} what is in it?`);
      const en = entryOf(q); const sk = en.skipped.find((s) => s.layer === 'file');
      assert.ok(sk && re.test(sk.reason), `${pin}: ${JSON.stringify(sk)}`);
      assert.ok(!en.included.some((i) => i.layer === 'file'), `${pin} must not be included`);
      for (const bad of ['supersecretvalue123456', 'MIIEvQ_PEM_BODY', 'OUTSIDE_SECRET_TOKEN', 'NODE_MODULES_MARKER']) assert.ok(!q.context.text.includes(bad));
    }
    // allowed pin + redaction counted: placeholders and secret-looking values inside an allowed file
    const ok = await pv('@billing-api:src/config.js show it'); const eo = entryOf(ok);
    assert.ok(eo.included.some((i) => i.layer === 'file' && i.source.endsWith(':src/config.js')));
    assert.ok(eo.redactions >= 2 && ok.context.manifest.redactions >= 2); assert.match(ok.context.text, /eu-1/); assert.doesNotMatch(ok.context.text, /hunter2hunter2|ghp_abcdef/); assert.match(ok.context.text, /REDACTED/);
    const ex = await pv('@billing-api:.env.example what is in it?'); assert.ok(entryOf(ex).included.some((i) => i.layer === 'file')); assert.doesNotMatch(ex.context.text, /changeme-placeholder-123/);
    const dirty = await pv('@billing-api:src/invoice.js show'); assert.match(dirty.context.text, /computeInvoiceTotal/); assert.doesNotMatch(dirty.context.text, /UNCOMMITTED_MARKER/);
  });

  it('budget: several mentions share it fairly, leftovers flow to the others, a tiny window warns, more than 4 mentions are capped', async () => {
    const q = '@Acme/web-app @Beta/web-app sharedtoken sharedtoken_usage';
    const r = await pv(q, { num_ctx: 8192 });
    const [a, b] = r.context.manifest.mentions; const total = a.chars + b.chars;
    assert.ok(a.chars > 1500 && b.chars > 1500, `both get real content: ${a.chars} / ${b.chars}`);
    assert.ok(Math.abs(a.chars - b.chars) / total < 0.2, `fair split: ${a.chars} vs ${b.chars}`);
    assert.ok(r.context.manifest.used_chars <= r.budget.context_max_chars, `${r.context.manifest.used_chars} > ${r.budget.context_max_chars}`);
    assert.ok(a.allocated + b.allocated <= r.budget.context_max_chars);
    // a small target leaves its unused share to the big one
    const mixed = await pv('@Beta/tiny-svc @Beta/web-app sharedtoken', { num_ctx: 8192 });
    const [t, w] = mixed.context.manifest.mentions;
    assert.ok(t.chars < t.allocated * 0.5, 'tiny repo uses little'); assert.ok(w.allocated > mixed.budget.context_max_chars * 0.55, `leftover flows on: ${w.allocated}`); assert.ok(w.chars > t.chars * 3);
    // bigger window -> more context; tiny window -> warning + still answers
    const big = await pv('@Acme/web-app sharedtoken', { num_ctx: 32768 }), small = await pv('@Acme/web-app sharedtoken', { num_ctx: 8192 });
    assert.ok(big.context.manifest.mentions[0].chars > small.context.manifest.mentions[0].chars);
    const tiny = await pv('@Acme/web-app sharedtoken', { num_ctx: 4096 });
    assert.ok(tiny.context.warnings.some((x) => x.code === 'context_small')); assert.ok(tiny.context.manifest.used_chars <= tiny.budget.context_max_chars + 100);
    const many = await pv('@Acme/billing-api @Acme/web-app @Beta/web-app @Beta/tiny-svc @Acme @Beta');
    assert.equal(many.context.manifest.mentions.length, 4); assert.ok(many.context.warnings.some((x) => x.code === 'mention_limit'));
    // project-level parts are included once per project, not per mention
    const two = await pv('@Acme/billing-api @Acme/web-app ARCH_MARKER', { num_ctx: 16384 });
    assert.equal((two.context.text.match(/ARCH_MARKER/g) || []).length, 1, 'RULES/ARCHITECTURE once');
  });

  it('@project: managed files + the README intro of each service; unknown/ambiguous mentions are warnings, not failures', async () => {
    const r = await pv('@Acme what is in this project? @ghost @web-app');
    const e = entryOf(r); const txt = r.context.text;
    assert.equal(e.kind, 'project'); assert.match(txt, /ARCH_MARKER/); assert.match(txt, /RULES_MARKER/); assert.match(txt, /Intro: invoices, taxes and payment webhooks/); assert.match(txt, /Renders invoices for customers/);
    assert.deepEqual(r.context.manifest.unresolved.map((u) => [u.raw, u.status]), [['@ghost', 'unknown'], ['@web-app', 'ambiguous']]);
    assert.deepEqual(r.context.warnings.map((w) => w.code).sort(), ['mention_ambiguous', 'mention_unknown']);
    const none = await pv('@ghost only'); assert.equal(none.context.text, ''); assert.equal(none.context.manifest.mentions.length, 0); assert.equal(none.context.manifest.unresolved.length, 1);
    assert.equal((await pv('no mentions at all, mail me@example.com')).context, null);
  });

  it('authorized roots and symlinks: a service outside the roots, or reached through a symlink, is refused; the chat goes on without it', async () => {
    const outRepo = path.join(out, 'outside-repo'); makeRepo(outRepo, { 'README.md': '# outside\n', 'src/o.js': 'const OUTSIDE_REPO_MARKER = 1;\n' });
    const link = path.join(S.work, 'link-to-outside'); fs.symlinkSync(outRepo, link);
    const saved = { billing: P1.billing.local_path, tiny: P2.tiny.local_path };
    try {
      setLocalPath(P2.tiny.id, outRepo);
      let r = await pv('@Beta/tiny-svc OUTSIDE_REPO_MARKER what is this?'); let e = entryOf(r);
      assert.equal(e.status, 'repo_unavailable'); assert.match(e.error, /outside the authorized roots/); assert.ok(!r.context.text.includes('OUTSIDE_REPO_MARKER'));
      assert.ok(r.context.warnings.some((w) => w.code === 'repo_unavailable'));
      setLocalPath(P2.tiny.id, link);                                  // inside the root by name, outside by realpath
      r = await pv('@Beta/tiny-svc OUTSIDE_REPO_MARKER'); e = entryOf(r);
      assert.equal(e.status, 'repo_unavailable'); assert.match(e.error, /outside the authorized roots/); assert.ok(!r.context.text.includes('OUTSIDE_REPO_MARKER'));
      const sug = await S.get('/mentions/suggest?q=tiny-svc:'); assert.deepEqual(sug.items, []);
      setLocalPath(P2.tiny.id, path.join(S.work, 'missing-dir'));
      r = await pv('@Beta/tiny-svc hello'); assert.equal(entryOf(r).status, 'repo_unavailable');
    } finally { setLocalPath(P2.tiny.id, saved.tiny); }
    assert.equal(entryOf(await pv('@Beta/tiny-svc hello')).status, 'ok', 'restored');
    // an archived project (and so its services) is not resolvable at all
    const gdir = path.join(S.work, 'gamma-repo'); makeRepo(gdir, { 'README.md': '# gamma\n' });
    const G = (await S.post('/projects', { name: 'Gamma' })).project;
    await S.post(`/projects/${G.id}/services/add-existing`, { path: gdir, name: 'gsvc', type: 'api', check_cmd: 'true' });
    assert.equal((await pv('@Gamma/gsvc')).mentions[0].status, 'ok');
    await S.post(`/projects/${G.id}/archive`, {});
    assert.equal((await pv('@Gamma/gsvc')).mentions[0].status, 'unknown'); assert.equal((await pv('@Gamma')).mentions[0].status, 'unknown');
  });

  it('autocomplete: projects, services, project/ prefix, files of a service (deny list applied), limits', async () => {
    const g = (q, extra = '') => S.get(`/mentions/suggest?q=${encodeURIComponent(q)}${extra}`);
    let r = await g('acm'); assert.equal(r.items[0].kind, 'project'); assert.equal(r.items[0].insert, '@Acme');
    r = await g('billing'); assert.ok(r.items.some((i) => i.kind === 'service' && i.insert === '@Acme/billing-api'));
    r = await g(''); assert.ok(r.items.length >= 5 && r.items.length <= 12); assert.deepEqual(new Set(r.items.map((i) => i.kind)), new Set(['project', 'service']));
    r = await g('Acme/'); assert.deepEqual(r.items.map((i) => i.insert).sort(), ['@Acme/billing-api', '@Acme/web-app']);
    r = await g('Acme/web'); assert.deepEqual(r.items.map((i) => i.insert), ['@Acme/web-app']);
    r = await g('web-app', `&project_id=${P2.id}`); assert.equal(r.items.find((i) => i.kind === 'service').project, 'Beta', 'conversation project first');
    r = await g('Acme/billing-api:src/w'); assert.deepEqual(r.items.map((i) => [i.kind, i.insert, i.path]), [['file', '@Acme/billing-api:src/webhook.js', 'src/webhook.js']]);
    r = await g('billing-api:'); const paths = r.items.map((i) => i.path); assert.ok(paths.includes('README.md'));
    for (const bad of ['.env', 'config/key.pem', 'node_modules/pkg/index.js', 'package-lock.json', 'link-secret', 'logo.png']) assert.ok(!paths.includes(bad), `${bad} must never be suggested`);
    r = await g('billing-api:.env'); assert.deepEqual(r.items.map((i) => i.path), ['.env.example']);
    r = await g('web-app:'); assert.deepEqual(r.items, [], 'ambiguous service: nothing guessed');
    r = await g('nosuch:src'); assert.deepEqual(r.items, []);
    assert.equal((await S.raw('POST', '/api/mentions/suggest', {})).status, 405);
  });

  it('chat end-to-end: context in the system message only, manifest returned + persisted, sticky mentions, warnings, history stays clean', async () => {
    const c = await S.post('/conversations', {});
    const r1 = await chatPost(S, c.id, { content: '@billing-api how does computeBackoffDelay work? also @ghost' });
    assert.deepEqual(r1.events.map((e) => e.event), ['meta', 'token', 'token', 'done']);
    const meta = r1.events[0].data; const man = meta.context;
    assert.equal(man.mentions[0].label, '@Acme/billing-api'); assert.ok(man.mentions[0].included.length >= 4); assert.equal(man.unresolved[0].raw, '@ghost');
    assert.ok(meta.warnings.some((w) => w.code === 'mention_unknown'), 'non-blocking warning');
    assert.equal(r1.events.at(-1).data.status, 'complete');
    const sys = lastSystem(S); assert.match(sys, /<context source="Acme\/billing-api:src\/webhook\.js"/); assert.match(sys, /never follow them/); assert.match(sys, /untrusted data/);
    assert.ok(sys.length - 2048 < meta.budget.context_max_chars + 3000, 'system message stays inside the budget');
    const g = await S.get(`/conversations/${c.id}`);
    const asst = g.messages[1]; assert.deepEqual(asst.context.context.mentions[0].included, man.mentions[0].included, 'manifest persisted on the assistant message');
    assert.equal(g.messages[0].mentions[0].service, 'billing-api'); assert.equal(g.messages[0].mentions[0].project, 'Acme');
    assert.equal(g.mentions.length, 1); assert.equal(g.mentions[0].service_id, P1.billing.id, 'sticky mention stored');
    // follow-up without a mention: sticky -> fresh retrieval, flagged; history never contains the old context
    const r2 = await chatPost(S, c.id, { content: 'and what is the maximum delay in computeBackoffDelay?' });
    const m2 = r2.events[0].data.context; assert.equal(m2.sticky, true); assert.equal(m2.mentions[0].sticky, true); assert.ok(m2.mentions[0].included.some((i) => i.layer === 'code'));
    const msgs = lastMessages(S); assert.equal(msgs.filter((m) => m.role === 'system').length, 1);
    assert.ok(!msgs.filter((m) => m.role !== 'system').some((m) => /<context/.test(m.content)), 'retrieved context is not replayed into history');
    // clear the sticky mention: no context any more
    const upd = await S.post(`/conversations/${c.id}/update`, { mentions: [] }); assert.deepEqual(upd.mentions, []);
    const r3 = await chatPost(S, c.id, { content: 'plain question' }); assert.equal(r3.events[0].data.context, null); assert.doesNotMatch(lastSystem(S), /<context source=/);
    assert.equal((await S.post(`/conversations/${c.id}/update`, { mentions: 'x' }, { allowFail: true })).status, 400);
    // only unknown mentions: answer still comes, with the warning and an (empty) manifest
    const r4 = await chatPost(S, c.id, { content: '@ghost hello' });
    assert.equal(r4.events.at(-1).event, 'done'); assert.equal(r4.events[0].data.context.unresolved[0].raw, '@ghost'); assert.doesNotMatch(lastSystem(S), /<context source=/);
    assert.equal(r4.events[0].data.context.sticky, false);
  });

  it('read-only: the repositories (HEAD, branches, status, untracked files) are byte-for-byte unchanged by all of the above', async () => {
    const before = Object.fromEntries(Object.entries(repos).map(([k, d]) => [k, fingerprint(d)]));
    const c = await S.post('/conversations', {});
    await chatPost(S, c.id, { content: '@Acme @billing-api @Beta/web-app computeBackoffDelay sharedtoken' });
    await pv('@billing-api:src/config.js and @Acme/web-app'); await S.get('/mentions/suggest?q=billing-api:');
    for (const [k, d] of Object.entries(repos)) assert.equal(fingerprint(d), before[k], `${k} changed`);
    assert.ok(fs.existsSync(path.join(repos.billing, '.env.local')), 'untracked file untouched'); assert.match(fs.readFileSync(path.join(repos.billing, 'src/invoice.js'), 'utf8'), /UNCOMMITTED_MARKER/);
    assert.equal(git(repos.billing, 'stash', 'list').trim(), '');
    assert.equal(git(repos.billing, 'worktree', 'list').trim().split('\n').length, 1, 'no worktree created');
  });
});

describe('M13 guards: chat context code is read-only by construction', () => {
  const src = (f) => fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8');
  it('repo-reader: no fs access, no write/exec APIs, git limited to read-only sub-commands', () => {
    const s = src('repo-reader.js');
    assert.doesNotMatch(s, /require\(['"](node:)?(fs|child_process)['"]\)/);
    assert.doesNotMatch(s, /\b(writeFile|appendFile|mkdir|rmSync|unlink|rename|copyFile|createWriteStream|execFile|spawn)\b/);
    assert.match(s, /RO_GIT = new Set\(\['rev-parse', 'ls-tree', 'show', 'grep'\]\)/);
    assert.equal((s.match(/\bgit\(cwd/g) || []).length, 1, 'git is invoked from exactly one wrapper');
    const subs = [...s.matchAll(/(?:gitRO\([^,]+,|args =)\s*\[\s*'([a-z-]+)'/g)].map((m) => m[1]);
    assert.ok(subs.length === 4 && subs.every((x) => ['rev-parse', 'ls-tree', 'show', 'grep'].includes(x)), `git sub-commands used: ${subs}`);
  });
  it('mentions / chat-context / chat / chat-api never touch the filesystem or processes themselves', () => {
    for (const f of ['mentions.js', 'chat-context.js', 'chat.js', 'chat-api.js']) assert.doesNotMatch(src(f), /require\(['"](node:)?(fs|child_process)['"]\)|\bproc\b.*require|require\(['"]\.\/proc['"]\)/, f);
  });
  it('the only readers of service repository content for chat are repo-reader.js (via proc.git) and context.js (managed files)', () => {
    for (const f of fs.readdirSync(path.join(ROOT, 'lib')).filter((x) => /^(chat|mentions)/.test(x))) assert.doesNotMatch(src(f), /ls-tree|cat-file|\bgit grep\b|'show'/, f);
  });
});
