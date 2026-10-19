'use strict';
// M15: nothing may open (and auto-migrate) the REAL data/orchestrator.db except `node server.js`. A one-off `node -e "require('./lib/db')"` once did
// exactly that. config.js now hands out the default DB path only to the server entry; every other process needs an explicit ORCH_DB.
// None of these tests can touch the real DB: the pure function opens nothing, and the integration runs against a throw-away COPY of the code.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { ROOT } = require('./helpers/harness');

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const run = (cwd, args, env) => new Promise((resolve) => execFile(process.execPath, ['--no-warnings', ...args], { cwd, encoding: 'utf8', env }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
const cleanEnv = (extra = {}) => { const e = { ...process.env, ...extra }; for (const k of ['ORCH_DB', 'NODE_TEST_CONTEXT', 'NODE_ENV', 'ORCH_ALLOW_DEFAULT_DB']) if (!(k in extra)) delete e[k]; return e; };

describe('M15 default-DB guard', () => {
  it('resolveDbPath: explicit ORCH_DB wins; the default is only for server.js (or an explicit opt-in); never under test', async () => {
    const d = tmp('orch-m15-');
    try {
      const r = await run(ROOT, ['-e', `const c = require('./config'); const S = ${JSON.stringify(path.join(ROOT, 'server.js'))};
        const t = (e, m) => { try { return c.resolveDbPath(e, m); } catch (x) { return 'ERR: ' + x.message; } };
        console.log(JSON.stringify({ explicit: t({ ORCH_DB: '/tmp/x.db' }, '/elsewhere.js'), explicitUnderTest: t({ ORCH_DB: '/tmp/x.db', NODE_TEST_CONTEXT: '1' }, '/e.js'),
          other: t({}, '/elsewhere/script.js'), eval: t({}, undefined), server: t({}, S), underTest: t({ NODE_TEST_CONTEXT: 'child-v8' }, S), nodeEnv: t({ NODE_ENV: 'test' }, S),
          optIn: t({ ORCH_ALLOW_DEFAULT_DB: '1' }, '/elsewhere.js'), optInUnderTest: t({ ORCH_ALLOW_DEFAULT_DB: '1', NODE_TEST_CONTEXT: '1' }, S) }));`],
      cleanEnv({ ORCH_DB: path.join(d, 'o.db'), ORCH_LOG_DIR: path.join(d, 'l'), ORCH_WORKTREES: path.join(d, 'w'), NODE_TEST_CONTEXT: '1' }));
      assert.equal(r.code, 0, r.stderr); const x = JSON.parse(r.stdout.trim().split('\n').pop()); const real = path.join(ROOT, 'data', 'orchestrator.db');
      assert.equal(x.explicit, '/tmp/x.db'); assert.equal(x.explicitUnderTest, '/tmp/x.db');
      assert.match(x.other, /^ERR: refusing to open the real orchestrator DB/); assert.match(x.eval, /^ERR: refusing/);
      assert.equal(x.server, real); assert.match(x.underTest, /^ERR: refusing .*node:test/); assert.match(x.nodeEnv, /^ERR: refusing .*NODE_ENV=test/);
      assert.equal(x.optIn, real); assert.match(x.optInUnderTest, /^ERR: refusing/, 'the opt-in can never override the test guard');
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  it('integration on a throw-away COPY of the code: ad-hoc require of lib/db is refused and creates nothing; the server entry still opens its DB', async () => {
    const app = tmp('orch-m15-app-'), scratch = tmp('orch-m15-s-');
    try {
      fs.cpSync(path.join(ROOT, 'lib'), path.join(app, 'lib'), { recursive: true }); fs.copyFileSync(path.join(ROOT, 'config.js'), path.join(app, 'config.js')); fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(app, 'package.json'));
      fs.writeFileSync(path.join(app, 'server.js'), "const s = require('./lib/db'); console.log(JSON.stringify({ opened: true, v: s.schemaVersion() }));\n");
      const env = (extra) => cleanEnv({ ORCH_LOG_DIR: path.join(scratch, 'logs'), ORCH_WORKTREES: path.join(scratch, 'wt'), ...extra });
      const adhoc = await run(app, ['-e', "require('./lib/db'); console.log('OPENED')"], env()); assert.notEqual(adhoc.code, 0); assert.match(adhoc.stderr, /refusing to open the real orchestrator DB/); assert.ok(!adhoc.stdout.includes('OPENED'));
      const script = fs.writeFileSync(path.join(app, 'script.js'), "require('./lib/db'); console.log('OPENED')\n"); void script;
      const viaScript = await run(app, ['script.js'], env()); assert.notEqual(viaScript.code, 0); assert.match(viaScript.stderr, /refusing/);
      assert.ok(!fs.existsSync(path.join(app, 'data')), 'no data dir was created by the refused attempts');
      const underTest = await run(app, ['server.js'], env({ NODE_TEST_CONTEXT: '1' })); assert.notEqual(underTest.code, 0); assert.match(underTest.stderr, /node:test/);
      const nodeEnv = await run(app, ['server.js'], env({ NODE_ENV: 'test' })); assert.notEqual(nodeEnv.code, 0); assert.match(nodeEnv.stderr, /NODE_ENV=test/);
      assert.ok(!fs.existsSync(path.join(app, 'data')));
      const server = await run(app, ['server.js'], env()); assert.equal(server.code, 0, server.stderr); assert.equal(JSON.parse(server.stdout.trim().split('\n').pop()).opened, true);
      assert.ok(fs.existsSync(path.join(app, 'data', 'orchestrator.db')), 'the server entry gets <code dir>/data/orchestrator.db (of the COPY here)');
      const explicit = await run(app, ['script.js'], env({ ORCH_DB: path.join(scratch, 'x.db') })); assert.equal(explicit.code, 0, explicit.stderr); assert.ok(fs.existsSync(path.join(scratch, 'x.db')));
    } finally { fs.rmSync(app, { recursive: true, force: true }); fs.rmSync(scratch, { recursive: true, force: true }); }
  });

  it('static: one DB open in the whole code base (lib/db.js via cfg.DB_PATH) and the real file name appears only in config.js', () => {
    const files = [];
    const walk = (d) => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) { if (!['node_modules', 'data', '.git', 'test', 'docs'].includes(n.name) && !n.name.startsWith('data.backup')) walk(p); } else if (n.name.endsWith('.js') || n.name.endsWith('.sh')) files.push(p); } };
    walk(ROOT);
    const opens = files.filter((f) => /new DatabaseSync\(/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
    assert.deepEqual(opens, ['lib/db.js']); assert.match(fs.readFileSync(path.join(ROOT, 'lib/db.js'), 'utf8'), /new DatabaseSync\(cfg\.DB_PATH\)/);
    const named = files.filter((f) => /orchestrator\.db/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f)).filter((f) => !['config.js', 'setup.sh', 'start.sh', 'stop.sh'].includes(f));
    assert.deepEqual(named, [], 'no other module hard-codes the live DB file');
    // tests may open DBs only on their own temp paths: every test that spawns code against lib/db sets ORCH_DB explicitly
    const tests = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => [f, fs.readFileSync(path.join(ROOT, 'test', f), 'utf8')]);
    for (const [f, src] of tests) if (/require\('\.\/lib\/db'\)|require\('\.\.\/lib\/db'\)|lib\/(db|context|repo|projects|chat)['"]\)/.test(src) && f !== 'm15-db-guard.test.js') assert.ok(/ORCH_DB|temp-env/.test(src), `${f} touches lib/db but never sets ORCH_DB`);
    const orc = fs.readFileSync(path.join(ROOT, 'bin/orc.js'), 'utf8');
    assert.doesNotMatch(orc, /lib\/db|DatabaseSync|orchestrator\.db/);
  });
});
