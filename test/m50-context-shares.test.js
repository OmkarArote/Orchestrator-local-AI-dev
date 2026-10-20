'use strict';
// M50: bundle section shares sum to <= 1, and RULES/ARCHITECTURE/MEMORY .brief.md files replace the originals while they are current.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo } = require('./helpers/harness');

describe('M50 context shares and per-file briefs', () => {
  let S, P, ctxDir;
  before(async () => {
    S = await startServer();
    P = await S.addProject(makeRepo(path.join(S.work, 'm50c'), { 'a.txt': 'a\n' }), 'm50c', 'true');
  });
  after(async () => { await S.stop(); });
  const save = (file, content) => S.post(`/projects/${P.id}/context/save`, { file, content });
  const preview = () => S.post(`/projects/${P.id}/context/preview`, { prompt: 'edit a', service_id: P.serviceId });

  it('the fixed shares (one project part set, map, service part, extra) sum to at most 1', () => {
    require('./helpers/temp-env');
    const { SHARES } = require('../lib/context');
    const worst = Math.max(SHARES.BRIEF, SHARES.RULES + SHARES.ARCHITECTURE) + SHARES.SERVICE_MAP + Math.max(SHARES.SERVICE_BRIEF, SHARES.SERVICE_NOTES) + SHARES.EXTRA;
    assert.ok(worst <= 1, `shares sum to ${worst}`);
  });

  it('RULES.brief.md / ARCHITECTURE.brief.md / MEMORY.brief.md are used instead of the originals, which stay untouched', async () => {
    await save('RULES.md', '# Rules\n' + 'long rule line\n'.repeat(400));
    await save('ARCHITECTURE.md', '# Arch\n' + 'long arch\n'.repeat(400));
    await save('MEMORY.md', '# Memory\n- old entry about a.txt\n');
    await new Promise((r) => setTimeout(r, 20));
    await save('RULES.brief.md', '# Rules (brief)\n- short rule\n');
    await save('ARCHITECTURE.brief.md', '# Arch (brief)\n- short arch\n');
    await save('MEMORY.brief.md', '# Memory (brief)\n- merged entry about a.txt\n');
    const b = await preview();
    const src = Object.fromEntries(b.manifest.parts.map((p) => [p.name, p.source]));
    assert.match(src.RULES, /RULES\.brief\.md/); assert.match(src.ARCHITECTURE, /ARCHITECTURE\.brief\.md/); assert.match(src.MEMORY, /MEMORY\.brief\.md/);
    assert.ok(b.manifest.parts.every((p) => !p.truncated), JSON.stringify(b.manifest.parts));
    assert.match(b.text, /short rule/); assert.doesNotMatch(b.text, /long rule line/);
  });

  it('an original edited after its brief wins again (a stale brief is not used)', async () => {
    await new Promise((r) => setTimeout(r, 20));
    await save('MEMORY.md', '# Memory\n- newer entry about a.txt\n');
    const b = await preview();
    const mem = b.manifest.parts.find((p) => p.name === 'MEMORY');
    assert.equal(mem.source, '.ai/MEMORY.md');
  });
});
