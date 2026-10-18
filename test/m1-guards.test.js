'use strict';
// Grep-guard tests: the security properties of the design are enforced by scanning the source tree.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
function walk(dir, out = []) {
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'data', 'test', '.git', 'docs'].includes(n.name) || n.name.startsWith('data.backup')) continue;
    const p = path.join(dir, n.name);
    if (n.isDirectory()) walk(p, out); else if (/\.js$/.test(n.name) && !p.includes(path.sep + 'public' + path.sep)) out.push(p);
  }
  return out;
}
const FILES = walk(ROOT).map((f) => ({ rel: path.relative(ROOT, f), src: fs.readFileSync(f, 'utf8') }));
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const hits = (re, allow = []) => FILES.filter((f) => !allow.includes(f.rel)).flatMap((f) => stripComments(f.src).split('\n').map((l, i) => ({ f: f.rel, n: i + 1, l })).filter((x) => re.test(x.l)).map((x) => `${x.f}:${x.n}: ${x.l.trim().slice(0, 120)}`));

describe('M1 grep guards', () => {
  it('no shell string execution APIs (exec/execSync/spawnSync with shell, shell:true) anywhere', () => {
    assert.deepEqual(hits(/\bexecSync\s*\(|\bchild_process['"]\)\.exec\b|[^.\w]exec\(\s*[`'"]|shell:\s*true|\bspawnSync\s*\(/), []);
  });
  it('raw git execution only inside proc.js / safegit.js', () => {
    assert.deepEqual(hits(/(execFile|spawn|run)\(\s*['"]git['"]/, ['lib/proc.js', 'lib/safegit.js']), []);
  });
  it("'sh -c' only for the user-configured check/install commands in runner.js (and the Cursor/osascript opener)", () => {
    assert.deepEqual(hits(/['"]\/bin\/(ba)?sh['"]|['"]sh['"]\s*,\s*\[\s*['"]-c/, ['lib/runner.js']), []);
  });
  it('recursive deletes only in fsguard.removeOwnedDir (and the test-free runtime has no rm -rf elsewhere)', () => {
    assert.deepEqual(hits(/\brmSync\s*\(|\brmdirSync\s*\(|\bfs\.rm\s*\(|\brimraf\b|\bunlinkSync\s*\(/, ['lib/fsguard.js']), []);
  });
  it('no fetch to the Ollama port outside lib/ollama.js (added in M2)', () => {
    if (!fs.existsSync(path.join(ROOT, 'lib', 'ollama.js'))) return; // adapter does not exist yet
    assert.deepEqual(hits(/11434|\/api\/(chat|tags|show|pull|ps|delete)|\/v1\/chat\/completions/, ['lib/ollama.js', 'config.js']), []);
  });
  it('M1: the Cursor CLI (CURSOR_BIN / agent spawning) is only referenced by config.js, lib/runner.js, lib/cursor.js, lib/open.js', () => {
    assert.deepEqual(hits(/CURSOR_BIN/, ['config.js', 'lib/runner.js', 'lib/cursor.js', 'lib/open.js']), []);
    // ...and only runner.js (headless runs) and cursor.js (status/--version/--list-models: no usage) may SPAWN it; open.js only builds command text for osascript
    assert.deepEqual(hits(/(execFile|spawn|run)\(\s*cfg\.CURSOR_BIN/, ['lib/runner.js', 'lib/cursor.js']), []);
    const byFile = (rel) => FILES.find((f) => f.rel === rel);
    assert.ok(byFile('lib/runner.js') && byFile('lib/cursor.js') && byFile('lib/open.js'), 'guarded files exist');
    const runner = stripComments(byFile('lib/runner.js').src);
    assert.equal((runner.match(/run\(\s*cfg\.CURSOR_BIN/g) || []).length, 1, 'exactly one Cursor spawn in runner.js');
    const spawnAt = runner.indexOf('run(cfg.CURSOR_BIN'), fnAt = runner.indexOf('async function runCursor(');
    assert.ok(fnAt > 0 && spawnAt > fnAt && !/\nasync function |\nfunction /.test(runner.slice(fnAt + 10, spawnAt)), 'the spawn lives inside runCursor()');
    // cursor.js may only run the no-usage subcommands
    const cur = stripComments(byFile('lib/cursor.js').src);
    const calls = [...cur.matchAll(/\bexec\(\s*\[\s*'([^']+)'/g)].map((m) => m[1]);
    assert.ok(calls.length >= 3, 'cursor.js exec() calls found');
    for (const c of calls) assert.ok(['status', '--version', '--list-models'].includes(c), `cursor.js runs the agent with '${c}'`);
    // runCursor is never called from anywhere but runner.js, and only for the three approved run kinds
    assert.deepEqual(hits(/\brunCursor\s*\(/, ['lib/runner.js']), []);
    const kinds = [...runner.matchAll(/runCursor\(ctx,\s*\{\s*kind:\s*'(\w+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(kinds, ['plan', 'review', 'task'], 'runCursor call sites (each sits behind an approval gate: approve-start / approve-plan / approve-escalation)');
    // usage is recorded by the runner (headless runs) and by the server for opened terminal sessions only
    assert.deepEqual(hits(/\brecordCursorUse\s*\(/, ['lib/db.js', 'lib/runner.js', 'server.js']), []);
  });
  it('M1: the removed Cursor daily caps never come back (no cap config / remaining checks)', () => {
    assert.deepEqual(hits(/CURSOR_DAILY_CAP|CURSOR_REVIEW_DAILY_CAP|cursorRemaining|cursor_daily_cap|review_remaining/, ['config.js']), []);
  });
  it('git is never invoked with a URL/path without `--` separator in clone code', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'safegit.js'), 'utf8');
    for (const m of src.matchAll(/\['(ls-remote|clone)'[^\]]*\]/g)) assert.match(m[0], /'--'/, m[0]);
  });
  it('M4: nothing reads project.path / project.default_branch (legacy columns; the repo lives on the service)', () => {
    assert.deepEqual(hits(/\bproject\.(path|default_branch)\b|\bp\.(path|default_branch)\b/, ['lib/db.js']), []);
  });
  it('M4: git cwd never comes from a project; repo ops resolve through lib/repo.js', () => {
    assert.deepEqual(hits(/git\(\s*project\./), []);
  });
  it('M4: config.js refuses the real data/log/worktree defaults under node:test', () => {
    assert.match(fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8'), /NODE_TEST_CONTEXT/);
  });
});
