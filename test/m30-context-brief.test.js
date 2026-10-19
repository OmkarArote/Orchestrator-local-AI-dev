'use strict';
// Swap-relook fix 9: an optional short BRIEF.md replaces RULES + ARCHITECTURE in the bundle, and services/<name>.brief.md replaces the
// service notes, so a long hand-written rules/architecture pair no longer fills a small local model's context. Originals stay untouched.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startServer, makeRepo } = require('./helpers/harness');

describe('M30 BRIEF.md preferred in the context bundle', () => {
  let S, P, svc;
  before(async () => {
    S = await startServer();
    P = await S.addProject(makeRepo(path.join(S.work, 'm30'), { 'a.txt': 'a\n' }), 'm30', 'true');
    svc = (await S.get(`/projects/${P.id}/services`)).find((s) => s.id === P.serviceId);
  });
  after(async () => { await S.stop(); });
  const save = (file, content) => S.post(`/projects/${P.id}/context/save`, { file, content });
  const preview = () => S.post(`/projects/${P.id}/context/preview`, { prompt: 'edit a', service_id: P.serviceId });

  it('without a brief: RULES + ARCHITECTURE + service notes as before', async () => {
    await save('RULES.md', '# Rules\n' + 'long rule line\n'.repeat(200));
    await save('ARCHITECTURE.md', '# Arch\nbig architecture text\n');
    await save(`services/${svc.name}.md`, '# Notes\nlong service notes\n');
    const b = await preview();
    assert.deepEqual(b.manifest.parts.map((p) => p.name).filter((n) => !/SERVICE MAP/.test(n)), ['RULES', 'ARCHITECTURE', `SERVICE NOTES: ${svc.name}`]);
    assert.equal(b.manifest.brief, undefined);
  });

  it('with BRIEF.md and services/<name>.brief.md: those replace RULES/ARCHITECTURE/notes; originals kept and listed', async () => {
    await save('BRIEF.md', '# Brief\nshort project brief\n');
    await save(`services/${svc.name}.brief.md`, '# Service brief\nshort service brief\n');
    const b = await preview();
    const names = b.manifest.parts.map((p) => p.name);
    assert.ok(names.includes('BRIEF') && names.includes(`SERVICE BRIEF: ${svc.name}`), names.join());
    assert.ok(!names.includes('RULES') && !names.includes('ARCHITECTURE') && !names.includes(`SERVICE NOTES: ${svc.name}`), names.join());
    assert.equal(b.manifest.brief, true);
    assert.match(b.text, /short project brief[\s\S]*short service brief/);
    assert.doesNotMatch(b.text, /long rule line|big architecture|long service notes/);
    const c = await S.get(`/projects/${P.id}/context`);
    for (const f of ['RULES.md', 'ARCHITECTURE.md', 'BRIEF.md', `services/${svc.name}.md`, `services/${svc.name}.brief.md`]) assert.ok(c.files.find((x) => x.name === f && x.exists), f);
  });

  it('an emptied brief falls back to the originals', async () => {
    await save('BRIEF.md', '');
    await save(`services/${svc.name}.brief.md`, '  \n');
    const names = (await preview()).manifest.parts.map((p) => p.name);
    assert.ok(names.includes('RULES') && names.includes(`SERVICE NOTES: ${svc.name}`), names.join());
  });
});
