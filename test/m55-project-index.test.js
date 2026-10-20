'use strict';
// M3: per-service project index (schema v8). Structural scan of the default branch, incremental refresh, search.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');
const { startServer, makeRepo, git, ROOT } = require('./helpers/harness');
const { compileIgnore, isIgnored } = require('../lib/index/ignore');
const { extractSymbols, extractImports, resolveImport, detectFramework } = require('../lib/index/extract');

const ENUM = 'src/common/enums/visit-outcome.enum.ts';
const SCHEMA = 'src/modules/visit/visit.schema.ts';
const DTO = 'src/modules/visit/dto/visit.dto.ts';
const SERVICE = 'src/modules/visit/visit.service.ts';
const CONTROLLER = 'src/modules/visit/visit.controller.ts';

const REPO = {
  '.gitignore': '*.log\nnode_modules/\n',
  '.aiderignore': 'src/skip-me.ts\n',
  'README.md': '# pulse\n',
  'package.json': JSON.stringify({ dependencies: { '@nestjs/common': '10.0.0', '@nestjs/core': '10.0.0' }, scripts: { build: 'nest build' } }) + '\n',
  'package-lock.json': '{}\n',
  'notes.log': 'noise\n',
  'src/skip-me.ts': 'export const SkipMe = 1;\n',
  [ENUM]: 'export enum VisitOutcome { ORDER_PLACED = "ORDER_PLACED", OTHER = "OTHER" }\n',
  [SCHEMA]: 'export class Visit {\n  outcome?: string;\n  subOutcome?: string;\n}\n',
  [DTO]: 'import { VisitOutcome } from "../../../common/enums/visit-outcome.enum";\nexport class CheckOutDto { outcome?: VisitOutcome; }\nexport class ListVisitsQuery { userId?: string; }\n',
  [SERVICE]: 'import { Visit } from "./visit.schema";\nimport { CheckOutDto } from "./dto/visit.dto";\nexport class VisitService {\n  checkOut(dto: CheckOutDto) {\n    const visit = new Visit();\n    return visit;\n  }\n  list() {\n    return [];\n  }\n}\n',
  [CONTROLLER]: 'import { VisitService } from "./visit.service";\n@Controller("visits")\nexport class VisitController {\n  constructor(private svc: VisitService) {}\n  @Post("check-out")\n  checkOut() {}\n  @Get()\n  list() {}\n}\n',
};

function names(view, file) {
  return view.symbols.filter((s) => s.path === file).map((s) => `${s.kind}:${s.name}`);
}

describe('index extract and ignore', () => {
  it('ignores gitignore and aiderignore names, and a negation wins', () => {
    const rules = compileIgnore('*.log\nsrc/skip-me.ts\nnode_modules/\n!src/keep.log\n');
    assert.equal(isIgnored('notes.log', rules), true);
    assert.equal(isIgnored('src/a.log', rules), true);
    assert.equal(isIgnored('src/keep.log', rules), false);
    assert.equal(isIgnored('src/skip-me.ts', rules), true);
    assert.equal(isIgnored('src/modules/visit/visit.schema.ts', rules), false);
    assert.equal(isIgnored('node_modules/pkg/index.js', rules), true);
  });

  it('reads Nest symbols, routes and relative imports', () => {
    const symbols = extractSymbols(REPO[CONTROLLER], CONTROLLER);
    assert.ok(symbols.some((s) => s.kind === 'controller' && s.name === 'VisitController'));
    assert.ok(symbols.some((s) => s.kind === 'route' && s.name === 'POST visits/check-out'));
    assert.ok(symbols.some((s) => s.kind === 'route' && s.name === 'GET visits'));
    assert.deepEqual(extractImports(REPO[SERVICE]), ['./visit.schema', './dto/visit.dto']);
    const paths = new Set(Object.keys(REPO));
    assert.equal(resolveImport(SERVICE, './visit.schema', paths), SCHEMA);
    assert.equal(resolveImport(DTO, '../../../common/enums/visit-outcome.enum', paths), ENUM);
    assert.equal(detectFramework(JSON.parse(REPO['package.json'])).framework, 'nestjs');
  });
});

describe('index build', () => {
  let dir, repoDir, store, build, repo, project, service;
  const calls = [];
  before(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-idx-')));
    process.env.ORCH_DB = path.join(dir, 't.db');
    process.env.ORCH_LOG_DIR = path.join(dir, 'logs');
    process.env.ORCH_WORKTREES = path.join(dir, 'wt');
    process.env.ORCH_CONTEXT_DIR = path.join(dir, 'ctx');
    delete process.env.ORCH_ALLOW_DEFAULT_DB;
    store = require('../lib/db');
    build = require('../lib/index/build');
    repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-idx-repo-')));
    repo = makeRepo(path.join(repoDir, 'api'), REPO);
    store.addRoot(repoDir, 'idx');
    const made = store.createProjectWithService(
      { name: 'pulse', slug: 'pulse', description: '', path: '', default_branch: '' },
      { name: 'api', path: '.', local_path: repo, default_branch: 'main', status: 'active', origin: 'existing' },
    );
    project = store.getProject(made.projectId);
    service = store.getService(made.serviceId);
  });
  after(() => { for (const d of [dir, repoDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } } });

  const summarize = async ({ modulePath }) => { calls.push(modulePath); return { text: `about ${modulePath}`, model: 'fake' }; };

  it('indexes the nest fixture and skips ignored files', async () => {
    calls.length = 0;
    const view = await build.rebuild(service, project, { summarizer: summarize });
    assert.equal(view.framework.framework, 'nestjs');
    assert.equal(view.stale, false);
    assert.ok(view.files.some((f) => f.path === SCHEMA));
    for (const banned of ['notes.log', 'src/skip-me.ts', 'package-lock.json']) assert.equal(view.files.some((f) => f.path === banned), false, banned);
    assert.ok(names(view, ENUM).includes('enum:VisitOutcome'));
    assert.ok(names(view, DTO).includes('dto:CheckOutDto'));
    assert.ok(names(view, DTO).includes('dto:ListVisitsQuery'));
    assert.ok(names(view, SCHEMA).includes('schema:Visit'));
    assert.ok(names(view, SERVICE).includes('service:VisitService'));
    assert.ok(names(view, SERVICE).includes('function:checkOut'));
    assert.ok(names(view, CONTROLLER).includes('route:POST visits/check-out'));
    assert.ok(view.edges.some((e) => e.from === SERVICE && e.to === SCHEMA));
    assert.ok(view.edges.some((e) => e.from === SERVICE && e.to === DTO));
    assert.ok(view.edges.some((e) => e.from === CONTROLLER && e.to === SERVICE));
    assert.ok(view.edges.some((e) => e.from === DTO && e.to === ENUM));
    assert.ok(calls.length >= 2);
    assert.ok(view.modules.find((m) => m.path === 'src/modules/visit').summary.startsWith('about '));
    assert.equal(view.modules.find((m) => m.path === 'src/modules/visit').summary_stale, false);
    assert.ok(view.architecture.some((a) => a.name === 'ARCHITECTURE.md'));
  });

  it('a one-file change rewrites only that file and only its module summary', async () => {
    const first = await build.getIndex(service, project);
    const dtoAt = first.files.find((f) => f.path === DTO).built_at;
    const schemaAt = first.files.find((f) => f.path === SCHEMA).built_at;
    calls.length = 0;
    fs.appendFileSync(path.join(repo, SCHEMA), '  note?: string;\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'note');
    const stale = await build.getIndex(service, project);
    assert.equal(stale.stale, true);
    const again = await build.rebuild(service, project, { summarizer: summarize });
    assert.deepEqual(again.changed, [SCHEMA]);
    assert.ok(again.kept.includes(DTO));
    assert.ok(again.kept.includes(SERVICE));
    assert.equal(again.files.find((f) => f.path === DTO).built_at, dtoAt);
    assert.notEqual(again.files.find((f) => f.path === SCHEMA).built_at, schemaAt);
    assert.deepEqual(calls, ['src/modules/visit']);
    assert.ok(names(again, SCHEMA).includes('schema:Visit'));
  });
});

describe('index API', () => {
  let S;
  before(async () => { S = await startServer({ env: { ORCH_FLOW: 'v2' } }); });
  after(async () => { await S.stop(); });

  it('search, rebuild and a v2 task build the index', async () => {
    const repo = makeRepo(path.join(S.work, 'api'), REPO);
    const { id, serviceId } = await S.addProject(repo, 'pulse', 'true');
    const empty = await S.get(`/services/${serviceId}/index`);
    assert.equal(empty.built, false);
    assert.equal(empty.stale, true);
    const task = await S.runToReview(id, { title: 'touch readme', prompt: 'Add a line to README.\n\n## Files\n\n- `README.md`', files: ['README.md'], engine: 'auto' });
    assert.equal(task.status, 'review');
    const ev = (await S.get(`/tasks/${task.id}/events`)).map((e) => e.message).join('\n');
    assert.match(ev, /index: built [0-9a-f]{8}/);
    const built = await S.get(`/services/${serviceId}/index`);
    assert.equal(built.framework.framework, 'nestjs');
    assert.ok(built.symbols.some((s) => s.name === 'CheckOutDto'));
    const found = await S.get(`/services/${serviceId}/index/search?q=CheckOutDto`);
    assert.ok(found.hits.some((h) => h.name === 'CheckOutDto' && h.path === DTO));
    fs.appendFileSync(path.join(repo, SCHEMA), '  note?: string;\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'note');
    const again = await S.post(`/services/${serviceId}/index/rebuild`, {});
    assert.deepEqual(again.changed, [SCHEMA]);
    const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'project-tabs.js'), 'utf8');
    assert.match(js, /index\/rebuild/);
    assert.match(fs.readFileSync(path.join(ROOT, 'public', 'js', 'projects.js'), 'utf8'), /\['index', 'Index'\]/);
  });
});

describe('schema v8 migration', () => {
  it('v7 opens as v8, keeps rows, and rolls back on the test hook', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-v8-')));
    const db = path.join(dir, 'up.db');
    const envFor = (extra = {}) => ({ ...process.env, ORCH_DB: db, ORCH_LOG_DIR: path.join(dir, 'logs'), ORCH_WORKTREES: path.join(dir, 'wt'), ORCH_CONTEXT_DIR: path.join(dir, 'ctx'), ...extra });
    const open = (extra) => execFileSync(process.execPath, ['--no-warnings', '-e', "const s=require('./lib/db'); console.log(JSON.stringify({v:s.schemaVersion()}))"], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: envFor(extra) });
    try {
      assert.equal(JSON.parse(open().trim().split('\n').filter((l) => !l.startsWith('[db]')).pop()).v, 8);
      const w = new DatabaseSync(db);
      w.exec("INSERT INTO projects (name, slug, path, default_branch, check_cmd) VALUES ('p','p','','','true')");
      w.exec("INSERT INTO services (project_id, name, path, local_path, default_branch) VALUES (1,'api','.','/x','main')");
      w.exec('DROP TABLE index_symbols'); w.exec('DROP TABLE index_edges'); w.exec('DROP TABLE index_files'); w.exec('DROP TABLE index_summaries'); w.exec('DROP TABLE index_meta');
      w.exec('PRAGMA user_version = 7');
      w.close();
      assert.equal(JSON.parse(open().trim().split('\n').filter((l) => !l.startsWith('[db]')).pop()).v, 8);
      const d = new DatabaseSync(db, { readOnly: true });
      const n = d.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('index_files','index_symbols','index_edges','index_summaries','index_meta')").get().c;
      const projects = d.prepare('SELECT COUNT(*) c FROM projects').get().c;
      d.close();
      assert.equal(n, 5);
      assert.equal(projects, 1);
      assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('pre-v8-migration-')).length, 1);
      w2();
      function w2() {
        const d2 = new DatabaseSync(db);
        d2.exec('DROP TABLE index_symbols'); d2.exec('DROP TABLE index_edges'); d2.exec('DROP TABLE index_files'); d2.exec('DROP TABLE index_summaries'); d2.exec('DROP TABLE index_meta');
        d2.exec('PRAGMA user_version = 7');
        d2.close();
      }
      assert.throws(() => open({ ORCH_TEST_FAIL_MIGRATION_V8: '1' }), (e) => /v8 migration failed and was rolled back/.test(String(e.stderr)));
      const left = new DatabaseSync(db, { readOnly: true });
      assert.equal(left.prepare('SELECT user_version v FROM pragma_user_version').get().v, 7);
      assert.equal(left.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'index_files'").get().c, 0);
      left.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
