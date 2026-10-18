'use strict';
// M10: the dashboard is plain ES modules served statically. Checks: every asset is served with a sane content type, every module parses,
// imports resolve to real files, and the Models UI keeps Download disabled. (Behaviour is covered by scripts/ui-smoke.sh in headless Chrome.)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startServer, ROOT } = require('./helpers/harness');

const PUB = path.join(ROOT, 'public');
const mods = ['app.js', ...fs.readdirSync(path.join(PUB, 'js')).map((f) => `js/${f}`)];

describe('M10 dashboard assets', () => {
  let S;
  before(async () => { S = await startServer(); });
  after(async () => { await S.stop(); });

  it('index, css and every module are served', async () => {
    for (const [u, type] of [['/', 'text/html'], ['/style.css', 'text/css'], ...mods.map((m) => ['/' + m, 'javascript'])]) {
      const r = await fetch(S.url + u); assert.equal(r.status, 200, u); assert.match(r.headers.get('content-type') || '', new RegExp(type), u);
    }
    assert.equal((await fetch(S.url + '/panels.js')).status, 404, 'old panels.js is gone');
    assert.equal((await fetch(S.url + '/js/../../config.js')).status === 200, false, 'no traversal out of public/');
  });
  it('every module is syntactically valid ESM and its relative imports exist', () => {
    for (const m of mods) {
      const src = fs.readFileSync(path.join(PUB, m), 'utf8');
      const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: src, encoding: 'utf8' });
      assert.equal(r.status, 0, `${m}: ${r.stderr}`);
      for (const im of src.matchAll(/from\s+'(\.[^']+)'/g)) assert.ok(fs.existsSync(path.resolve(path.dirname(path.join(PUB, m)), im[1])), `${m} imports missing ${im[1]}`);
    }
  });
  it('index.html is a module entry with the nav roots, and the UI never uses alert/confirm/prompt', () => {
    const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
    assert.match(html, /<script type="module" src="\/app\.js">/);
    for (const id of ['nav', 'main', 'toasts', 'modal-root']) assert.match(html, new RegExp(`id="${id}"`));
    for (const m of mods) assert.doesNotMatch(fs.readFileSync(path.join(PUB, m), 'utf8'), /(?<![\w.])(alert|confirm|prompt)\s*\(/, `${m} uses a native dialog`);
  });
  it('download buttons stay disabled in the Models UI (pull is off by default)', () => {
    const src = fs.readFileSync(path.join(PUB, 'js', 'models.js'), 'utf8');
    assert.match(src, /downloads disabled/);
    assert.match(src, /disabled: (true|!)/);
  });
});
// (the pull/delete endpoints themselves are asserted 403 in m9-models.test.js)
