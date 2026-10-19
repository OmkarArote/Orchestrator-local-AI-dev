'use strict';
// M5 reader: ranking, enclosing function, and the snippet budget. Git goes through lib/proc.js.
require('./helpers/temp-env');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeRepo } = require('./helpers/harness');
const { discover, enclosing } = require('../lib/flow/reader');

describe('M35 reader', () => {
  it('extracts the enclosing function, or forty lines when there is no brace block', () => {
    const lines = ['function greet() {', '  return 1;', '}'];
    const snip = enclosing(lines, 2);
    assert.equal(snip.start, 1);
    assert.equal(snip.end, 3);
    assert.match(snip.text, /function greet/);
    const flat = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const wide = enclosing(flat, 50);
    assert.ok(wide.end - wide.start <= 80);
  });

  it('ranks the file the prompt names, extracts greet, and stops at the char budget', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm35-'));
    const repo = makeRepo(path.join(dir, 'repo'), {
      'src/a.js': 'function greet() {\n  return "hello";\n}\nfunction other() {\n  return 0;\n}\n',
      'lib/b.js': 'function unused() {\n  return 2;\n}\n',
      'notes.md': 'nothing\n',
    });
    const found = await discover({ wt: repo, root: repo, prompt: 'change greet in src/a.js', budgetChars: 4000 });
    assert.equal(found.files[0].path, 'src/a.js');
    assert.ok(found.files[0].score > (found.files.find((f) => f.path === 'lib/b.js') || { score: 0 }).score);
    assert.ok(found.snippets.some((s) => s.path === 'src/a.js' && /function greet/.test(s.text)));
    assert.ok(found.symbols.some((s) => s.name === 'greet' && s.path === 'src/a.js'));
    const tight = await discover({ wt: repo, root: repo, prompt: 'change greet in src/a.js', budgetChars: 20 });
    assert.ok(tight.chars <= 20);
    assert.ok(tight.snippets.length >= 1);
    assert.ok(tight.snippets.every((s) => s.text.length <= 20));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
