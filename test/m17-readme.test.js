'use strict';
// README accuracy guard: every env var / file / npm script the README names exists, and every user-facing env var of the code is documented.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const README = read('README.md');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', '.git', 'data', 'docs', 'test'].includes(e.name)) walk(rel, out); } else out.push(rel);
  }
  return out;
}
const SRC = ['config.js', 'server.js', 'setup.sh', 'start.sh', 'stop.sh', ...walk('lib'), ...walk('scripts')].filter((f) => /\.(js|sh)$/.test(f));
const envIn = (text) => new Set(text.match(/\b(?:ORCH_[A-Z0-9]+(?:_[A-Z0-9]+)*|OLLAMA_API_BASE)\b/g) || []);
const codeEnv = new Set(SRC.flatMap((f) => [...envIn(read(f))]));
const TEST_ONLY = (v) => /^ORCH_TEST_(?!ALLOW_FILE)/.test(v) || v === 'ORCH_SMOKE_PROFILE'; // injectors for the suite / the UI smoke script: deliberately undocumented

describe('README accuracy', () => {
  it('every environment variable named in the README exists in the code', () => {
    const missing = [...envIn(README)].filter((v) => !codeEnv.has(v));
    assert.deepEqual(missing, []);
  });
  it('every user-facing environment variable of the code is documented in the README', () => {
    const missing = [...codeEnv].filter((v) => !TEST_ONLY(v) && !envIn(README).has(v));
    assert.deepEqual(missing, []);
    for (const v of ['ORCH_CHAT_NUM_CTX', 'ORCH_ALLOW_DEFAULT_DB', 'ORCH_ALLOW_MODEL_PULL']) assert.ok(envIn(README).has(v) && codeEnv.has(v), v);
  });
  it('files, scripts and npm commands named in the README exist', () => {
    const paths = new Set([...README.matchAll(/`((?:lib|public|scripts|test|docs|\.cursor|\.github)\/[A-Za-z0-9_.\-/]*[A-Za-z0-9_])`/g)].map((m) => m[1]));
    for (const m of README.matchAll(/\b((?:\.\/)?(?:setup|start|stop)\.sh)\b/g)) paths.add(m[1].replace(/^\.\//, ''));
    const missing = [...paths].filter((p) => !/[*<>{}]/.test(p) && !fs.existsSync(path.join(ROOT, p)));
    assert.deepEqual(missing, []);
    const scripts = JSON.parse(read('package.json')).scripts;
    for (const m of README.matchAll(/\bnpm (?:run )?(test|doctor|start|setup|test:m0)\b/g)) assert.ok(scripts[m[1]], `npm ${m[1]}`);
  });
  it('the README states the real minimum Node version and that there are no npm dependencies', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.engines.node, '>=22.5'); assert.match(README, /Node\.js >= 22\.5/);
    assert.equal(Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length, 0);
    assert.match(README, /Zero npm dependencies/);
  });
});
