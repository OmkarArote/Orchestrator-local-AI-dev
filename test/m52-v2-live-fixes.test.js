'use strict';
// M52: fixes from live tasks #33/#34 (pulse-api): cancel is terminal, Files-section detection and grouping,
// de-duplicated --read context, and a split parent shown as 'split' instead of failed.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo } = require('./helpers/harness');
const { parsePromptFiles } = require('../lib/flow/prompt-files');
const { groupFiles } = require('../lib/flow/split');

const PROMPT = fs.readFileSync(path.join(__dirname, 'fixtures', 'task33-visit-outcome.prompt.md'), 'utf8');
const REPO = {
  'src/common/enums/role.enum.ts': 'export enum Role { ADMIN = "ADMIN", REP = "REP" }\n',
  'src/modules/visit/visit.schema.ts': 'export class Visit { outcome?: string; }\n',
  'src/modules/visit/dto/visit.dto.ts': 'import { IsOptional, IsString } from "class-validator";\nexport class CheckInDto {}\nexport class CheckOutDto { @IsOptional() @IsString() outcome?: string; }\nexport class ListVisitsQuery { userId?: string; }\n',
  'src/modules/visit/visit.service.ts': 'import { Visit } from "./visit.schema";\nimport { CheckOutDto } from "./dto/visit.dto";\nexport class VisitService { checkOut(dto: CheckOutDto) { const visit = new Visit(); if (dto.outcome) visit.outcome = dto.outcome; return visit; } }\n',
  'src/app.module.ts': 'export class AppModule {}\n',
  'README.md': '# pulse-api\nvisit outcome\n',
};
const EDIT = ['src/common/enums/visit-outcome.enum.ts', 'src/modules/visit/visit.schema.ts', 'src/modules/visit/dto/visit.dto.ts', 'src/modules/visit/visit.service.ts'];
const lines = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const evText = async (S, id) => (await S.get(`/tasks/${id}/events`)).map((e) => e.message).join('\n');

describe('M52 prompt file detection (task #33 fixture)', () => {
  const exists = (f) => Object.prototype.hasOwnProperty.call(REPO, f);
  it('uses only the Files section: 4 editable files, the style reference is read-only, identifiers are ignored', () => {
    const r = parsePromptFiles(PROMPT, { exists });
    assert.deepEqual(r.edit, EDIT);
    assert.deepEqual(r.read, ['src/common/enums/role.enum.ts']);
    assert.deepEqual(r.created, ['src/common/enums/visit-outcome.enum.ts']);
    assert.equal(r.section, true);
    for (const junk of ['visit.outcome', 'dto.outcome', 'CheckOutDto.outcome', 'filter.outcome']) assert.ok(!r.edit.includes(junk) && !r.read.includes(junk), junk);
  });
  it('without a Files section only existing path-like tokens or (new) files count', () => {
    const r = parsePromptFiles('Set visit.outcome from dto.outcome in src/modules/visit/visit.service.ts\nadd src/x/new.ts (new)\nsee missing/file.ts', { exists });
    assert.deepEqual(r.edit, ['src/modules/visit/visit.service.ts', 'src/x/new.ts']);
    assert.deepEqual(r.created, ['src/x/new.ts']);
  });
  it('groups: the 4-file prompt is ONE part at cap 3 (the new enum carries no content); at cap 2 the enum stays with the DTO', () => {
    const readFile = (f) => REPO[f] || null;
    const created = ['src/common/enums/visit-outcome.enum.ts'];
    assert.deepEqual(groupFiles(EDIT, { max: 3, created, prompt: PROMPT, readFile }), [EDIT]);
    const two = groupFiles(EDIT, { max: 2, created, prompt: PROMPT, readFile });
    assert.ok(two.length <= 2, JSON.stringify(two));
    assert.ok(two.some((p) => p.includes('src/common/enums/visit-outcome.enum.ts') && p.includes('src/modules/visit/dto/visit.dto.ts')), JSON.stringify(two));
    assert.deepEqual(two.flat().sort(), [...EDIT].sort());
  });
});

describe('M52 --read context', () => {
  it('one entry per file, never the step file, read-only first, scope-limited, capped', () => {
    require('./helpers/temp-env');
    const { buildReads } = require('../lib/flow/coder');
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'm52-reads-'));
    makeRepo(dir, REPO);
    const sn = (p, start) => ({ path: p, start, end: start + 1, text: `snippet of ${p} @${start}` });
    const snippets = [...[1, 1, 3, 3, 5, 7].map((n) => sn('src/modules/visit/visit.service.ts', n)), sn('README.md', 1), sn('src/app.module.ts', 1), sn('src/modules/visit/dto/visit.dto.ts', 1)];
    const scope = [...EDIT, 'src/common/enums/role.enum.ts'];
    const r = buildReads({ rel: 'src/modules/visit/dto/visit.dto.ts', snippets, readOnly: ['src/common/enums/role.enum.ts'], root: dir, scope });
    assert.deepEqual(r.map((x) => x.path), ['src/common/enums/role.enum.ts', 'src/modules/visit/visit.service.ts']);
    assert.equal(r[1].text.split('snippet of').length - 1, 4, 'duplicate snippets merged, distinct ones kept');
    const noScope = buildReads({ rel: 'x.ts', snippets, root: dir });
    assert.ok(!noScope.some((x) => /README|app\.module/.test(x.path)), JSON.stringify(noScope.map((x) => x.path)));
    const many = buildReads({ rel: 'x.ts', snippets: Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, start: 1, text: 'y'.repeat(5000) })), root: dir });
    assert.ok(many.length <= 4 && many.reduce((n, x) => n + x.text.length, 0) <= 12000);
  });
});

describe('M52 v2 server runs', () => {
  it('the task #33 prompt runs as one task with each --read path once and the reference file read-only', async () => {
    const S = await startServer({ env: { ORCH_FLOW: 'v2' } });
    try {
      const P = await S.addProject(makeRepo(path.join(S.work, 'm52a'), REPO), 'm52a', 'true');
      const t = await S.runToReview(P.id, { title: 'visit outcome', prompt: PROMPT, engine: 'auto', allow_escalation: true }, ['review', 'failed']);
      const ev = await evText(S, t.id);
      assert.doesNotMatch(ev, /route split/);
      assert.match(ev, /files: edit \[src\/common\/enums\/visit-outcome\.enum\.ts, src\/modules\/visit\/visit\.schema\.ts, src\/modules\/visit\/dto\/visit\.dto\.ts, src\/modules\/visit\/visit\.service\.ts\] \(new: src\/common\/enums\/visit-outcome\.enum\.ts\); read-only \[src\/common\/enums\/role\.enum\.ts\]/);
      const runs = lines(path.join(S.base, 'stub-aider.log'));
      assert.ok(runs.length >= 1);
      for (const r of runs) {
        const reads = r.readFiles.map((f) => path.basename(f));
        assert.equal(new Set(reads).size, reads.length, `duplicate --read: ${reads}`);
        assert.ok(!reads.some((f) => /README|app\.module/.test(f)), reads.join(','));
        assert.ok(EDIT.some((e) => r.files.includes(e)), `edits a listed file: ${r.files}`);
      }
      assert.equal((await S.get('/tasks')).filter((x) => x.group_id).length, 0, 'no sequence created');
    } finally { await S.stop(); }
  });

  it('a split parent shows as split (not failed) in the task view, filter data and lineage', async () => {
    const S = await startServer({ env: { ORCH_FLOW: 'v2', ORCH_SPLIT_AUTORUN: '0' } });
    try {
      const files = { 'src/a/one.ts': '1\n', 'src/a/two.ts': '2\n', 'src/b/three.ts': '3\n', 'src/b/four.ts': '4\n' };
      const P = await S.addProject(makeRepo(path.join(S.work, 'm52b'), files), 'm52b', 'true');
      const prompt = 'Rename things.\n\n## Files\n\n- `src/a/one.ts`\n- `src/a/two.ts`\n- `src/b/three.ts`\n- `src/b/four.ts`\n';
      const t = await S.runToReview(P.id, { title: 'split me', prompt, engine: 'auto', allow_escalation: true }, 'failed');
      assert.match(t.result_summary, /^split into sequence/);
      assert.equal(t.display_status, 'split');
      const listed = (await S.get('/tasks')).find((x) => x.id === t.id);
      assert.equal(listed.display_status, 'split');
      const lin = await S.get(`/tasks/${t.id}/lineage`);
      assert.equal(lin.status, 'split');
      assert.equal(lin.tree.status, 'split');
      const parts = (await S.get('/tasks')).filter((x) => x.group_id);
      assert.equal(parts.length, 2);
      assert.ok(parts.every((p) => p.display_status === 'pending'));
      const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'tasks.js'), 'utf8');
      assert.match(js, /\['split', 'Split'\]/); assert.match(js, /statusBadge\(shown\(t\)\)/);
    } finally { await S.stop(); }
  });

  it('cancel is terminal: the running aider is killed and no further attempt, escalation, check or Cursor run happens', async () => {
    const S = await startServer({ env: { ORCH_FLOW: 'v2' } });
    try {
      const P = await S.addProject(makeRepo(path.join(S.work, 'm52c'), { 'a.txt': 'a\n' }), 'm52c', 'true');
      const t = await S.createTask(P.id, { title: 'slow', prompt: 'edit a.txt STUB_SLOW', files: ['a.txt'], engine: 'auto', allow_escalation: true });
      await S.post(`/tasks/${t.id}/approve-start`, {});
      const log = path.join(S.base, 'stub-aider.log');
      await S.waitFor(async () => lines(log).length >= 1, { what: 'aider started' });
      await S.post(`/tasks/${t.id}/cancel`, {});
      const done = await S.waitStatus(t.id, ['failed', 'review'], { timeout: 20000 });
      assert.equal(done.status, 'failed');
      assert.match(done.result_summary, /cancelled by user/);
      await new Promise((r) => setTimeout(r, 800));
      assert.equal(lines(log).length, 1, 'no second aider attempt after cancel');
      const ev = await evText(S, t.id);
      assert.doesNotMatch(ev.split('cancel requested by user')[1] || '', /"phase":"escalation"|check: sh -c|START mode=/);
      const agent = path.join(S.base, 'stub-agent.log');
      assert.ok(!fs.existsSync(agent) || !/mode=force/.test(fs.readFileSync(agent, 'utf8')), 'Cursor never ran');
    } finally { await S.stop(); }
  });
});
