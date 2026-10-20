'use strict';
// M4: the reader ranks the project index. A Files section wins. Snippets stay inside the char budget.
require('./helpers/temp-env');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo } = require('./helpers/harness');
const { rankIndex } = require('../lib/flow/rank');
const { discover } = require('../lib/flow/reader');

const PROMPT = fs.readFileSync(path.join(__dirname, 'fixtures', 'task33-visit-outcome.prompt.md'), 'utf8');
const NO_FILES = PROMPT.replace(/^## Files[\s\S]*$/m, '').trim() + '\n';
const ENUM = 'src/common/enums/visit-outcome.enum.ts';
const SCHEMA = 'src/modules/visit/visit.schema.ts';
const DTO = 'src/modules/visit/dto/visit.dto.ts';
const SERVICE = 'src/modules/visit/visit.service.ts';
const ROLE = 'src/common/enums/role.enum.ts';

const VISIT = {
  files: [
    { path: ROLE }, { path: SCHEMA }, { path: DTO }, { path: SERVICE },
    { path: 'src/constants/book.js' }, { path: 'src/validationSchemas/book.schema.js' },
    { path: 'src/services/book.service.js' }, { path: 'src/services/bookCatalogue.service.js' },
    { path: 'src/utils/book.util.js' },
  ],
  symbols: [
    { path: ROLE, name: 'Role', kind: 'enum', line: 1 },
    { path: SCHEMA, name: 'Visit', kind: 'schema', line: 1 },
    { path: DTO, name: 'CheckOutDto', kind: 'dto', line: 1 },
    { path: DTO, name: 'ListVisitsQuery', kind: 'dto', line: 4 },
    { path: SERVICE, name: 'VisitService', kind: 'service', line: 1 },
    { path: SERVICE, name: 'checkOut', kind: 'function', line: 3 },
    { path: 'src/constants/book.js', name: 'BOOK_GENRE', kind: 'const', line: 1 },
    { path: 'src/validationSchemas/book.schema.js', name: 'bookSchema', kind: 'const', line: 1 },
    { path: 'src/services/book.service.js', name: 'editBook', kind: 'function', line: 1 },
    { path: 'src/services/bookCatalogue.service.js', name: 'genreCounts', kind: 'function', line: 1 },
    { path: 'src/utils/book.util.js', name: 'resolveBookGenreWrite', kind: 'function', line: 1 },
  ],
  edges: [
    { from: SERVICE, to: SCHEMA }, { from: SERVICE, to: DTO }, { from: DTO, to: ROLE },
    { from: 'src/services/book.service.js', to: 'src/constants/book.js' },
  ],
  modules: [
    { path: 'src/modules/visit', summary: 'visit check-out and visit schema' },
    { path: 'src/services', summary: 'book edit and catalogue genre counts' },
    { path: 'src/constants', summary: 'book genre constants' },
    { path: 'src/validationSchemas', summary: 'book write schema' },
    { path: 'src/utils', summary: 'book genre write helper' },
  ],
};

const paths = (r) => r.files.map((f) => f.path);

describe('index rank', () => {
  it('the visit prompt without a Files section selects the visit files and a new enum', () => {
    const r = rankIndex({ ...VISIT, prompt: NO_FILES });
    for (const p of [SCHEMA, DTO, SERVICE, ENUM]) assert.ok(paths(r).includes(p), p);
    assert.equal(paths(r).some((p) => /book|catalogue/i.test(p)), false);
    assert.ok(r.created.includes(ENUM));
    assert.equal(r.files.find((f) => f.path === ENUM).created, true);
    assert.ok(r.chars === undefined || r.tokenEstimate === undefined);
  });

  it('a book prompt selects book files and leaves visit alone', () => {
    const r = rankIndex({ ...VISIT, prompt: 'Add a custom book genre OTHER with subGenre on book edit, and filter the catalogue by genre.\n' });
    assert.ok(paths(r).length >= 3);
    assert.ok(paths(r).every((p) => /book|catalogue/i.test(p)), paths(r).join(', '));
    assert.ok(paths(r).includes('src/services/book.service.js'));
    assert.ok(paths(r).includes('src/validationSchemas/book.schema.js'));
  });

  it('an explicit Files section wins over the index', () => {
    const r = rankIndex({ ...VISIT, prompt: PROMPT });
    assert.equal(r.source, 'files-section');
    assert.deepEqual(paths(r), [ENUM, SCHEMA, DTO, SERVICE]);
    assert.ok(r.readOnly.includes(ROLE));
  });

  it('snippets from the index stay inside the char budget', async () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'm56-'));
    const repo = makeRepo(path.join(dir, 'repo'), {
      [ROLE]: 'export enum Role { ADMIN = "ADMIN" }\n',
      [SCHEMA]: 'export class Visit {\n  outcome?: string;\n}\n',
      [DTO]: 'export class CheckOutDto { outcome?: string; }\nexport class ListVisitsQuery { userId?: string; }\n',
      [SERVICE]: 'export class VisitService {\n  checkOut() { return 1; }\n}\n',
    });
    const found = await discover({ wt: repo, root: repo, prompt: NO_FILES, budgetChars: 80, index: { ...VISIT, built: true } });
    assert.ok(found.chars <= 80);
    assert.ok(found.tokenEstimate <= Math.ceil(80 / 4));
    assert.equal(found.snippets.every((s) => s.text.length <= 80), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('index reader on a v2 task', () => {
  let S;
  before(async () => { S = await startServer({ env: { ORCH_FLOW: 'v2', ORCH_LOCAL_MAX_FILES: '3' } }); });
  after(async () => { await S.stop(); });

  it('one approval of a visit prompt with no file list plans those files', async () => {
    const repo = makeRepo(path.join(S.work, 'm56'), {
      [ROLE]: 'export enum Role { ADMIN = "ADMIN" }\n',
      [SCHEMA]: 'export class Visit { outcome?: string; }\n',
      [DTO]: 'export class CheckOutDto { outcome?: string; }\nexport class ListVisitsQuery { userId?: string; }\n',
      [SERVICE]: 'import { Visit } from "./visit.schema";\nexport class VisitService {\n  checkOut() { return new Visit(); }\n}\n',
      'src/constants/book.js': 'export const BOOK_GENRE = "OTHER";\n',
      'src/services/book.service.js': 'export function editBook() { return 1; }\n',
    });
    const { id } = await S.addProject(repo, 'm56', 'true');
    const created = await S.createTask(id, { title: 'visit outcome', prompt: NO_FILES, engine: 'auto', allow_escalation: true });
    await S.post(`/tasks/${created.id}/approve-start`, {});
    const events = await S.waitFor(async () => {
      const ev = await S.get(`/tasks/${created.id}/events`);
      return ev.some((e) => /reader:/.test(e.message)) ? ev : null;
    }, { timeout: 20000, what: 'reader event' });
    const ev = events.map((e) => e.message).join('\n');
    assert.match(ev, /reader: \d+ file\(s\) from the index/);
    assert.match(ev, /visit\.dto\.ts/);
    assert.match(ev, /visit\.schema\.ts/);
    assert.match(ev, /visit\.service\.ts/);
    assert.match(ev, /visit-outcome\.enum\.ts/);
    assert.equal(/book\.service/.test(ev.split('files: edit')[1] || ''), false);
    const coder = fs.readFileSync(path.join(__dirname, '..', 'lib', 'flow', 'coder.js'), 'utf8');
    assert.match(coder, /'--map-tokens', '0'/);
  });
});
