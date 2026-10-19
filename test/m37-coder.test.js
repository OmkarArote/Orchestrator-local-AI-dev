'use strict';
// M7 coder: SEARCH must match once, a no-op is reverted, aider is pinned to --edit-format diff.
require('./helpers/temp-env');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { editDirect, editAider, applyBlocks } = require('../lib/flow/coder');

describe('M37 coder', () => {
  it('applies a SEARCH block that occurs once and refuses a block that occurs twice', () => {
    const src = 'alpha\nbeta\nalpha\n';
    assert.equal(applyBlocks(src, [{ search: 'alpha', replace: 'ALPHA' }]).ok, false);
    const once = applyBlocks('alpha\nbeta\n', [{ search: 'alpha', replace: 'ALPHA' }]);
    assert.equal(once.ok, true);
    assert.equal(once.text, 'ALPHA\nbeta\n');
    assert.equal(applyBlocks('alpha\n', [{ search: 'alpha', replace: 'alpha' }]).reason, 'no_edit');
  });

  it('writes a direct edit and leaves the file untouched when the model reply is a no-op', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm37-'));
    const abs = path.join(dir, 'a.js');
    fs.writeFileSync(abs, 'function greet() {\n  return 1;\n}\n');
    const chat = async (body) => {
      assert.equal(body.think, false);
      return { ok: true, content: '<<<<<<< SEARCH\n  return 1;\n=======\n  return 2;\n>>>>>>> REPLACE' };
    };
    const ok = await editDirect({ abs, prompt: 'return 2', model: 'ornith:9b', chat });
    assert.equal(ok.ok, true);
    assert.match(fs.readFileSync(abs, 'utf8'), /return 2/);
    const before = fs.readFileSync(abs, 'utf8');
    const noop = await editDirect({ abs, prompt: 'same', model: 'ornith:9b', chat: async () => ({ ok: true, content: 'no blocks' }) });
    assert.equal(noop.ok, false);
    assert.equal(noop.reason, 'no_edit');
    assert.equal(fs.readFileSync(abs, 'utf8'), before);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('asks aider for edit format diff and reverts when aider changes nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm37a-'));
    const wt = path.join(dir, 'repo');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, 'a.js'), 'const n = 1;\n');
    let args;
    const changed = await editAider({
      wt, rel: 'a.js', prompt: 'bump n', model: 'ornith:9b', snippets: [],
      runCmd: async (bin, a) => { args = a; fs.writeFileSync(path.join(wt, 'a.js'), 'const n = 2;\n'); return { code: 0 }; },
    });
    assert.equal(changed.ok, true);
    assert.equal(changed.format, 'diff');
    assert.ok(args.includes('--edit-format'));
    assert.equal(args[args.indexOf('--edit-format') + 1], 'diff');
    assert.ok(args.includes('--no-auto-commits'));
    const same = await editAider({
      wt, rel: 'a.js', prompt: 'bump n', model: 'ornith:9b',
      runCmd: async () => ({ code: 0 }),
    });
    assert.equal(same.reason, 'no_edit');
    assert.equal(fs.readFileSync(path.join(wt, 'a.js'), 'utf8'), 'const n = 2;\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
