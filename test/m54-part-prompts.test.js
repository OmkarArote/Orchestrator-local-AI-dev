'use strict';
// M2: each split part gets its own prompt. The full original stays on the parent.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo } = require('./helpers/harness');
const { groupFiles } = require('../lib/flow/split');
const { buildPartPrompt, appendEarlier, BUDGET } = require('../lib/flow/part-prompt');

const PROMPT = fs.readFileSync(path.join(__dirname, 'fixtures', 'task33-visit-outcome.prompt.md'), 'utf8');
const REPO = {
  'src/common/enums/role.enum.ts': 'export enum Role { ADMIN = "ADMIN", REP = "REP" }\n',
  'src/modules/visit/visit.schema.ts': 'export class Visit { outcome?: string; }\n',
  'src/modules/visit/dto/visit.dto.ts': 'import { IsOptional, IsString } from "class-validator";\nexport class CheckInDto {}\nexport class CheckOutDto { @IsOptional() @IsString() outcome?: string; }\nexport class ListVisitsQuery { userId?: string; }\n',
  'src/modules/visit/visit.service.ts': 'import { Visit } from "./visit.schema";\nimport { CheckOutDto } from "./dto/visit.dto";\nexport class VisitService { checkOut(dto: CheckOutDto) { const visit = new Visit(); if (dto.outcome) visit.outcome = dto.outcome; return visit; } list() { return []; } }\n',
  'src/app.module.ts': 'export class AppModule {}\n',
  'README.md': '# pulse-api\nvisit outcome\n',
};
const EDIT = ['src/common/enums/visit-outcome.enum.ts', 'src/modules/visit/visit.schema.ts', 'src/modules/visit/dto/visit.dto.ts', 'src/modules/visit/visit.service.ts'];
const readFile = (f) => REPO[f] || null;
const UNIQUE = 'There is no `subOutcome` anywhere';

function promptsFor(max) {
  const chunks = groupFiles(EDIT, { max, created: ['src/common/enums/visit-outcome.enum.ts'], prompt: PROMPT, readFile });
  return chunks.map((files, i) => buildPartPrompt({
    prompt: PROMPT, files, readOnly: ['src/common/enums/role.enum.ts'], index: i + 1, total: chunks.length,
    others: chunks.filter((_, j) => j !== i).flat(), readFile,
  }));
}

describe('M54 part prompts', () => {
  it('visit-fixture parts differ, stay under the budget, and omit the rest of the original', () => {
    const built = promptsFor(2);
    assert.ok(built.length >= 2, 'the fixture splits at cap 2');
    assert.notEqual(built[0].text, built[1].text);
    for (const b of built) {
      assert.ok(b.chars <= b.budget && b.chars <= BUDGET, `${b.chars} > ${b.budget}`);
      assert.ok(b.chars < PROMPT.length);
      assert.equal(b.text.includes(UNIQUE), false);
      assert.match(b.text, /^# Part \d+\/\d+:/);
      assert.match(b.text, /## Files/);
      assert.match(b.text, /## Required behavior/);
      assert.match(b.text, /role\.enum\.ts` \(style reference only, do not edit\)/);
    }
    assert.match(built[0].text, /VisitOutcome/);
    assert.match(built[1].text, /checkOut|schema/);
    const withEarlier = appendEarlier(built[1].text, 'Part 1 (#2) review; 1 file changed, 4 insertions(+)');
    assert.match(withEarlier.text, /## Earlier parts/);
    assert.match(withEarlier.text, /1 file changed, 4 insertions/);
    assert.ok(withEarlier.chars <= BUDGET);
    assert.equal(appendEarlier(withEarlier.text, 'Part 1 (#2) review; 1 file changed, 4 insertions(+)').text.match(/## Earlier parts/g).length, 1);
  });

  it('a running visit sequence keeps the original on the parent and puts the earlier diff on part 2', async () => {
    const S = await startServer({ env: { ORCH_FLOW: 'v2', ORCH_LOCAL_MAX_FILES: '2' } });
    try {
      const P = await S.addProject(makeRepo(path.join(S.work, 'm54'), REPO), 'm54', 'true');
      const parent = await S.runToReview(P.id, { title: 'visit outcome', prompt: PROMPT, engine: 'auto', allow_escalation: true }, 'failed');
      assert.equal(parent.display_status, 'split');
      assert.equal(parent.prompt.trim(), PROMPT.trim());
      const parts = (await S.get('/tasks')).filter((t) => t.group_id).sort((a, b) => a.step_no - b.step_no);
      assert.ok(parts.length >= 2);
      assert.notEqual(parts[0].prompt, parts[1].prompt);
      for (const p of parts) {
        assert.ok(p.prompt.length <= BUDGET);
        assert.equal(p.prompt.includes(UNIQUE), false);
        const ev = (await S.get(`/tasks/${p.id}/events`)).map((e) => e.message).join('\n');
        assert.match(ev, /part prompt: \d+ chars \/ budget 6000/);
      }
      const second = await S.waitStatus(parts[1].id, ['review', 'failed'], { timeout: 40000 });
      assert.equal(second.status, 'review', second.result_summary);
      assert.match(second.prompt, /## Earlier parts/);
      assert.match(second.prompt, /changed/);
      assert.equal(second.prompt.includes(UNIQUE), false);
      const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'tasks.js'), 'utf8');
      assert.match(js, /split_parent/);
    } finally { await S.stop(); }
  });
});
