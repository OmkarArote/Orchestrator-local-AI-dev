'use strict';
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();
const ROOT = __dirname;
const LOCAL = path.join(HOME, 'work', 'local-ai-dev');
const env = process.env;
// Optional local settings: ./.env (git-ignored, KEY=value lines). Real environment variables win. Never loaded under `node --test`.
if (!env.NODE_TEST_CONTEXT) { try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env file: fine */ } }
// Safety net: code running under `node --test` (including its child processes) must never fall back to the real data/log/worktree dirs.
function guardTestRun(name, fallback) {
  if (env.NODE_TEST_CONTEXT) throw new Error(`refusing to use the real ${name} default under node:test - set ${name} to a temp path`);
  return fallback;
}
/**
 * Where the SQLite DB lives. An explicit ORCH_DB always wins (tests, demos, migrations of copies). The REAL default (<repo>/data/orchestrator.db)
 * is only handed out to `node server.js` itself (or when ORCH_ALLOW_DEFAULT_DB=1 is set on purpose), and never under `node --test`
 * (NODE_TEST_CONTEXT) or NODE_ENV=test. Anything else (a one-off `node -e "require('./lib/db')"`, a script, an editor tool) gets an error
 * instead of silently opening - and auto-migrating - the live database. Pure function so it can be tested without opening anything.
 */
function resolveDbPath(e = env, mainFile = require.main && require.main.filename) {
  if (e.ORCH_DB) return e.ORCH_DB;
  if (e.NODE_TEST_CONTEXT || e.NODE_ENV === 'test') throw new Error('refusing to use the real ORCH_DB default under node:test / NODE_ENV=test - set ORCH_DB to a temp path');
  const real = (x) => { try { return require('node:fs').realpathSync(x); } catch { return path.resolve(x); } };
  if (e.ORCH_ALLOW_DEFAULT_DB === '1' || (mainFile && real(mainFile) === real(path.join(ROOT, 'server.js')))) return path.join(ROOT, 'data', 'orchestrator.db');
  throw new Error('refusing to open the real orchestrator DB (data/orchestrator.db) from anything but `node server.js`: set ORCH_DB to a throw-away path (or ORCH_ALLOW_DEFAULT_DB=1 if you really mean it)');
}
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
/** Integer env, or `d` when unset. `allow` holds extras outside min..max (num_predict uses -1). Throws on a bad value so a typo cannot silently truncate. */
function boundedInt(name, v, d, min, max, allow = []) {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (Number.isInteger(n) && ((n >= min && n <= max) || allow.includes(n))) return n;
  throw new Error(`${name} must be an integer ${min}..${max}${allow.length ? ` or ${allow.join(' or ')}` : ''}; got ${JSON.stringify(v)}`);
}

module.exports = {
  HOST: '127.0.0.1', // hard-coded on purpose: never expose externally
  PORT: num(env.ORCH_PORT, 4310),
  HOME,
  // Legacy single-repo settings: now ONLY used once, to seed the first project when migrating a pre-projects DB
  // (or to seed a brand-new DB when ORCH_REPO is set explicitly).
  REPO: env.ORCH_REPO || '',
  REPO_IS_EXPLICIT: !!env.ORCH_REPO,
  BASE_BRANCH: env.ORCH_BASE_BRANCH || 'main',
  // Authorized roots (colon separated): the only places where services (repos) may be registered/created/cloned. Seeds the authorized_roots table.
  AUTHORIZED_ROOTS: (env.ORCH_AUTHORIZED_ROOTS || path.join(HOME, 'work')).split(':').map((s) => s.trim()).filter(Boolean).map((s) => (s === '~' || s.startsWith('~/') ? path.join(HOME, s.slice(1)) : s)),
  PROJECTS_PARENT: env.ORCH_PROJECTS_PARENT || path.join(HOME, 'work'), // default parent dir for "create new project"
  WORKTREES: env.ORCH_WORKTREES || guardTestRun('ORCH_WORKTREES', path.join(LOCAL, 'worktrees')),
  get DB_PATH() { return resolveDbPath(); },   // lazy: only code that actually opens the DB trips the guard
  resolveDbPath,
  LOG_DIR: env.ORCH_LOG_DIR || guardTestRun('ORCH_LOG_DIR', path.join(LOCAL, 'logs')),
  PUBLIC_DIR: path.join(ROOT, 'public'),
  OLLAMA_API_BASE: env.OLLAMA_API_BASE || 'http://127.0.0.1:11434',
  OLLAMA_ALLOW_REMOTE: env.ORCH_OLLAMA_ALLOW_REMOTE === '1',            // adapter refuses non-loopback Ollama URLs unless set
  OLLAMA_REGISTRY: env.ORCH_OLLAMA_REGISTRY || 'https://registry.ollama.ai', // read-only manifest lookups (sizes); tests point this at a fake
  ALLOW_MODEL_PULL: env.ORCH_ALLOW_MODEL_PULL === '1',                    // DISABLED by default: no pull/delete endpoint does anything unless this is 1
  MODEL: env.ORCH_MODEL || 'ollama_chat/qwen2.5-coder:7b',
  AIDER_BIN: env.ORCH_AIDER_BIN || path.join(HOME, '.local', 'bin', 'aider'),
  // local request budget (swap-relook #5: one ~474 KB request stalled the 9B model; #9-#13: no files + no repo map = no code seen)
  LOCAL_MAX_REQUEST_CHARS: num(env.ORCH_LOCAL_MAX_REQUEST_CHARS, 60000),  // message + context + pinned/auto-added files + repo map (~15k tokens)
  LOCAL_MAX_FILE_BYTES: num(env.ORCH_LOCAL_MAX_FILE_BYTES, 64 * 1024),   // tracked files above this go into the aider ignore file (unless pinned)
  LOCAL_MAX_FILES: num(env.ORCH_LOCAL_MAX_FILES, 5),                     // more pinned files = multi-file task: refused locally (Cursor / split)
  LOCAL_MAP_TOKENS: num(env.ORCH_LOCAL_MAP_TOKENS, 2048),                // repo map when no files are pinned
  LOCAL_MAP_TOKENS_WITH_FILES: num(env.ORCH_LOCAL_MAP_TOKENS_WITH_FILES, 1024),
  AIDER_THINK: env.ORCH_AIDER_THINK === '1', // default off: aider gets think:false for thinking-capable local models
  // unset or '' means diff, then whole for a pinned file under 4 KB or a pinned file that does not exist yet (lib/runner.js)
  AIDER_EDIT_FORMAT: env.ORCH_AIDER_EDIT_FORMAT ? String(env.ORCH_AIDER_EDIT_FORMAT) : '',
  LOCAL_NUM_PREDICT: boundedInt('ORCH_LOCAL_NUM_PREDICT', env.ORCH_LOCAL_NUM_PREDICT, 4096, 1, 131072, [-1]),
  LOCAL_NUM_CTX: 16384, // coding-role default when the role does not set num_ctx; not an env var (CTX_WARN, under CTX_MAX)
  OLLAMA_KEEP_ALIVE: env.ORCH_OLLAMA_KEEP_ALIVE ? String(env.ORCH_OLLAMA_KEEP_ALIVE) : '30m', // top-level field on native /api/chat only
  PROTECTED_BRANCHES: (env.ORCH_PROTECTED_BRANCHES !== undefined ? env.ORCH_PROTECTED_BRANCHES : 'main,uat,UAT').split(',').map((s) => s.trim()).filter(Boolean),
  // hard timeouts (ms) for every subprocess
  AIDER_TIMEOUT_MS: num(env.ORCH_AIDER_TIMEOUT_MS, 20 * 60 * 1000),
  INSTALL_TIMEOUT_MS: num(env.ORCH_INSTALL_TIMEOUT_MS, 10 * 60 * 1000),
  CHECK_TIMEOUT_MS: num(env.ORCH_CHECK_TIMEOUT_MS, 10 * 60 * 1000),
  GIT_TIMEOUT_MS: num(env.ORCH_GIT_TIMEOUT_MS, 60 * 1000),
  POLL_MS: num(env.ORCH_POLL_MS, 2000),
  DEFAULT_CHECK: 'npm run build',
  // ---- Cursor CLI engine (runs on Cursor's servers, uses the user's Cursor plan usage)
  CURSOR_BIN: env.ORCH_CURSOR_BIN || path.join(HOME, '.local', 'bin', 'agent'),
  CURSOR_MODEL: env.ORCH_CURSOR_MODEL || 'auto',                // default model for engine=cursor|auto
  CURSOR_REVIEW_MODEL: env.ORCH_CURSOR_REVIEW_MODEL || 'auto',  // default model for the advisory AI review
  CURSOR_TIMEOUT_MS: num(env.ORCH_CURSOR_TIMEOUT_MS, 35 * 60 * 1000), // multi-file Cursor work (task #7) needed more than the old 15 min
  CURSOR_PREINSTALL: env.ORCH_CURSOR_PREINSTALL !== '0',               // install deps in the worktree before a Cursor task run when a lockfile exists
  CURSOR_REVIEW_TIMEOUT_MS: num(env.ORCH_CURSOR_REVIEW_TIMEOUT_MS, 5 * 60 * 1000),
  // plan-first: a plan without a createPlan body shorter than this is treated as truncated (not stored); with a createPlan body the floor is lower
  PLAN_MIN_CHARS: num(env.ORCH_PLAN_MIN_CHARS, 600),
  PLAN_MIN_CHARS_TOOL: num(env.ORCH_PLAN_MIN_CHARS_TOOL, 80),
  // The daily Cursor caps (ORCH_CURSOR_DAILY_CAP / ORCH_CURSOR_REVIEW_DAILY_CAP) were removed in schema v5: usage is only COUNTED now (db.cursorStats).
  // Cursor stays approval-only (start / plan / escalation clicks). If the old variables are still set we log a one-time notice and ignore them.
  CURSOR_CAP_ENV_IGNORED: ['ORCH_CURSOR_DAILY_CAP', 'ORCH_CURSOR_REVIEW_DAILY_CAP'].filter((k) => env[k] !== undefined && env[k] !== ''),
  // engine=auto: escalating local -> cursor needs a dashboard click unless this is explicitly turned off
  ESCALATION_REQUIRE_APPROVAL: env.ORCH_ESCALATION_REQUIRE_APPROVAL !== '0',
  CURSOR_STATUS_TTL_MS: num(env.ORCH_CURSOR_STATUS_TTL_MS, 60 * 1000),
  CURSOR_MODELS_TTL_MS: num(env.ORCH_CURSOR_MODELS_TTL_MS, 10 * 60 * 1000),
  MAX_PARALLEL_CURSOR: Math.max(1, Math.floor(num(env.ORCH_MAX_PARALLEL_CURSOR, 2))), // concurrent Cursor tasks (different services); local tasks are always sequential
  CURSOR_IDE_BIN: env.ORCH_CURSOR_IDE_BIN || '',        // `cursor` CLI of the IDE (auto-detected when empty)
  OSASCRIPT_BIN: env.ORCH_OSASCRIPT_BIN || '/usr/bin/osascript',
  OPEN_DRY_RUN: env.ORCH_OPEN_DRY_RUN === '1',          // "Open in Cursor": report the command instead of launching (tests)
  // ---- Stage 4: shared context, routing, memory
  CONTEXT_DIR: env.ORCH_CONTEXT_DIR || path.join(path.dirname(env.ORCH_DB || path.join(ROOT, 'data', 'orchestrator.db')), 'context'),
  // attachments (M6): uploaded media/documents live next to the DB (content-addressed, owner-only); every cap is overridable, decimals allowed (tests use tiny caps)
  ATTACH_DIR: env.ORCH_ATTACH_DIR || path.join(path.dirname(env.ORCH_DB || path.join(ROOT, 'data', 'orchestrator.db')), 'attachments'),
  UPLOAD_LIMITS: {
    image: Math.floor(num(env.ORCH_UPLOAD_MAX_IMAGE_MB, 20) * 1048576),
    document: Math.floor(num(env.ORCH_UPLOAD_MAX_DOC_MB, 50) * 1048576),
    audio: Math.floor(num(env.ORCH_UPLOAD_MAX_AUDIO_MB, 100) * 1048576),
    video: Math.floor(num(env.ORCH_UPLOAD_MAX_VIDEO_MB, 500) * 1048576),
    text: Math.floor(num(env.ORCH_UPLOAD_MAX_TEXT_MB, 5) * 1048576), // plain text, csv, json
  },
  ATTACH_QUOTA_BYTES: Math.floor(num(env.ORCH_ATTACH_QUOTA_GB, 5) * 1073741824),
  ATTACH_GC_HOURS: num(env.ORCH_ATTACH_GC_HOURS, 24), // unreferenced attachments older than this are swept
  ATTACH_RETENTION_DAYS: num(env.ORCH_ATTACH_RETENTION_DAYS, 0), // 0 = keep linked attachments forever; N>0 = delete attachments (and their links) older than N days
  CONTEXT_MAX_CHARS: num(env.ORCH_CONTEXT_MAX_CHARS, 12000),    // cap of the whole context bundle (~3k tokens) so the 9B model keeps room
  CONTEXT_FILE_MAX_BYTES: 200 * 1024,
  LLM_MODEL: env.ORCH_ROUTER_MODEL || (env.ORCH_MODEL || 'ollama_chat/qwen2.5-coder:7b').replace(/^ollama(_chat)?\//, ''), // plain ollama model name
  ROUTER_API: env.ORCH_ROUTER_API === 'ollama' ? 'ollama' : 'openai', // openai = /v1/chat/completions (default), ollama = native /api/chat
  ROUTER_TIMEOUT_MS: num(env.ORCH_ROUTER_TIMEOUT_MS, 120000),
  ROUTER_MIN_CONFIDENCE: num(env.ORCH_ROUTE_MIN_CONFIDENCE, 0.55),
  ROUTER_SERVICES_MAX_CHARS: num(env.ORCH_ROUTER_SERVICES_MAX_CHARS, 6000), // Ollama's OpenAI endpoint loads the model with a 4096-token window: keep the prompt small
  ROUTE_COMPLEX_ENGINE: env.ORCH_ROUTE_COMPLEX_ENGINE || 'cursor',         // policy defaults (per-project settings override)
  ROUTE_SIMPLE_ENGINE: env.ORCH_ROUTE_SIMPLE_ENGINE || 'auto',             // auto = local first + escalation allowed
  ROUTE_PLAN_FIRST: env.ORCH_ROUTE_PLAN_FIRST !== '0',
  ROUTE_APPLY: env.ORCH_ROUTE_APPLY === 'auto' ? 'auto' : 'suggest',       // suggest = only a suggestion; you confirm at approve-start
  MEMORY_PROPOSALS: env.ORCH_MEMORY_PROPOSALS !== '0',
  MEMORY_TIMEOUT_MS: num(env.ORCH_MEMORY_TIMEOUT_MS, 180000),
  MEMORY_NUM_CTX: num(env.ORCH_MEMORY_NUM_CTX, 8192),
  CHAT_NUM_CTX: num(env.ORCH_CHAT_NUM_CTX, 16384),              // dashboard chat context window (the `chat` role option num_ctx overrides it); one shared value avoids model reloads
  EMPTY_CHECK: 'git diff --check',                                          // default check for empty-template projects
  MAX_REVIEW_DIFF_BYTES: 80 * 1024,
  MAX_LINE: 4000,
  MAX_DIFF_BYTES: 400 * 1024,
  /** The orchestrator's own directories: never valid targets for service operations. */
  ownDirs() { return [ROOT, path.dirname(this.DB_PATH), this.LOG_DIR, this.WORKTREES, this.CONTEXT_DIR, this.ATTACH_DIR]; },
};
