# Local AI Dev Orchestrator

A local-first, human-approved task runner for AI coding agents. You describe a change, approve it, and the orchestrator
makes an isolated **git worktree + branch**, runs an engine (a free local model through **aider + Ollama**, or the
**Cursor CLI**), runs your check command, commits the result on the branch and then **stops for your review**.
**Nothing is ever merged without your explicit approve-merge click.** Everything runs on `127.0.0.1` only.

- Projects contain services (one git repo or a folder in a repo each); every task runs in exactly one service.
- Engines per task: `local` (aider + Ollama, free), `cursor` (Cursor CLI, uses your Cursor plan, needs your approval, daily cap) or `auto` (local first, escalate to Cursor only after you approve).
- Shared project rules and memory, a local router that suggests the service/engine, plan-first for complex tasks, sequences across services, an advisory AI review, and "Open in Cursor".
- Zero npm dependencies: Node.js + a static dashboard (no build step). Models are never downloaded unless you switch that on.

![Task detail](docs/screens/task-detail.png)

## Quick start (about 5 minutes)

```bash
git clone https://github.com/OmkarArote/Orchestrator-local-AI-dev.git
cd Orchestrator-local-AI-dev
./setup.sh          # checks prerequisites, creates .env, tells you what is missing (installs nothing)
./start.sh          # dashboard at http://127.0.0.1:4310
```

Then open the dashboard: **Models** (pick one of your installed Ollama models), **Projects** -> New project -> add an existing repo or create a new one, then **New task**.
Stop with `./stop.sh`. On Windows use WSL (the scripts are bash).

### Requirements

| Needed for | Requirement | Install |
|---|---|---|
| Everything | **Node.js >= 22.5** (uses the built-in `node:sqlite`) | https://nodejs.org or `nvm install 22` |
| Everything | **git** | https://git-scm.com |
| `local` engine | **Ollama** running, with at least one model | https://ollama.com/download, then e.g. `ollama pull qwen2.5-coder:7b` (about 4.7 GB; fits 16 GB RAM) |
| `local` engine | **aider** | `./setup.sh --install-aider` (or `python3 -m pip install aider-install && aider-install`) |
| `cursor` / `auto` engine (optional) | **Cursor CLI** (`agent`), logged in | `curl https://cursor.com/install -fsS \| bash`, then `agent login` |
| "Open in Cursor" (optional) | Cursor IDE, macOS for the Terminal option | https://cursor.com |

Tested on macOS (Apple Silicon, 16 GB). Linux should work except the macOS-only "open in Terminal" helper. The `local` engine works best with small, precise tasks; use `cursor`/`auto` for larger changes.

Model choice: set `ORCH_MODEL=ollama_chat/<your-model>` in `.env` (default `ollama_chat/qwen2.5-coder:7b`) and/or assign models to roles on the Models page.
Model downloads from the dashboard are **off by default**; enable with `ORCH_ALLOW_MODEL_PULL=1` in `.env` (each download still needs your confirmation).

### Configuration

Copy `.env.example` to `.env` (git-ignored; `setup.sh` does it for you). Real environment variables win over `.env`. The full list of `ORCH_*` settings is in the Configuration section below.
Defaults: repos may live under `~/work` (more folders can be authorized in the UI), worktrees and logs go to `~/work/local-ai-dev/`, the database is `data/orchestrator.db` inside this folder.

### Safety model

Localhost-only (Host/Origin checks, no auth, so do not expose the port), authorized folders only (symlink-safe), hardened git (no hooks, https/ssh only, no credentials stored), hard timeouts and process-group kills on every subprocess, worktree isolation, human approval for start/merge/escalation, daily Cursor cap, and no automatic merging. Do not put secrets in task prompts: prompts are stored in the local database, shown in logs and, for Cursor tasks, sent to Cursor.

### Development

```bash
npm test            # 281 tests, no network, no Ollama or Cursor needed (stubs/fakes)
npm run doctor      # same as ./setup.sh
```

Issues and pull requests are welcome. License: MIT.

---

# Reference

## Architecture

```
 Browser (dashboard)  /  curl
        |  HTTP, 127.0.0.1 only (Host + Origin checked)
        v
 +-----------------------------------------------------------------------+
 | server.js  (node:http, port 4310)                                     |
 |   /            static dashboard (public/index.html, app.js)           |
 |   /api/...     JSON API + SSE log stream                              |
 |      |                 |                    |                         |
 |      v                 v                    v                         |
 |  lib/db.js        lib/projects.js      lib/cursor.js                  |
 |  (sqlite+migrate) (add/create/inspect) (status/models cache,          |
 |      ^                                  stream-json parser)           |
 |  lib/runner.js  (single worker, polls DB every 2s)                    |
 |   approved -> worktree -> engine(aider|cursor) -> check -> commit     |
 |        -> [advisory cursor review] -> review                          |
 |   local fails + engine=auto -> awaiting_escalation -> (human) -> cursor|
 |        |  lib/proc.js: spawn w/ stdin=/dev/null, hard timeout, process-group kill
 +--------|--------------------------------------------------------------+
          v
   git worktree  ~/work/local-ai-dev/worktrees/<project>/task-<id>   (branch ai/task-<id>, cut from the project's default branch)
          |--> local:  aider --model ollama_chat/<your-model> --> Ollama @ 127.0.0.1:11434
          |--> cursor: agent -p --force --trust --sandbox enabled --workspace <worktree> --model <m> --output-format stream-json ...
          |--> check command (task check_cmd, else project check_cmd)
          v
   project repo: only touched by `git worktree add` and, after human approval, `git merge --no-ff`
```

Files:

| Path | Purpose |
|---|---|
| `server.js` | HTTP server, API routing, SSE, host/origin checks |
| `config.js` | all settings (env overrides, see below) |
| `lib/db.js` | SQLite schema, **versioned migration** (PRAGMA user_version), atomic status transitions, cursor usage counter |
| `lib/projects.js` | path safety, inspect / add-existing / create-new, stack detection |
| `lib/runner.js` | the single-task-at-a-time worker (worktree, engines, check, commit, review, escalation) |
| `lib/cursor.js` | Cursor CLI helpers: cached `agent status` / `--list-models`, stream-json -> readable lines |
| `lib/git-ops.js` | diff, guarded merge, worktree removal (all per project) |
| `lib/fsguard.js`, `lib/roots.js` | authorized-folder path guard (canonical paths, symlink-safe); `removeOwnedDir` is the only recursive delete |
| `lib/safegit.js` | hardened git (execFile only, env allowlist, no hooks, https/ssh only, redaction) |
| `lib/service-ops.js`, `lib/importer.js`, `lib/jobs.js`, `lib/services.js`, `lib/repo.js` | service CRUD, create/add-existing, clone import jobs, repo resolution |
| `lib/ollama.js`, `lib/models.js`, `lib/registry.js`, `lib/model-catalog.json` | Ollama client, roles/validation/catalog, read-only registry lookups |
| `scripts/` | `dev-demo.js`, `shot.sh`, `ui-smoke.sh` (isolated demo instance, screenshots, UI smoke test) |
| `lib/paths.js` | branch / worktree path helpers |
| `lib/proc.js` | subprocess + git helpers with hard timeouts |
| `public/` | dashboard (no build step) |
| `data/orchestrator.db` | the database (history is kept; do not delete). Pre-migration snapshots: `data/pre-projects-migration-*.db` |
| `start.sh` / `stop.sh` | background start/stop using `data/orchestrator.pid` |

## Start / stop

`./start.sh` / `./stop.sh` (see Quick start). Log: `~/work/local-ai-dev/logs/orchestrator.log`. Health: `curl -s http://127.0.0.1:4310/api/health`.

## Projects, services and authorized folders (schema v4)

* A **project** is a *logical product* (name, description, optional default folder, settings). It is not a repo.
* A **service** is **one git repository** (or one folder inside a repo: `local_path` + `subdir`). A project has any number of services, each in its
  own repo, anywhere inside an **authorized folder**. **Every task runs against exactly one service** (one repo, one worktree, one branch `ai/task-<id>`,
  one merge approval). `service_id: "auto"` lets the local router pick.
* **Authorized folders** (`GET/POST /api/fs/roots`, `POST /api/fs/roots/:id/remove`): the orchestrator only reads, creates, clones into or registers folders
  inside these (default `~/work`, change with `ORCH_AUTHORIZED_ROOTS=a:b` or in the UI). Everything is checked on the real path (symlinks resolved), hidden
  folders, `~/Library`, `~/.ssh` and the orchestrator's own data/log/worktree dirs are always refused (HTTP 403 outside roots).
* Three ways to add a service (`POST /api/projects/:id/services/...`):
  * `import {url, dest_parent?, dir_name?, name?, branch?}` - `git clone` of an **https://** or **ssh** remote. Credentials are never stored or put in URLs
    (your git credential helper / ssh-agent is used). The clone goes to a hidden staging dir (`.orch-clone-*`) next to the target, is journaled, and is
    renamed into place only on success; cancel or a crash leaves nothing behind (stale staging dirs are swept at startup). No hooks, no submodules,
    no scripts from the repo are run. Returns a job (`GET /api/jobs/:id` gives phase, percent and the redacted log; `POST /api/jobs/:id/cancel`). Max 2 parallel imports.
  * `create {name, template?: empty|node, parent_dir?, ...}` - new folder, `git init -b main`, README/.gitignore, initial commit (always made, so worktrees work).
    Uses your git identity if set, else an `ai-orchestrator@localhost` identity. Never overwrites an existing folder.
  * `add-existing {path, ...}` (+ `inspect` first) - registers a folder that already exists; nothing is moved. A non-repo triggers a confirmable `git init` + baseline commit.
* A remote URL can back only one active service (duplicates are refused with 409; archive the other first).
* `POST /api/services/:id/{update,archive,unarchive,remove}`: *remove* only unregisters (files are never deleted; refused if the service has task history - archive it).
  `GET /api/services/:id/status` is local-only (branch, clean, HEAD). `GET /api/projects/:id/services/detect` proposes subfolder services.
* **Project delete** (`POST /api/projects/:id/delete {confirm: <name>}`): removes database records only; repos, worktrees and branches are never touched (they are listed in the
  response). Refused while tasks are unfinished. Archive (`/archive`) is the soft alternative.
* `env_config` of a service is for non-secret values only (secret-looking names/values are rejected and nothing is stored).
* The `.ai/` context export into a repo is **off by default**; opt in per project (Settings -> shared `.ai/` folder). Context files otherwise live in the orchestrator's managed copy.
* Check command resolution: task `check_cmd` > service `check_cmd` > project `check_cmd` > `npm run build`.
* Legacy aliases still work: `POST /api/projects/add|create` create a project **plus one service** in one call.

### Multi-service work
A **sequence** (`POST /api/projects/:id/groups`) is a list of steps, each targeting one service. Dependency `independent` (default across repos), `merged` (wait until the
previous step is merged) or `stack` (cut from the previous step's branch; **same repo only** - across repos it is rejected with 400). `GET /api/groups/:id/merge-plan` is a read-only
pre-flight (per-step ready/blocked, grouped by repo). **There is no atomic cross-repo merge**: every task is merged with its own approval; if one fails the others stay as they are
and nothing is reverted automatically. The router adds a `multi_service` hint when a prompt clearly spans services.

## Local models (Ollama) - management without downloads

Models page / `lib/models.js` / `lib/ollama.js` (the only Ollama client). **No model is ever downloaded automatically, and pulling is disabled by default.**

* `GET /api/ollama/status|models|catalog`: version, RAM, free disk, installed models (with the roles using them), and a catalog of recommended models with registry-verified sizes
  and a RAM-fit class (comfortable <= 35 % of RAM, tight <= 60 %, else too large). `POST /api/ollama/models/verify {name}` re-checks a size with a read-only registry manifest GET.
* **Roles**: `coding planning requirements review debugging documentation routing memory`. `GET/POST /api/models/roles`, `POST /api/models/roles/validate|clear`, `GET/POST /api/models/default`.
  A role = model + options (`num_ctx`, `temperature`, `top_p`, `top_k`, `num_predict`, `think`, ...). Settings are **validated against `/api/tags` + `/api/show`**
  (installed, context window not exceeded, tools/thinking capability, `num_ctx` above the model's context needs `allow_large_ctx`). Precedence: role row > default-model setting > env (`ORCH_MODEL`...).
  Wired today: `coding` (aider: `--model-settings-file` with `extra_params`, written only when options are configured), `routing`, `memory`. The other roles are stored/validated for later.
* **Pull / delete** (`POST /api/ollama/models/pull|delete`) exist but answer **403 `disabled`** unless `ORCH_ALLOW_MODEL_PULL=1`. Even then they need a disk check
  (free >= 1.25 x size + 5 GB) and an explicit request. The UI's Download buttons are disabled ("downloads disabled - enable later").
* Verified with the installed `<your-model>`: aider auto-sizes its context (about 9k for a tiny prompt), so a role `num_ctx` acts as an override/cap. The `/v1` router endpoint cannot set `num_ctx` (only the Ollama API mode can).

## Dashboard UI (no build step)

Plain ES modules in `public/` (`index.html`, `style.css`, `app.js`, `js/*.js`), CSS custom properties, dark/light via `prefers-color-scheme` (toggle in the sidebar footer), no framework.
* Sidebar: **Projects / Tasks / Models** + live chips (Ollama, Cursor usage, pending memory proposals). Hash routes: `#/projects`, `#/projects/<id>/<services|deps|context|memory|sequences|settings>`, `#/tasks[/<id>]`, `#/models`.
  Old links (`?project=N&panel=...`) are mapped.
* Projects: cards, **New project** modal, authorized-folders card; project page with tabs; services as cards (status/origin/stack chips, repo status, edit, archive, unregister, detect);
  **Add service** modal with *Import from URL* (progress bar + live clone log + cancel), *Create new*, *Add existing folder* (inspect first).
* Tasks: master-detail list with project/status filters; detail with routing, plan, review and memory cards, all approval actions, a **terminal-style live log** (SSE) and a **coloured diff** view.
* Models: installed models, role table with validate/save/reset, default model, catalog with fit badges and verify (Download disabled).
* Toasts for results/errors, modals instead of `alert/confirm/prompt` (Esc, focus trap, type-to-confirm for deletes), skeleton and empty states, keyboard-friendly, responsive.
* Screenshots: `docs/screens/`. Dev helpers: `scripts/dev-demo.js` (isolated seeded instance), `scripts/shot.sh` (headless Chrome screenshot), `scripts/ui-smoke.sh` (drives the UI over CDP).

## Upgrading to schema v4, backups and rollback

* At startup an older DB is migrated automatically after a **consistent backup** `data/pre-v4-migration-<timestamp>.db` (`VACUUM INTO`), in one transaction (expand-only: nothing is dropped,
  legacy columns stay; the contract step "v5" is intentionally not done yet). Existing projects become projects with one **legacy** service (whole repo) and keep their tasks.
  Earlier snapshots: `data/pre-projects-migration-*.db` (v0->v1).
* **Rollback = restore the backup DB AND the old code together.** The old code refuses/misbehaves on a v4 DB, and the new code cannot read a v3 DB without migrating it.
  Steps: `./stop.sh`; `git checkout <old tag>`; copy the `pre-v4-migration-*.db` over `data/orchestrator.db`; `./start.sh`. (Anything created after the migration is lost on rollback.)
* The test suite never touches the real data dir (`config.js` refuses real-dir fallbacks under `node --test`).

## Cursor CLI engine

Invocation (verified together with a smoke test on Cursor CLI 2026.10.14):

```
agent -p --force --trust --sandbox enabled --workspace <worktree> --model <model> \
      --output-format stream-json --stream-partial-output "<prompt>"      (cwd = worktree, stdin = /dev/null)
```

* Always run **inside the task's git worktree** (guard: the path must be under the worktrees root, be a git worktree root, differ from the
  project repo and be on `ai/task-<id>`; otherwise the run is refused). The project's main checkout is never the workspace; HEAD/status of
  the main checkout are compared before/after and a warning event is logged if they changed.
* The prompt = your task prompt + rules (stay in the worktree, minimal change, **do not git commit/push**, the check command that must pass).
  The orchestrator commits afterwards.
* Per-task `model` (default `ORCH_CURSOR_MODEL`, default `auto`; validated against `agent --list-models` when that list is cached).
* **Hard timeout** (`ORCH_CURSOR_TIMEOUT_MS`, default 15 min), process-group SIGTERM/SIGKILL, cancel supported.
* **stream-json is parsed into readable `task_events`** (`kind=cursor`: session, thinking, assistant text, tool calls with ok/exit/+lines,
  result with duration and token counts). Partial deltas are merged into one line per segment. The **raw stream is kept** in
  `~/work/local-ai-dev/logs/cursor-task-<id>-task.jsonl` (stderr in `.stderr`); reviews use `...-review.jsonl`.
* Success = exit 0 **and** a `result` event with `subtype: success`. Then the normal check runs, changes are committed on the branch, the task goes to `review`.
* **Advisory AI review** (per-task `ai_review`, `review_model` default `ORCH_CURSOR_REVIEW_MODEL` = `auto`): after the check passes,
  `agent -p --mode ask --trust --sandbox enabled --workspace <worktree> --model <m> ...` gets the task + diff (embedded in the prompt, capped at
  80 KB) and its answer is stored in `tasks.review_summary` and `task_events` (`kind=review`), labelled **ADVISORY**. It **never blocks** the merge;
  failures/timeouts are logged as "AI review unavailable". Read-only is enforced: if the worktree changed anyway it is reset to the commit and an error is logged.
  Reviews use Cursor too (they count toward the cap; they are skipped if the cap is reached).
* `GET /api/cursor/status` - login check via `agent status --format json` (cached 60 s, `?refresh=1` to force) + today's usage counter.
  `GET /api/cursor/models` - parsed `agent --list-models` (cached 10 min).

### Escalation (engine `auto`)

1. Local engine runs (aider), then the check. Success -> `review` as usual (Cursor is never touched).
2. If local made no changes, failed, or the check failed: **only if the task has `allow_escalation`** and the daily cap isn't hit, the local
   attempt is committed on the branch (`[aider failed]`/`[check failed]` prefix), an `escalation` event is logged, and the task moves to
   status **`awaiting_escalation`**. **Cursor is not invoked.** (If the cap is hit: task fails, event `escalation BLOCKED`; if not allowed: fails, event logged.)
3. A human clicks **Approve escalation** (`POST /api/tasks/:id/approve-escalation`, recorded in `approvals` with stage `escalate`) -> `approved`;
   the runner resumes in the **same worktree** (on top of the local commit) with engine cursor, the failure reason and last check output in the prompt.
   **Reject escalation** (`.../reject-escalation {reason}`) -> `rejected`, nothing is sent to Cursor, the local attempt stays on the branch.
4. Escalation never loops: after Cursor ran once, a failure is final.
   `ORCH_ESCALATION_REQUIRE_APPROVAL=0` skips the click (still needs `allow_escalation` + cap; logged as auto-approved). Default is **approval required**.

### Cap / counter

`ORCH_CURSOR_DAILY_CAP` (default **10**) limits Cursor CLI invocations (**tasks + reviews**) per local calendar day (resets at local midnight).
Every spawn is recorded in `cursor_usage` (even if it then fails). `engine=cursor` tasks are refused at *approve-start* when the cap is hit (and
again right before spawning); escalations are blocked as above; reviews are skipped. The dashboard header shows `used today N/cap (tasks, reviews)`;
`/api/health` and `/api/cursor/status` return `cursor_usage`. This counts invocations, not Cursor's real billing - it is a local guard-rail.

The dashboard shows engine + model per task and a clear badge: **local** (green, "aider + ollama on this Mac") vs **runs on Cursor servers (uses Pro usage)** (orange).

## Configuration (environment variables, read in `config.js`)

| Variable | Default | Meaning |
|---|---|---|
| `ORCH_PORT` | `4310` | listen port (bind address `127.0.0.1` is hard-coded) |
| `ORCH_REPO`, `ORCH_BASE_BRANCH` | empty, `main` | **only used to seed the first project** when migrating an old DB (or a brand-new DB when `ORCH_REPO` is set). Afterwards projects live in the DB |
| `ORCH_PROJECTS_PARENT` | `~/work` | default parent dir in "create new project" |
| `ORCH_WORKTREES` | `~/work/local-ai-dev/worktrees` | root; worktrees are `<root>/<project>/task-<id>` |
| `ORCH_DB` | `orchestrator/data/orchestrator.db` | SQLite file |
| `ORCH_LOG_DIR` | `~/work/local-ai-dev/logs` | aider histories and cursor raw streams per task |
| `OLLAMA_API_BASE` / `ORCH_MODEL` / `ORCH_AIDER_BIN` | `http://127.0.0.1:11434` / `ollama_chat/<your-model>` / `~/.local/bin/aider` | local engine |
| `ORCH_AIDER_TIMEOUT_MS` | `1200000` | hard timeout for aider |
| `ORCH_INSTALL_TIMEOUT_MS` / `ORCH_CHECK_TIMEOUT_MS` / `ORCH_GIT_TIMEOUT_MS` | `600000` / `600000` / `60000` | other hard timeouts |
| `ORCH_CURSOR_BIN` | `~/.local/bin/agent` | Cursor CLI |
| `ORCH_CURSOR_MODEL` | `auto` | default model for cursor/auto tasks |
| `ORCH_CURSOR_REVIEW_MODEL` | `auto` | default model for the advisory review |
| `ORCH_CURSOR_TIMEOUT_MS` / `ORCH_CURSOR_REVIEW_TIMEOUT_MS` | `900000` / `300000` | hard timeouts |
| `ORCH_CURSOR_DAILY_CAP` | `10` | max Cursor invocations per local day |
| `ORCH_ESCALATION_REQUIRE_APPROVAL` | `1` | `0` = auto-approve escalations (not recommended) |
| `ORCH_CURSOR_STATUS_TTL_MS` / `ORCH_CURSOR_MODELS_TTL_MS` | `60000` / `600000` | cache TTLs |
| `ORCH_POLL_MS` | `2000` | runner poll interval |
| `ORCH_AUTHORIZED_ROOTS` | `~/work` | colon-separated folders services may live in (more can be added in the UI) |
| `ORCH_CLONE_TIMEOUT_MS` | `600000` | hard timeout for a clone import |
| `ORCH_ALLOW_MODEL_PULL` | `0` | `1` enables the (otherwise 403) model pull/delete endpoints |
| `ORCH_OLLAMA_REGISTRY` | `https://registry.ollama.ai` | read-only manifest GETs for catalog size verification |
| `ORCH_OLLAMA_ALLOW_REMOTE` | `0` | allow a non-loopback `OLLAMA_API_BASE` |
| `ORCH_TEST_ALLOW_FILE` | unset | **test-only**: allow `file://` remotes for import tests; never set in production |

A disposable second instance (e.g. testing against throwaway repos or a fake `agent`) can be started by hand with different env vars:

```bash
T=~/work/local-ai-dev/scratch/inst2
ORCH_PORT=4311 ORCH_DB=$T/data/orch.db ORCH_LOG_DIR=$T/logs ORCH_WORKTREES=$T/wt ORCH_CURSOR_BIN=/path/to/fake-agent \
  node --no-warnings server.js &
```

## API

All endpoints are on `http://127.0.0.1:<port>`. POSTs need `Content-Type: application/json`. Errors are `{error: "..."}` (+ extras) with
400 validation, 403 bad Host/Origin, 404, 409 wrong state / refused, 415 not JSON, 502 (models list unavailable).

| Method + path | Body | Effect |
|---|---|---|
| `GET /api/health` | - | `{ok, schema, projects, model, cursor_usage}` |
| `GET /api/config` | - | engines, default models, cap, timeouts, escalation policy |
| `GET /api/cursor/status`, `GET /api/cursor/models` | - | see above (`?refresh=1`) |
| `GET /api/projects[?archived=1]` | - | list |
| `POST /api/projects/inspect` | `{path}` | git/branch/stack detection, no side effects |
| `POST /api/projects/add` (alias `POST /api/projects`) | `{path, name?, check_cmd?, install_cmd?, engine?, default_branch?, confirm_git_init?}` | add existing repo (201) |
| `POST /api/projects/create` | `{name, parent_dir?, template?, check_cmd?, install_cmd?, engine?}` | new repo (201) |
| `GET /api/projects/:id`, `POST /api/projects/:id/{archive,unarchive,update}` | | |
| `POST /api/projects` | `{name, description?, root_dir?}` | create a logical project (201); a body with `path` is the legacy add-existing alias |
| `GET/POST /api/projects/:id/services`, `POST /api/projects/:id/services/{inspect,add-existing,create,import}` | see above | list / add services; import returns a job (202) |
| `POST /api/services/:id/{update,archive,unarchive,remove}`, `GET /api/services/:id/status` | | service management |
| `GET/POST /api/fs/roots`, `POST /api/fs/roots/:id/remove`, `POST /api/fs/check` | `{path}` | authorized folders |
| `GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel` | | import jobs |
| `POST /api/projects/:id/delete` | `{confirm: <name>}` | delete records only |
| `GET /api/groups/:id/merge-plan`, `POST /api/groups/:id/{approve-start,reject}` | | sequences |
| `GET /api/ollama/{status,models,catalog}`, `POST /api/ollama/models/{verify,pull,delete}` | | models (pull/delete disabled by default) |
| `GET/POST /api/models/{default,roles}`, `POST /api/models/roles/{validate,clear}` | | model roles |
| `GET /api/tasks[?project_id=N]` | - | list (newest first, max 300) |
| `POST /api/tasks` | `{project_id, title, prompt, files?, check_cmd?, engine?, model?, allow_escalation?, ai_review?, review_model?}` | create in `pending` (201). `project_id` may be omitted only if exactly one active project exists. `engine` defaults to the project's. `allow_escalation` only with `engine=auto` |
| `GET /api/tasks/:id` | - | task + `approvals[]` |
| `GET /api/tasks/:id/events?after=<eventId>` | - | event log (aider/cursor/check/git/review/escalation/system lines) |
| `GET /api/tasks/:id/stream` | - | Server-Sent Events (`log`, `status`) |
| `GET /api/tasks/:id/diff` | - | `{stat, diff, truncated, note}` of `<default branch>...branch` |
| `POST /api/tasks/:id/approve-start` / `reject-start` | `{reason?}` / `{reason}` | `pending` -> `approved` / `rejected` |
| `POST /api/tasks/:id/approve-escalation` / `reject-escalation` | `{reason?}` / `{reason}` | from `awaiting_escalation` |
| `POST /api/tasks/:id/approve-merge` / `reject-merge` | `{reason?}` / `{reason}` | from `review`: guarded `git merge --no-ff` in the task's project / `rejected` |
| `POST /api/tasks/:id/cancel` | - | kill the running task (ends `failed: cancelled by user`) |

Example:

```bash
curl -s -X POST -H 'Content-Type: application/json' http://127.0.0.1:4310/api/tasks \
  -d '{"project_id":3,"title":"demo","prompt":"...","files":["sum.js"],"engine":"auto","allow_escalation":true,"ai_review":true}'
```

## Task lifecycle / statuses

```
 pending --approve-start--> approved --> running --> checking --> review --approve-merge--> done
    |                                       |           |           |
    +--reject-start--> rejected             +-----------+--> failed +--reject-merge--> rejected
                                  (engine=auto, local failed, allow_escalation, under cap)
                                            +-----------+--> awaiting_escalation --approve--> approved --> running (cursor) ...
                                                                     +--reject--> rejected
```

| Status | Meaning |
|---|---|
| `pending` | created, waiting for a human to approve **start** (nothing has run) |
| `awaiting_approval` | reserved in the schema; **not used** |
| `approved` | start (or escalation) approved; waiting for the single runner |
| `running` / `checking` | engine is editing / install + check command running (the advisory review also happens in `checking`) |
| `awaiting_escalation` | local attempt failed; waiting for a human decision on running Cursor (Cursor **not** invoked) |
| `review` | engine ok **and** check passed **and** the branch has changes; waiting for a human merge decision |
| `done` | merge approved and the guarded merge succeeded |
| `failed` | engine failed/timed out, check failed/timed out, no changes, cancelled, restart mid-run, escalation blocked/not allowed. Changes are still committed on the branch (`[aider failed]`, `[cursor failed]`, `[check failed]`, `[cancelled]`) |
| `rejected` | a human rejected the start, the escalation, or the merge |

## Safety properties

- **Localhost only**: binds `127.0.0.1` (hard-coded); `Host` must be `127.0.0.1:<port>`/`localhost:<port>` (403 otherwise); POSTs with a foreign `Origin` get 403 and must be `application/json`.
- **Never auto-merges**: the only merge path is `approve-merge`, called by a human. It refuses unless the project repo is on its default branch, clean, the branch exists and its tip equals the reviewed `head_sha`. A failed merge is `git merge --abort`ed. AI review is advisory only.
- **Human gates**: before start, before merge, and (default) before escalating to Cursor.
- **Worktree isolation**: every task runs in its own `git worktree` on `ai/task-<id>`; neither aider nor Cursor is ever pointed at the project's main checkout (explicit guard for Cursor).
- **Cursor is sandboxed and capped**: `--sandbox enabled`, `--workspace <worktree>`, hard timeout, process-group kill, daily cap, no prompt for secrets; nothing runs on Cursor unless the task's engine says so (or an approved escalation).
- **Timeouts**: aider, Cursor (task and review), install, check and each git call have hard timeouts; subprocesses run in their own process group (stdin is `/dev/null`).
- **One task at a time**; crash recovery marks tasks left `running`/`checking` by a dead process as `failed` (`awaiting_escalation` survives restarts).
- Project paths are confined to your home directory (see Projects). Static file serving is confined to `public/`; bodies capped at 1 MB.
- Aider scratch files, `*.tsbuildinfo`, `dist/`, `node_modules/` (and an untracked `package-lock.json`) are excluded from commits.

Note: check/install commands run via `sh -c` and are arbitrary shell supplied by whoever can reach the API. That is acceptable only because the API is
localhost-only and unauthenticated by design - do not expose the port. A Cursor task (with `--force`) can also run shell commands inside Cursor's sandbox in the worktree.

## Database migration

Schema versions use `PRAGMA user_version`. v0 (single-repo, original) -> v1 (projects, engines, escalation) runs automatically at startup: it first writes a
consistent snapshot `data/pre-projects-migration-<timestamp>.db` (`VACUUM INTO`), then, in one transaction, creates `projects`, seeds a project from `ORCH_REPO`
(from `ORCH_REPO`/`ORCH_BASE_BRANCH`), rebuilds `tasks` (adds `project_id` and the engine/model/escalation/review columns, widens the status CHECK) and
`approvals` (stage `escalate`), copies every row, verifies the task count and `foreign_key_check`, and rolls back on any error. Foreign keys are switched
off during the rebuild so `task_events` are not cascade-deleted. Existing tasks keep their ids, events, approvals and worktree paths (old worktrees were
`worktrees/task-<id>`; they are recorded per task in `tasks.worktree_path`).

## Stage 4: services, context, router, supervised sessions, sequences

> Schema is now **v3**. Everything below is additive; prior safety properties (localhost only, Host/Origin checks, no auto-merge, timeouts, worktree isolation, human gates) are unchanged.

### Services
See *Projects, services and authorized folders* above. (Stage 4 originally only supported sub-folders of the project's repo; since v4 a service is its own repository, and a sub-folder of a repo is still possible via `local_path` + `subdir`.)

### Project context files
Per project: `RULES.md`, `SERVICES.md`, `MEMORY.md` and optional `services/<name>.md`. The **managed copy** lives in `data/context/<project>/` (override: `ORCH_CONTEXT_DIR`) and is what runs use.
Edit in **Project panel -> context** (save, "draft SERVICES.md from services", preview of the bundle). Repo sync:
- **Export to repo**: creates branch `ai/context-update-<timestamp>` from the default branch in a temporary worktree, commits `.ai/*.md`, removes the worktree, and creates a task already in `review` so the normal **Approve & merge** flow applies. Nothing is ever written to the default branch directly.
- **Import from repo**: copies `.ai/*` from the default branch into the managed copy (overwrites the managed text; use it deliberately). Each file shows `repo_state` (e.g. `same`, `n/a`).

### Context bundle injection
Before an engine runs, a bundle is assembled: RULES + service-map index + the selected service's section + `services/<name>.md` + the most relevant MEMORY entries (keyword overlap with the task + recency),
**capped** at `ORCH_CONTEXT_MAX_CHARS` (default 12000; per-project override in settings). The bundle is written **outside the repo** (`logs/context/task-<id>/CONTEXT.md`), never into tracked files.
Aider gets it with `--read <file>`; Cursor gets it **prepended to the prompt**. The task page shows what was injected (chars/limit and sections).
Note: on the local 9B model the OpenAI-compatible endpoint defaults to a 4096-token context; keep context files short (aider auto-sizes `num_ctx` for the edit call).

### Memory proposals
After a task reaches `review`, the local LLM may draft 1-4 durable notes (native Ollama API, `num_ctx` 8192, JSON schema; `ORCH_MEMORY_PROPOSALS=0` or the project setting disables it). They are stored as **pending** rows. Only
**Approve** appends them (with a date header) to `MEMORY.md`; **Edit** changes text first; **Reject** discards. Nothing is added without approval. Pending count shows in the header and in Project panel -> memory proposals.
Drafting holds the runner slot for the duration of the LLM call (typically 5-15 s). The model can produce weak or invented-sounding notes (it did, on stub-agent diffs) - treat them as drafts.

### Router (suggestion only)
On task creation with `service = auto` and/or `engine = auto-route`, the local model is asked (strict JSON, schema-validated, temperature low, `reasoning_effort:none`, timeout `ORCH_ROUTER_TIMEOUT_MS`) for
`{service, confidence, difficulty, needs_thinking, reason}` given the SERVICES.md map. Invalid output, timeout, an unreachable Ollama or confidence below `ORCH_ROUTE_MIN_CONFIDENCE` (0.55) -> **keyword fallback**
(service-name/path/keyword overlap + a few complexity words). `routing_source` is `llm | keyword | manual`. The result is a **suggestion**: you confirm or override it in the task's routing card at **approve-start**
(service, engine, model, plan-first, allow-escalation); overriding sets `routing_source = manual`. `route_apply=auto` (project setting / `ORCH_ROUTE_APPLY`) would apply the suggestion automatically; default is `suggest`.
Policy (project settings, defaults): `complex` or `needs_thinking` -> **cursor with plan-first on**; `simple` -> `auto` (local first, escalation allowed, needs your approval). Difficulty is merged conservatively (complex if either the LLM or the keyword check says so).
`POST /api/projects/:id/route {title,prompt}` is a dry run.

### Plan-first (Cursor)
With `plan_first`, a Cursor task first runs `agent --mode plan` (read-only; counted against the task cap; the worktree is restored if anything changed), then stops in **`awaiting_plan`**. You edit/approve the plan (**approve-plan**) or reject it (**reject-plan**).
Only after approval does the implementation run, with the approved plan in the prompt. The actual model reported by the stream (`system/init`) is stored as `tasks.model_used` and shown in the task header. Note: in the one real run, the CLI reported `model: Auto` and `permissionMode: default` even with `--mode plan`; read-only behaviour is therefore also enforced by the orchestrator's check that the worktree is unchanged (it restores it if not).

### Supervised tasks and "Open in Cursor"
A task that has a worktree (`review`, `failed`, `awaiting_escalation`, `awaiting_plan`) can be opened for hands-on work:
- **Open in Cursor IDE** (`POST /api/tasks/:id/open-cursor {mode:"ide"}`): `cursor -n <path>` if the `cursor` shell command exists, else `open -a Cursor <path>`. `<path>` is the **service folder** inside the task's worktree (or the worktree root).
- **Open Cursor CLI in Terminal** (`{mode:"terminal"}`): Terminal.app via `osascript` running `cd <path> && agent --workspace <path> --model auto` (interactive session; `--model auto` explicit).
- Context and rules are written to `<worktree>/.cursor/rules/orch-context.mdc` (alwaysApply). That file is excluded from commits (commit pathspec + the repo's `.git/info/exclude`, which is shared by worktrees; this is a local, untracked change to the repo's `.git`).
- Opening sets the task flag **`supervised`**: the runner will not touch it, merge/escalation/plan approvals are refused, and the dashboard shows a SUPERVISED banner. **Release** (`POST /api/tasks/:id/release`) runs the check and commits whatever is in the worktree onto the task branch (then back to `review`/`failed` as usual). You still merge by hand-approving.
- **Manual one-time step for the IDE**: the Cursor IDE has no CLI flag to select Agent mode or the Auto model, and I deliberately do not edit Cursor's internal state DB/settings. In the IDE chat panel pick **Agent** and model **Auto** once; Cursor remembers it. The Terminal option does not need this.
- Interactive sessions are logged (kind `session`) but are **not** counted against the daily cap (they are not started or measured by the orchestrator).
- Testing status: the IDE/Terminal launch paths were tested in **dry-run** mode (`ORCH_OPEN_DRY_RUN=1`, which records the exact command instead of running it; the osascript source was compile-checked with `osacompile`). They were not launched live.

### Sequences (multi-service plans)
`Project panel -> sequences` (or `POST /api/projects/:id/groups`): an ordered list of steps (service, engine, prompt, optional files). Each step is a normal task (own branch, checks, review, approvals), `seq #g step n`. One **approve-start for the sequence** approves all steps; they run in order.
- Dependency **stack** (default): step n+1 is cut from step n's branch (`tasks.base_ref`) but only starts if step n **passed its checks** (status `review`). Its diff is shown against that base. Merge the steps **in order**; merging a later step also brings the earlier ones in.
- Dependency **merged**: step n+1 waits until step n is `done` (merged by you).
- If a step fails or is rejected, later steps are marked `failed: not run: previous step ...` (blocked), never silently skipped.
- Scheduler: **local tasks strictly one at a time**. Up to `ORCH_MAX_PARALLEL_CURSOR` (default 2) **Cursor** tasks run concurrently, never two in the same service (a task without a service owns the whole project) and each in its own worktree. A local and a Cursor task may overlap.

### Cheap fixes in this stage
- `model_used` records the model the Cursor stream reported (shown in the UI; `auto` shows what Cursor resolved or reports).
- An empty-template project's default check is now `git diff --check` (whitespace/conflict-marker check on the diff; built in, no shell needed) instead of `true`. A project whose check is literally `true` shows a warning.
- Advisory-review calls have their own cap `ORCH_CURSOR_REVIEW_DAILY_CAP` (default 10). The task cap (`ORCH_CURSOR_DAILY_CAP`) counts tasks + plans only. `/api/health` shows both.

### New environment variables
| Variable | Default | Meaning |
|---|---|---|
| `ORCH_CURSOR_REVIEW_DAILY_CAP` | `10` | daily cap for advisory reviews (separate from the task cap) |
| `ORCH_MAX_PARALLEL_CURSOR` | `2` | max concurrent Cursor tasks (different services/worktrees) |
| `ORCH_CONTEXT_DIR` | `<db dir>/context` | managed context files |
| `ORCH_CONTEXT_MAX_CHARS` | `12000` | bundle cap |
| `ORCH_ROUTER_MODEL`, `ORCH_ROUTER_API` | `<your-model>`, `openai` | router/memory model name and API (`openai` or `ollama`) |
| `ORCH_ROUTER_TIMEOUT_MS`, `ORCH_ROUTE_MIN_CONFIDENCE`, `ORCH_ROUTER_SERVICES_MAX_CHARS` | `120000`, `0.55`, `6000` | router limits |
| `ORCH_ROUTE_COMPLEX_ENGINE`, `ORCH_ROUTE_SIMPLE_ENGINE`, `ORCH_ROUTE_PLAN_FIRST`, `ORCH_ROUTE_APPLY` | `cursor`, `auto`, `1`, `suggest` | default routing policy (per-project override in Project panel -> settings) |
| `ORCH_MEMORY_PROPOSALS`, `ORCH_MEMORY_TIMEOUT_MS`, `ORCH_MEMORY_NUM_CTX` | `1`, `180000`, `8192` | memory proposals |
| `ORCH_CURSOR_IDE_BIN`, `ORCH_OSASCRIPT_BIN`, `ORCH_OPEN_DRY_RUN` | auto, `osascript`, `0` | Open in Cursor (dry-run records the command only) |

### New API endpoints
| Method + path | Effect |
|---|---|
| `GET/POST /api/projects/:id/services`, `POST .../services/detect`, `POST /api/services/:id/{update,archive,unarchive}` | services |
| `GET /api/projects/:id/context`, `POST .../context/{save,import,export,preview}` | context files |
| `POST /api/projects/:id/route` | router dry run |
| `POST /api/projects/:id/groups`, `GET /api/groups[?project_id=N]`, `GET /api/groups/:id`, `POST /api/groups/:id/{approve-start,reject}` | sequences |
| `GET /api/memory-proposals`, `POST /api/memory-proposals/:id/{update,approve,reject}` | memory proposals |
| `POST /api/tasks/:id/{reroute,approve-plan,reject-plan,open-cursor,release}` | routing / plan / supervised actions |
| `POST /api/tasks` (extended) | `service_id` (id/`auto`/none), `engine: "auto-route"`, `plan_first` |
| `POST /api/tasks/:id/approve-start` (extended) | optional overrides `service_id, engine, model, plan_first, allow_escalation, use_routing`; 409 while routing is still running |

### Migration v1 -> v2 -> v3
At startup, `user_version` < 3 triggers: a `VACUUM INTO` snapshot next to the DB (`pre-stage4-migration-*.db`, `pre-v3-migration-*.db`), then one transaction per step. v2 rebuilds `tasks`/`approvals`
(wider CHECKs: status `awaiting_plan`, approval stage `plan`) with foreign keys off, copies all rows, verifies counts + `foreign_key_check`, adds `services`, `memory_proposals` and the new task columns. v3 adds `supervised, group_id, step_no, base_ref` and `task_groups`. Existing tasks, events and approvals are preserved with their ids.

### Testing notes
Stage 4 was exercised on a throwaway instance (port 4311) with a stub `agent` (to avoid Pro usage) against a scratch repo `demo-multi` (services `auth`, `billing`) and the real local model for aider/router/memory.
Use `ORCH_CURSOR_BIN=<stub>`, `ORCH_OPEN_DRY_RUN=1`, `ORCH_OSASCRIPT_BIN=<stub>` on a separate `ORCH_DB`/`ORCH_LOG_DIR`/`ORCH_WORKTREES` to repeat.

## Known limitations

- No automatic retry; a failed task must be re-created as a new task.
- **Worktree and branch are kept on reject-merge, rejection and failure** (for inspection); only a successful merge removes the worktree. No cleanup endpoint - remove manually: `git worktree remove --force <path>` and `git branch -D ai/task-<id>` in the project repo. Branches are never deleted, even after merge.
- Local tasks run one at a time across all projects; up to `ORCH_MAX_PARALLEL_CURSOR` Cursor tasks run in parallel (see Sequences); no queue priorities.
- The 9B local model can ignore the prompt or return a file unchanged; aider uses edit format `whole`, so keep `files` small and prompts precise.
- A task only passes if the check command exits 0; the default `npm run build` proves it compiles, not that behaviour is correct. Review the diff.
- A merge conflict aborts the merge and leaves the task in `review`; resolving it is manual. Merges are refused while the project's working copy is dirty.
- Worktrees are cut from the committed default branch - uncommitted work in the project checkout is not seen by tasks.
- The Cursor cap counts local invocations, not real plan usage; Cursor `auto` model selection is Cursor's choice (the model the CLI reports is stored as `model_used`; with `auto` it may just say `Auto`).
- Escalated Cursor runs build on top of the failed local commit (kept in the branch history); the final diff includes both.
- Project delete removes records only (repos/worktrees/branches stay and are listed); a project's slug (worktree/context dir name) does not change on rename.
- The advisory-review and escalation-approve code paths were verified with a stub `agent` binary (to avoid spending Pro usage); only the plain `engine=cursor` task path has been exercised against the real Cursor CLI.
- The dashboard is exercised by `scripts/ui-smoke.sh` (headless Chrome over CDP, 25 steps against an isolated demo instance); it is not part of `npm test`.
- No authentication (localhost-only by design).
- Stage 4 limits: supervised/Open-in-Cursor needs an existing worktree; IDE Agent-mode/Auto model must be selected once by hand; IDE and Terminal launches were only dry-run tested; interactive sessions are not counted in the cap; a local and a Cursor task can overlap; memory drafting holds the runner slot briefly; the 9B router can misjudge difficulty on vague prompts (it is only a suggestion; check the routing card); the dashboard has no automated tests.
- The plan-first, sequence, parallel and supervised flows were verified with the stub agent; real Cursor was called once in stage 4 (`--mode plan`) to confirm the flags and reported model.
- **No atomic cross-repository merge**: every task is merged with its own approval; `stack` dependencies across repos are rejected.
- **Model downloads are disabled** (`ORCH_ALLOW_MODEL_PULL=0`); the pull/delete code is covered only by fake-server tests. Only roles `coding`, `routing`, `memory` have consumers today.
- Clone import supports https/ssh only (no credentials are stored; private repos need your own credential helper or ssh-agent); LAN hosts are allowed with a warning. A remote can back only one active service.
- Import jobs are in memory (forgotten on restart; a running clone is cleaned up by the startup sweep).
- Schema v5 (dropping the legacy columns) and API contract v5 are not done.
