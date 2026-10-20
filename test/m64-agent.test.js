'use strict';
// Agent tool loop. A repeated error escalates with a short summary. The flag defaults off.
require('./helpers/temp-env');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tools = require('../lib/agent/tools');
const loop = require('../lib/agent/loop');
const cfg = require('../config');

describe('agent tools', () => {
  it('rejects an unknown tool and a path that leaves the worktree', () => {
    assert.equal(tools.parseCall('{"tool":"rm","args":{}}').ok, false);
    const call = tools.parseCall('{"tool":"read_file_range","args":{"path":"../secret","start":1,"end":2}}');
    assert.equal(call.ok, true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-agent-'));
    fs.writeFileSync(path.join(dir, 'a.js'), 'export function checkOut() { return 1; }\n');
    return assert.rejects(() => tools.exec(call, { root: dir }), /outside the repo/);
  });

  it('applies a patch in process and reads the symbol back', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-agent-'));
    fs.writeFileSync(path.join(dir, 'a.js'), 'export function checkOut() { return 1; }\n');
    const patched = await tools.exec({ tool: 'apply_patch', args: { file: 'a.js', search: 'return 1', replace: 'return 2' } }, { root: dir, approved: new Set(['a.js']) });
    assert.equal(patched.ok, true);
    assert.match(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), /return 2/);
    const blocked = await tools.exec({ tool: 'apply_patch', args: { file: 'b.js', content: 'no\n' } }, { root: dir, approved: new Set(['a.js']) });
    assert.equal(blocked.ok, false);
    const sym = await tools.exec({ tool: 'read_symbol', args: { path: 'a.js', name: 'checkOut' } }, { root: dir });
    assert.match(sym.note, /checkOut/);
  });

  it('escalates when the same error happens twice and stays off by default', async () => {
    assert.equal(cfg.AGENT_LOOP, false);
    const result = await loop.run({
      maxIter: 4,
      tokenBudget: 1000,
      root: os.tmpdir(),
      chat: async () => ({ content: '{"tool":"search_code","args":{}}', tokens: 1 }),
      runCheck: async () => ({ ok: true }),
    });
    assert.equal(result.escalate, true);
    assert.match(result.summary, /search query is empty/);
    assert.equal(result.summary.includes('transcript'), false);
  });
});
