# Handoff for Cursor (or any other developer): media attachments, auto model choice, media roles, prompt optimiser, icons

Living document. **Update it at the end of every milestone** (state table, "Pending work", "Verified / NOT verified"). It is written for a developer (human or agent) who has *not* seen the earlier conversations. No personal paths, accounts or secrets belong in this file (the repository is public): paths are relative to the repository root, commands use `<placeholders>`.

Companion documents: [`docs/plans/t70-media-and-prompt-plan.md`](plans/t70-media-and-prompt-plan.md) (the approved plan with all research, verbatim), [`README.md`](../README.md) (user-facing reference, kept true by `test/m17-readme.test.js`), [`.cursor/rules/`](../.cursor/rules) (conventions that apply to you automatically).

---------------------------------------------------------------------------------------------------
## 1. Current state

| Item | Value |
|---|---|
| `main` (shipped) | M1-M5 + Final stage; **schema v5**; last code commit `c0f605c`; since then only documentation commits (this file, the plan copy, a README pointer) |
| **M6 (attachments foundation)** | **implemented and green, NOT merged**. Open pull request: <https://github.com/OmkarArote/Orchestrator-local-AI-dev/pull/1>. Branch **`wip/m6-attachments`**: code `966cefb`, README count `8ffd986`, then a merge of current `main` (`2d7a5e2`) because a fast-forward is impossible. Schema **v6** exists only there. See section 1a |
| Tests on `main` (`npm test`) | **356 tests, 356 pass, 0 fail, 0 skipped** (author machine; run once with `CI=1` and once without after the docs-only changes; 346-350 on a fresh clone or CI because private-fixture tests skip) |
| Tests on `wip/m6-attachments` | **399 tests, 399 pass, 0 fail, 0 skipped** (author machine). Re-measured 2026-10-19 once with `CI=1` and once without, both 399/399/0. The previous note recorded 3x each flavour on `966cefb`; those repeats were not re-run this session. +43 tests vs `main` |
| CI (GitHub Actions, ubuntu + macos) | `main` at `2d7a5e2` (docs only): **green on ubuntu and macos**. `wip/m6-attachments`: pull request #1 is open; the Actions run for `8ffd986` was **in progress** when this note was written, so the ubuntu and macos counts are **not recorded yet**. Do not merge until both are green and the maintainer confirms |
| Fresh clone / CI test counts differ from the author machine because the migration tests that need a private DB backup, and the live-Ollama test, skip there | |
| Runtime | Node >= 22.5, **zero npm dependencies** (`node:sqlite`, `node:test`, global `fetch`), vanilla ES-module UI, no build step |

### What is on `main` (M1-M5) and what is on the M6 branch

* **M1 Cursor usage counters** (schema v5): the old daily Cursor caps are gone; usage is counted per project/service (`GET /api/cursor/usage`). Cursor runs only after an approve-start / approve-plan / approve-escalation click.
* **M2 Chat** (`#/chat`): streamed, read-only conversations with the local Ollama model; model card; `ORCH_CHAT_NUM_CTX`.
* **M3 Mentions**: `@project` / `@service` pull in memory, docs and code (lexical retrieval from the git object database, read-only, redacted, budgeted by a per-mention ledger in `lib/chat-context.js`).
* **M4 Cursor rules per service**: opt-in, preview first, committed only on a review branch.
* **M5 Cross-repo features** (`#/features`): contract-first provider/consumer tasks, drift check, merge-order guard.
* **M6 Attachments foundation** (**branch `wip/m6-attachments` only, not on `main`**; **no UI, no extractors yet**):
  * `lib/sniff.js`: type decided from the bytes only (PNG/JPEG/GIF/WebP, PDF, DOCX/XLSX/PPTX/EPUB/ODF containers, WAV/MP3/OGG/FLAC/M4A/AIFF, MP4/MOV/WebM, UTF-8/UTF-16 text + CSV/TSV/JSON); executables, archives, scripts, SVG and unknown binaries rejected; zip classified from the central directory only (**never inflated**: <= 2000 entries, entry <= 20 MiB declared, total <= 100 MiB declared, ratio <= 100:1, no traversal/absolute names, no encryption, no nested archives, no zip64); images limited to 50 megapixels by declared dimensions.
  * `lib/attachments.js`: raw-bytes streaming receive (Content-Length required, per-kind caps, quota, 2 concurrent uploads, abort cleanup), content-addressed blobs `<ATTACH_DIR>/<sha[0:2]>/<sha256>` (0600/0700), dedupe, links (<= 8 per chat message, <= 20 per task, `to_cloud` flag default 0), GC + retention, `deriveText` (plain text/CSV/JSON only), and **`exposeFor()`**, the only way derived text reaches a model (wrapped as `<attachment ... trust="untrusted">`, escaped, redacted, injection-flagged, budgeted; for cloud/Cursor only links with `to_cloud = 1`).
  * `lib/attachments-api.js` + `server.js`: `POST /api/attachments` (raw bytes, `Content-Type: application/octet-stream`, header `X-Orch-Upload: 1`, optional `X-Filename`), list/get/raw (images only, `nosniff` + CSP sandbox)/derive/delete/gc, `GET /api/media/tools` (detect only). The JSON-only POST gate has exactly one exception (the upload path); Host/Origin checks still apply.
  * `lib/fsguard.js`: new **`removeOwnedFile(target, {root})`** (the only single-file delete; refuses symlinks, directories, anything outside the root).
  * `lib/media-tools.js`: detection of `tesseract`, poppler (`pdftotext`/`pdftoppm`), `ffmpeg`/`ffprobe`, `whisper-cli`, `textutil`, `swiftc`. **Nothing is spawned yet.**
  * `lib/db.js` v6: tables `attachments`, `attachment_links` (exactly one of message/task, `to_cloud`), `attachment_derivations` (cache, unique per attachment+kind+tool+model+params); `model_roles` CHECK widened by `image`, `video`, `audio`, `document` (the roles are **not** yet in `lib/models.js` `ROLES`, so the Models page and `test/m9-models.test.js` (9 roles) are unchanged).
  * Tests: `test/m18-attachments-api.test.js` (HTTP: sniff table, MIME/extension spoofing, gate, caps, image-dimension bombs, zip bombs, path traversal, dedupe, abort cleanup, raw hardening, quota), `test/m18-attachments-store.test.js` (links/caps/cascades, GC/retention/orphans/symlinks, model exposure), `test/m19-migration-v6.test.js` (real v5 DB from `test/fixtures/baseline-v5.tgz`, failure injection, rollback drill), additions to `m1-guards`, `m1-fsguard`, `m3-migration`, `m0-fixture-db`; helpers `test/helpers/media-fixtures.js`.

### 1a. State of the M6 branch (`wip/m6-attachments`)

* **Where**: branch `wip/m6-attachments`, pulled into [pull request #1](https://github.com/OmkarArote/Orchestrator-local-AI-dev/pull/1) (open, not merged). Code commit `966cefb` (parent `c0f605c`; message still says "local only, not pushed", which is stale), README count commit `8ffd986`, then a merge of `main` at `2d7a5e2`. A fast-forward onto `main` is impossible because `main` has the three documentation commits after `c0f605c`. `main` itself is not updated by this branch. The M6 files are: `config.js`, `lib/db.js` (v6), `lib/fsguard.js`, `server.js`, new `lib/attachments.js`, `lib/attachments-api.js`, `lib/sniff.js`, `lib/media-tools.js`, new tests `test/m18-attachments-api.test.js`, `test/m18-attachments-store.test.js`, `test/m19-migration-v6.test.js`, helper `test/helpers/media-fixtures.js`, fixture `test/fixtures/baseline-v5.tgz` (the v5 code at `c0f605c`, used to create real v5 databases and for the rollback drill), edits to `test/m0-fixture-db`, `test/m1-fsguard`, `test/m1-guards`, `test/m3-migration`, and README (attachment section, env table, API table, files table, schema v6 text, author-machine test count).
* **What passes (measured on the author machine)**: full suite **399 tests, 399 pass, 0 fail, 0 skipped**. Re-measured 2026-10-19 once with `CI=1` (`duration_ms` 38231) and once without (`duration_ms` 38203). The previous note on this file recorded 3x each flavour on `966cefb`; those extra repeats were not re-run this session. The baseline before M6 was 356. All pre-existing tests still pass; the only edits to old tests are the intended ones: schema version asserts 5 -> 6 (`m3-migration`, `m0-fixture-db`), the v4-code rollback drill now expects "schema v6 is newer", and new guard/fsguard cases. `m1-guards`, `m10-ui`, `m15-db-guard`, `m17-readme`, `m9-models` (9 roles) are green. The v5 -> v6 migration is covered by `m19-migration-v6` (real v5 DB, data preserved, backup `pre-v6-migration-*.db` has the v5 shape and row counts, failure injection `ORCH_TEST_FAIL_MIGRATION_V6=1` rolls back completely and a clean retry succeeds, idempotent re-open, brand-new DB at v6, rollback drill: v5 code refuses v6, restoring the backup boots v5 code). No test touched the live database or port 4310 (temp `ORCH_DB`, random ports).
* **What is incomplete / not done**:
  1. **CI result not recorded yet**: pull request #1 is open, so `.github/workflows/ci.yml` has a run. When this note was written the run for `8ffd986` was still in progress. Fill the ubuntu and macos pass/fail/skip counts into the table above and into the README `npm test` line only after that run finishes. Do not merge before both are green.
  2. **README author-machine count is updated** to 399 pass / 0 fail / 0 skipped (with and without `CI=1`). The fresh-clone/CI number is still unknown; the README says it is recorded after the pull-request run.
  3. **No UI** (no upload button, no attachment chips), **no extractors** (only plain text / CSV / JSON can be derived; PDF/Office/media answer 422 `unsupported`), **nothing consumes attachments yet** (chat M8, tasks M11). `media-tools.js` only detects tools, it spawns nothing.
  4. `model_roles` accepts `image`/`video`/`audio`/`document` in the DB, but `lib/models.js` `ROLES` is deliberately unchanged (M10).
  5. Not reviewed by the maintainer; the `X-Orch-Upload` carve-out in `server.js` and `fsguard.removeOwnedFile` are safety-sensitive and deserve a human review.
  6. Known limits: only Node's default `server.requestTimeout` (300 s) bounds very slow uploads (an aborted upload is cleaned up); JPEG EXIF is only flagged (`has_exif`), not parsed for GPS.
* **Exact next steps to land M6** (do these before M7). A fast-forward merge is **not** possible: `main` contains documentation commits that this branch did not have, so landing it is a merge commit through the pull request, after the maintainer confirms.
  ```bash
  # review (already re-checked on this branch): the JSON gate skips application/json only for
  # POST /api/attachments; Host and Origin still apply; the handler requires
  # application/octet-stream and X-Orch-Upload: 1. removeOwnedFile refuses symlinks,
  # directories, and anything whose real parent is outside the attachments root.
  # pull request (do not merge from an agent):
  # https://github.com/OmkarArote/Orchestrator-local-AI-dev/pull/1
  # wait until GitHub Actions is green on ubuntu AND macos, record those counts, then the maintainer merges.
  ```
  If the branch is not reachable from your clone, the same commit is available as a git bundle (`git bundle` of `main..wip/m6-attachments`) or a binary `git format-patch` (`git am`), kept by the maintainer next to the repository. As a last resort the M6 design is fully specified in the section above and in `docs/plans/t70-media-and-prompt-plan.md` (sections 2.2, 2.4, 2.5, 9, 11) and can be re-implemented.

### Approved defaults (decisions already made by the maintainer; do not re-ask)

1. **First vision model: `qwen3-vl:4b` family (3.30 GB)**, but **never pull or download anything from code**. The maintainer confirms downloads through the existing Models page flow (`ORCH_ALLOW_MODEL_PULL=1` + size confirmation). *See the P0 finding below: prefer the `-instruct` tag.*
2. **PDF text: support both poppler and the macOS PDFKit helper, prefer poppler when present.**
3. **Attachments to cloud / Cursor engines: off by default, with an explicit tick per attachment** (`attachment_links.to_cloud`).
4. **No Whisper install.** Audio is detect-and-degrade only (attachment kept, "transcriber not installed", the exact install commands are shown, never run).
5. Everything optional is **detect-and-degrade**: a missing tool/model is reported with the install command, never hidden behind a silent fallback, never installed by the app.

---------------------------------------------------------------------------------------------------
## 2. Pending work (in order)

Order: **land M6 (section 1a) -> M7 -> M8 -> M9 -> M10 -> M11 -> M12 -> M13 -> M14.** Estimates are judgment (focused dev-days incl. tests and review), not measurements. Every milestone ends with: full suite 3x with `CI=1` and 3x without (real numbers, capture the complete output of any failure), CI green on both OSes, README + this file + test counts updated, docs commit separate from code commits. Write a short plan and get approval first for anything that changes the schema, adds an endpoint family or touches fs/git safety (project rule).

### M7 Extractors (3 d)
* **Scope**: `lib/extract/{text,csv,zip-office,html,pdf,image}.js` + `lib/media-tools.js` becomes the **only spawner** of tesseract/ffmpeg/pdftotext/pdftoppm/whisper (via `lib/proc.js`, argv arrays, hard timeouts, output caps, scratch cwd, `nice`). Text (done in M6), CSV summary (header, row count, column types/min/max/top values, first N rows, never dump a big table), pure-Node ZIP/XML readers for docx/xlsx/pptx/odt/epub (`w:t`, `a:t`, shared strings, sheet cells; **`zlib.inflateRawSync(buf, {maxOutputLength})`**, entries read in memory by exact expected names, never extracted to disk), html (strip tags, drop script/style, never rendered), PDF text (poppler `pdftotext -layout` -> PDFKit helper -> low-fidelity pure-Node, labelled), scanned PDF/image OCR with tesseract + confidence (page cap, time cap), derivation cache in `attachment_derivations`, redaction + injection flag already provided by `exposeFor`. Replace `deriveText` with a dispatcher by kind/ext.
* **Files**: new `lib/extract/*.js`; edit `lib/media-tools.js`, `lib/attachments.js` (`deriveText` -> `derive`), `lib/attachments-api.js`, `test/m1-guards.test.js` (**add the extractor module to the "media tools are never executed" allow-list on purpose**), README (env vars for tool overrides if added: every new env var must be documented, `m17` enforces both directions).
* **Acceptance**: every supported kind yields derived text or a precise `unsupported`/`tool_missing` status (HTTP 422 with the install hint); hostile inputs (bombs, 100k-row CSV, encrypted docx, deeply nested XML) are bounded in time/memory; derived text is cached; nothing runs when a tool is absent; no new npm dependency.
* **Tests**: `m20-extractors` with docx/xlsx/pptx/csv/html fixtures **generated in the test** (`test/helpers/media-fixtures.js` has a zip builder); PDF/tesseract/ffmpeg tests **self-skip when the tool is absent** (CI runners may lack them, like the live-Ollama test); bomb/limit tests; a test that a failing tool leaves no scratch files; ensure `m1-guards` (no shell strings, no `spawnSync`) stays green.
* **Open questions**: tesseract extra languages (`brew info tesseract-lang`, large; ask before suggesting); where to cache the compiled PDFKit helper (`<ATTACH_DIR>/bin`, ~29 s one-time compile, macOS + Xcode CLT only).

### M8 Chat integration (2.5 d)
* **Scope**: composer attach button + drag-drop + paste image, chips (uploading -> ready -> derived N chars, remove, pin), `POST /api/conversations/:id/messages {content, attachments:[ids], pin_attachments?}`; a ledger layer `attachments` in `lib/chat-context.js` (default 40 % of `context_max_chars`) fed by `attachments.exposeFor({messageId})`; history replay keeps a one-line stub (`[attachment: name (kind): text omitted from history]`); the `context_json` manifest records id/name/kind/derivation/chars/truncated/redactions/flags; "Context used" collapsible gets an *Attachments* section; per-message limit 8 (already enforced by `link()`).
* **Files**: `lib/chat.js`, `lib/chat-api.js`, `lib/chat-context.js`, `public/js/chat.js` (+ new `public/js/attachments.js`), `public/js/ui.js`, `public/style.css`, `lib/attachments.js` (link on send), README.
* **Acceptance**: derived text is injected only on the attaching turn (or when pinned); never raw bytes/paths; budget respected; deleting a conversation cascades links; no `alert/confirm/prompt`, no `innerHTML` (UI rule, `m10-ui`).
* **Tests**: SSE test with the stub Ollama capturing the request (derived text present only on that turn, wrapped as untrusted, `images` absent without a vision model); UI smoke extended (`scripts/ui-smoke.js`); `m10-ui` lint.
* **Open questions**: none blocking (cap of 8 files per message and 20 MB images are approved defaults).

### M9 Auto selector (2.5 d)
* **Scope**: pure `lib/model-select.js` `selectModel({taskKind, needs, difficulty, installed, loaded, roles, prefs})` -> `{model, reason[], score_table, swap, fit, warnings, rule}` (algorithm in plan section 6: filter by installed + capability + fit + context; integer scoring: +40 strength match, +25 already loaded, +10 role/default, +5 small suffices, -10 tight, -(15+min(20, GB*2)) swap, -30 cannot co-reside while a task runs; tie-break smaller then name); async `models.resolve(role, ctx)` (keep sync `models.effective()` unchanged; `'auto'` is only a role/conversation value); catalog `strengths` + `capabilities_expected` and vision entries; record observed `load_ms` per model; chat "Auto" chip with reason/override/lock; task form `local model: default | auto | <installed>`.
* **Hard rules**: never `pull`; never selects a non-Ollama engine (cloud stays behind the existing `engine=auto|auto-route` + approval click); when a local task holds the GPU and the best choice would swap, answer `defer`; every resolution is written to the message manifest / task event.
* **Files**: new `lib/model-select.js`; edit `lib/models.js`, `lib/model-catalog.json`, `lib/chat.js`, `lib/runner.js` (`aiderModelArg` caller), `lib/router.js` (card text), `public/js/{chat,tasks,models}.js`, README.
* **Acceptance**: deterministic and explainable (same inputs -> same output + the score table); empty candidate set returns `none` with the exact missing capability and a download *suggestion* (never an action).
* **Tests**: `m21-select` table-driven; `m9-models` still green.
* **Open questions**: should `auto` also cover the background roles routing/memory? Approved default: **no** (fixed small-model jobs).

### M10 Media roles + vision (3 d)
* **Scope**: roles `image`, `video`, `audio`, `document` (mode Default | Auto | Explicit) added to `lib/models.js` `ROLES` (schema already allows them); role validation (`image`/`video` need the `vision` capability from `/api/show`; `document` needs `completion` and `context_length >= 8k`; `audio` is a **tool preset** (whisper binary + model file) not an Ollama model); Models page cards with fit / "swaps with X" (numbers in section 3 below); **`images` support in `ollama.chatStream` (adapter only: Ollama strings stay in `lib/ollama.js` + `config.js`)**; VLM derivation job (downscale to <= 768 px, metadata stripped, one VLM residency per message); `deepseek-ocr` / `qwen3-vl` paths.
* **Files**: `lib/models.js`, `lib/ollama.js`, `lib/model-catalog.json`, `lib/extract/image.js`, `public/js/models.js`, `test/helpers/fake-ollama.js` (log `images`, serve a `capabilities:['vision']` model), `test/m9-models.test.js` (9 -> 13 roles, intentionally), README.
* **Acceptance**: with no vision model installed, images degrade to tesseract text with an explicit notice; `too_large` fits are blocked, `tight` warned; a model is never pulled by code.
* **Tests**: role validation table, fake-Ollama vision request capture, degrade paths, `m9` updated.
* **Open questions (approved)**: first VLM `qwen3-vl:4b`-family (confirm tag, see P0); `deepseek-ocr` stays the OCR specialist.

### M11 Task attachments (2 d)
* **Scope**: New Task form attachments zone + `attachments_to_cloud` per-attachment tick (shown only for cloud engines), `ATTACHMENTS` part through `buildBundle({extraParts})` (last, capped share, `<attachment>` blocks) so aider and Cursor both get it with no engine change; task detail shows "sent to Cursor: yes/no"; attachments are **not** copied into the worktree; router card shows the auto model.
* **Files**: `lib/context.js`, `lib/runner.js`, `server.js` (task create validation), `lib/attachments.js`, `public/js/tasks.js`, README.
* **Acceptance**: for `cursor`/`auto`/`auto-route` engines derived text is included **only** for links with `to_cloud = 1`; local engines always get it; existing approve-start / plan-first / diff-review / approve-merge gates untouched.
* **Tests**: stub aider/agent capture of the bundle with and without the tick; cascade on task delete (already covered at store level).
* **Open questions (approved)**: cloud off by default, tick per attachment.

### M12 Audio + video (2.5 d)
* **Scope**: whisper.cpp adapter that is **detect-and-degrade only** (no install, no model download; `ORCH_WHISPER_MODEL` points at a user-provided ggml file), ffmpeg frame pipeline (<= 8-16 frames, scene-change + uniform, <= 768 px, metadata stripped; `-nostdin`, `-protocol_whitelist file`, fixed input path inside `ATTACH_DIR`, scratch cwd), audio extraction (`-vn -ac 1 -ar 16000`), jobs with progress/cancel, a "heavy media lane" serialised with the local-task lane, duration/size caps (audio 60 min, video 10 min).
* **Files**: new `lib/extract/{audio,video}.js`, `lib/media-tools.js`, `lib/jobs.js` (if not present, small), UI progress, README.
* **Acceptance**: with ffmpeg only, a video yields a frames-only timeline or metadata; with no whisper, speech is "transcriber not installed" and the attachment is kept; nothing is fetched by the app.
* **Tests**: ffmpeg tests self-skip when absent; a fake `whisper-cli` script as a stub tool; cancel and timeout cleanup.
* **Open questions (approved)**: no Whisper install.

### M13 Prompt optimiser (3 d, +1.5 d optional sidecar spike)
* **Scope**: in-house `lib/prompt-compact.js` (pure, unit-tested, ~300 lines): lossless hygiene (CRLF, blank-line runs, trailing spaces, consecutive duplicate lines, zero-width/control chars, cross-layer paragraph de-dupe, runs of `===`/box drawing, absurd single lines), boilerplate strip for prose only (licence headers, badges, TOC, "Generated by", repeated PDF page headers/footers; **never inside code fences**), structure-preserving shrink for CSV/JSON/logs, **BM25** chunk selection with provenance (`file:lines` / `page N`) and near-duplicate de-dupe, token calibration (EWMA of observed `prompt_eval_count / prompt_chars` in `settings_kv`, 3.5 cold default), prefix-stable layout (constant system prompt first, volatile question last), optional rolling conversation summary into the existing unused `chat_conversations.summary` (**off by default**, extra local call, "summary used" chip), and a tiny eval harness `scripts/prompt-eval.js` (golden cases -> prompt tokens / answer-contains rate / latency before-after; a compaction ships only if tokens drop and answers do not regress).
* **Files**: new `lib/prompt-compact.js`, `scripts/prompt-eval.js`; wire into `lib/chat-context.js`, `lib/context.js`, attachment derivations; README.
* **Acceptance**: idempotent; code fences byte-identical; golden before/after sizes recorded in the test; measured, not assumed, token savings.
* **Tests**: `m22-prompt-compact` (idempotence, code untouched, goldens), BM25 table tests.
* **Open questions**: LLMLingua-2 sidecar (Python + PyTorch, prose only, optional, separate go/no-go) - see the evaluation below; rolling summary default stays off.

### M14 Icons (0.5-1 d, lowest priority)
* **Scope**: `public/js/icons.js` exporting `icon(name, {size, title})` building inline `<svg>` with `createElementNS` (no `innerHTML`), ~30 icons copied from **Tabler (MIT)** (or Lucide: ISC + MIT notice for the Feather-derived subset); replace the Unicode glyphs (nav, `\u2601` cloud badges, status dots, close/edit, logo); `THIRD_PARTY_NOTICES.md` (copyright + licence per set, mentioned in README); `.ico svg { width: 1em; height: 1em; vertical-align: -0.125em }`.
* **Files**: `public/js/icons.js` (new), `public/js/{app,tasks,chat,ui}.js`, `public/index.html`, `public/style.css`, `THIRD_PARTY_NOTICES.md`, `test/m10-ui.test.js` (lint: no raw icon codepoints in nav; every `icon('x')` name exists), refreshed screenshots (`scripts/shot.sh`).
* **Tests**: `m10-ui` lint extended; UI smoke.
* **Open questions (approved)**: Tabler over Lucide; SVG *uploads* stay rejected.

---------------------------------------------------------------------------------------------------
## 3. Deep research summary (kept from the approved plan; sources and details are in `docs/plans/t70-media-and-prompt-plan.md`)

Legend: **[V]** verified by running/reading it on 2026-10-19, **[A]** assumed or from general knowledge. Re-check every [A] in the first step of the milestone that depends on it.

### 3.1 The author's machine (what exists, what is missing) [V]
* MacBook Air class, arm64, macOS 26.x, **16 GiB RAM**, ~29 GiB free disk, Ollama 0.35.1. Installed models: `ornith:9b` (5.6 GB, architecture qwen35, Q4_K_M, capabilities completion/tools/thinking, **no vision**) and `deepseek-ocr:latest` (6.7 GB, F16, 3.3B, capabilities completion + **vision**, ctx 8192). Nothing was loaded when checked.
* Present: **tesseract 5.5.2** (English + osd only; a rendered-text PNG was read correctly in 0.06 s), **ffmpeg/ffprobe 8.1.1** (no `drawtext`, no whisper filter; frame extraction `fps=1/2,scale=512:-1` and `-vn -ac 1 -ar 16000` wav extraction worked on a synthetic clip), **`textutil`** (extracts text from a hand-made DOCX), **`swiftc`** (a 6-line PDFKit `PDFDocument(url:).string` program compiled once in ~29 s and extracted a simple PDF in 0.5 s), `sips`, `unzip`, `uv`, `brew`, Python 3.14 + Pillow.
* **Missing**: poppler (`pdftotext`, `pdftoppm`), any Whisper (`whisper-cli`, `mlx_whisper`), any general-purpose vision model, extra tesseract languages, python libs (pypdf, fitz, docx, torch, transformers, llmlingua).
* Apple on-device speech reports `supportsOnDeviceRecognition == true` but needs a TCC permission prompt; use from a headless server process is **unproven**.

### 3.2 Dependency-free parsing feasibility
| Type | Pure Node (no dependency) | Needs an external tool |
|---|---|---|
| txt / md / json / code / log | yes | - |
| csv / tsv | yes (~60-line RFC-4180 parser + summary) | - |
| docx / pptx / xlsx / odt / epub | **yes**: zip central-directory reader + built-in `zlib` + regex/streaming XML (~200 lines) with the bomb limits above | `textutil` is a macOS-only fallback for docx |
| html | yes | - |
| **PDF (text layer)** | **not reliably** (Flate + font encodings/CID/ToUnicode); naive extraction only for simple PDFs | `pdftotext -layout` (poppler, preferred, portable) or the PDFKit helper (macOS only, ~29 s one-time compile) |
| scanned PDF | no | render pages (`pdftoppm -r 150 -png` or PDFKit) -> tesseract / VLM |
| image OCR | no | tesseract |
| image understanding | no | an Ollama VLM (a download the maintainer confirms) |
| audio | no | whisper.cpp + a ggml model file (optional) |
| video | no | ffmpeg + VLM (+ whisper for speech) |

### 3.3 Memory fit on 16 GiB (the code's own `fitClass`: `recommended` <= 35 % RAM = 6.01 GB, `tight` <= 60 % = 10.3 GB; weights only, KV cache and image tokens come on top [A])
| Model (registry size, read-only manifest GET) | GB | Class | Co-resides with `ornith:9b` (5.63 GB)? |
|---|---|---|---|
| qwen3-vl:2b | 1.89 | recommended | yes (7.5 GB) |
| granite3.2-vision:2b | 2.44 | recommended | yes |
| qwen2.5vl:3b | 3.20 | recommended | yes |
| **qwen3-vl:4b** | **3.30** | recommended | **yes (8.9 GB)** |
| gemma3:4b | 3.35 | recommended | yes |
| minicpm-v:8b | 5.47 | recommended | borderline (11.1 GB) |
| qwen2.5vl:7b | 5.97 | recommended (just) | borderline/no (11.6 GB) |
| qwen3-vl:8b | 6.14 | tight | no -> swap |
| **deepseek-ocr (installed)** | 6.69 | tight | **no -> swap (12.3 GB total)** |
| llama3.2-vision:11b | 7.82 | tight | no |
| gemma3:12b | 8.16 | tight | no |

Co-residence assumes ~2/3 of RAM (~11.4 GB) is GPU-usable on macOS [A, not verified]. **Load/swap times were never measured** (no models were loaded on the live Ollama); M9 records the `load_duration` Ollama already returns in its final chunk and shows "unknown (first load)" until then. Consequence: pull a <= 4 GB VLM first so image questions do not evict the chat model.

### 3.4 Prompt-optimiser package evaluation (stars/licences from GitHub/npm/PyPI/HF APIs on 2026-10-19; can change)
| Candidate | Licence | Verdict |
|---|---|---|
| LLMLingua / LongLLMLingua (microsoft) | MIT | Python + torch/transformers; output visibly garbles tokens (README sample "reanged", "sixlters") -> **unsafe for code and identifiers** |
| LLMLingua-2 (models `...bert-base-multilingual-cased-meetingbank` Apache-2.0, 177 M params; `...xlm-roberta-large-meetingbank` MIT, 559 M) | MIT / Apache-2.0 | best learned option, trained on meeting transcripts; **prose-only, optional Python sidecar behind a flag**; the JS port `@atjsh/llmlingua-2` needs npm deps (`@huggingface/transformers`, `@tensorflow/tfjs`, `js-tiktoken`) which breaks the zero-dependency rule |
| Selective Context (liyucheng09) | **no licence declared** | cannot be vendored -> reject |
| **context-compression-engine** (npm, zero deps) | **AGPL-3.0-only** | reject: incompatible with vendoring into an MIT project; ideas re-implemented in-house |
| TokenZero (npm) | MIT | has deps (`ignore`, `commander`, `picomatch`), whitespace-only -> reject as a dependency |
| winnow (GitHub only) | MIT | immature (0 stars) -> reject; ideas noted |
| promptfoo | MIT | an evaluation harness, not a compressor; optional **dev-time tool outside the repo**; in-repo we use a tiny harness (M13) |
| DSPy | MIT | needs many LLM calls + a dataset/metric; unsuitable for a 9B local model on 16 GB |
| Adala | Apache-2.0 | not relevant |

**Recommendation: an in-house deterministic compactor (M13) + better budgeting/selection (BM25), with an optional LLMLingua-2 sidecar for prose-only attachments as a separate later spike.** Nothing found is small, mature **and** safe for code.

### 3.5 Icon sets (licences read from the GitHub licence API / the Lucide LICENSE file)
**Tabler Icons: MIT** (single clean notice, recommended). **Lucide: ISC plus MIT for the Feather-derived subset** (both notices needed). Feather: MIT but inactive since 2025-03. Copy only the path data used and add `THIRD_PARTY_NOTICES.md`.

### 3.6 Security risks (and the controls M6 already ships)
* Hostile uploads: bytes-only sniffing, allowlist, executables/archives/SVG rejected, size caps while streaming, zip/image bombs bounded by declared sizes without inflating, hash-named blobs, sanitised display names, owner-only files, `removeOwnedFile`, no execution, no inline serving except re-validated images (`nosniff` + CSP sandbox).
* CSRF/DNS rebinding: Host/Origin gate kept; the raw upload needs `X-Orch-Upload: 1` (a custom header forces a CORS preflight that is never granted).
* **Prompt injection through documents (the real risk, especially for tasks that can edit files)**: derived text is wrapped as untrusted data, redacted, flagged by a heuristic scanner (a warning chip, not a guarantee), cloud/Cursor exposure is opt-in per attachment, existing approval/diff/merge gates stay. Residual risk is **not eliminated**.
* Parsers of hostile input (our zip/XML code, tesseract, ffmpeg, poppler, whisper): bound time/size/memory, argv arrays only, scratch cwd; no OS sandbox (`sandbox-exec` is deprecated and was **not evaluated**).
* ffmpeg hardening to apply in M12 [A, untested]: `-protocol_whitelist file`, `-nostdin`, fixed input path. Metadata (EXIF GPS, PDF info, Office core props) must not reach derived text; strip metadata from VLM copies.
* Derived text can contain PII the redactor does not recognise; attachments are stored unencrypted under `data/` like the DB.

### 3.7 Exact install commands (**to be run by the human only; the app and agents never run them**)
```bash
# documents: PDF text + page render (preferred PDF engine)
brew install poppler                       # pdftotext, pdftoppm
# more OCR languages (check size first; tessdata is large)
brew info tesseract-lang
# audio (optional; approved default is NOT installed)
brew install whisper.cpp                   # provides whisper-cli (formula 1.9.5 when checked)
curl -L -o <models-dir>/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin   # 142 MiB
#   alternatives (sizes from the model README): small-q5_1 181 MiB, large-v3-turbo-q5_0 547 MiB, large-v3-turbo-q8_0 834 MiB
# vision models (only after the app shows the verified size and the maintainer confirms; prefer the Models page flow)
ollama pull qwen3-vl:4b-instruct           # 3.3 GB (see P0 finding: the bare :4b tag is the THINKING variant)
ollama pull qwen3-vl:8b                    # 6.14 GB (tight; swaps with ornith:9b)
ollama pull gemma3:4b                      # 3.35 GB (alternative)
```

### 3.8 P0 spike findings (read-only, no downloads; these CHANGE the plan)
1. **`qwen3-vl:4b` is the *thinking* variant.** Its registry config blob has `renderer` and `parser` = `qwen3-vl-thinking`; `qwen3-vl:4b-thinking` and `qwen3-vl:4b-instruct` tags also exist and weigh the same 3.3 GB (`2b-instruct` 1.93 GB). A thinking model is slower and its reasoning output must be handled; for OCR/captioning prefer **`qwen3-vl:4b-instruct`** and let the maintainer decide. The catalog entry (M9/M10) should name the exact tag, not the family.
2. **The registry config blob carries no `capabilities` field** (only `model_format, model_family, model_families, model_type, file_type, renderer, parser, architecture, ...`). `model_type` reads `4.4B`/Q4_K_M for `qwen3-vl:4b`. So the `vision` capability can only be confirmed from `/api/show` **after** a pull, which the app already reads at runtime; the catalog `capabilities_expected` is a hint and a mismatch must show a warning (this stays on the NOT-verified list until a model is pulled).
3. Verified for M7: `zlib.inflateRawSync(buf, {maxOutputLength})` throws `ERR_BUFFER_TOO_LARGE` in ~58 ms for a 1029:1 bomb (200 MiB -> 200 KiB) without allocating the output (RSS stayed ~78 MB); the M6 zip reader deliberately never inflates.
4. Verified for M6: a loopback raw upload with sha256 hashing streamed 300 MiB in ~0.6-1.0 s; Node reports chunked bodies with no `Content-Length`, which M6 refuses (411) so the size is known before a byte is stored.

### 3.9 NOT verified (be skeptical)
* Ollama's real defaults on the author's machine (max loaded models, keep-alive, GPU-usable memory share), therefore whether two models truly co-reside; **model load/swap times**; KV/image-token memory cost per image.
* Which candidate tags actually advertise `vision` (only `deepseek-ocr` was checked locally); deepseek-ocr's quality for general photo Q&A; Ollama's `images` field behaviour in 0.35.1; aider/Cursor image handling with the local models.
* Apple Speech from a headless process; `sips` metadata stripping; `ffmpeg -protocol_whitelist` on crafted inputs; pure-Node JPEG-EXIF GPS detection (feasible, not written; M6 only flags `has_exif` from the APP1 marker); PDFKit helper on encrypted/huge/CID-font PDFs (tested on one simple generated PDF); `textutil` on malformed docx.
* LLMLingua-2: torch wheels for the Python in use, CPU latency and quality on the maintainer's prose, real compression ratios; the token savings of M13 (needs the harness on real contexts).
* Star/licence data are API snapshots; Lucide/Tabler per-icon files were not reviewed individually.
* All effort estimates.
* Whether the `brew install whisper.cpp` bottle uses Metal on this macOS (formula page lists Apple Silicon bottles; runtime not tested).
* M6 specifics not covered by a test: behaviour of the upload route behind a reverse proxy; very slow uploading clients (only Node's default `server.requestTimeout` of 300 s bounds them; an aborted upload is cleaned up); Windows (the project targets macOS/Linux).

---------------------------------------------------------------------------------------------------
## 4. Conventions and guardrails (read `.cursor/rules/*.mdc`, they load automatically)

* Rules: [`core.mdc`](../.cursor/rules/core.mdc) (always on), [`guards.mdc`](../.cursor/rules/guards.mdc), [`tests.mdc`](../.cursor/rules/tests.mdc), [`ui.mdc`](../.cursor/rules/ui.mdc).
* **Plan first** (a short written plan, then wait for approval) for schema/DB migrations, architecture changes, new endpoint families and anything touching git/fs safety.
* **Never claim a test, build or CI result you did not run.** Report real counts for both `CI=1 npm test` and `npm test`; capture the complete output of any failure before retrying; do not call something a flake unless it reproduced and you can say why.
* Zero npm dependencies; Node 22; no build step; UI is vanilla ES modules (no `alert/confirm/prompt`, no `innerHTML`, text via `textContent`).
* Safety invariants enforced by `test/m1-guards.test.js`: no shell-string exec / `execSync` / `spawnSync`; raw `git` only in `lib/proc.js` and `lib/safegit.js`; Ollama strings only in `lib/ollama.js` + `config.js`; deletes only through `lib/fsguard.js` (`removeOwnedDir`, `removeOwnedFile`); external media tools only from the extractor/tool module (add it to the allow-list consciously in M7).
* **Never touch the live database or the running server** (default port 4310). Tests use `ORCH_DB` in a temp dir and random ports; any code that loads `lib/db` outside `node server.js` must set `ORCH_DB` (the guard in `config.js` refuses otherwise). Do not read or print `.env*`.
* **Commit identity**: the repository has **no local git identity on purpose**; commit with the noreply identity via environment variables (exact variables in `core.mdc`), never a personal e-mail. Push over SSH normally, **never force**. Never push the local-only branches `private-history` and `backup-pre-squash-*`.
* Docs-only commits are separate from code commits. Small, logical commits.
* Tests must be portable: no assumption that `~/work` exists, no macOS-only tools required, tool-dependent tests self-skip (CI runs ubuntu + macos and may lack tesseract/ffmpeg/poppler). Fixture tests that need a private backup skip on other machines, which is why test counts differ.
* No installs, no model loads, no downloads from code or tests. Model pulls stay behind `ORCH_ALLOW_MODEL_PULL=1` + a size confirmation in the UI.
* Every new environment variable, route and `lib/`/`public/`/`test/` file named in the README must exist and be documented; `test/m17-readme.test.js` enforces this in both directions.
* On the Mac the shell has no `rg` and no `timeout` (use `perl`/`python3`); in zsh `echo =====` fails.

---------------------------------------------------------------------------------------------------
## 5. How to resume

```bash
git clone git@github.com:<owner>/Orchestrator-local-AI-dev.git && cd Orchestrator-local-AI-dev   # or: git pull --ff-only
git branch -r                             # look for origin/wip/m6-attachments (the unmerged M6 work)
git log --oneline -8                      # confirm the commit in the state table above
node --version                            # >= 22.5

# full suite (random ports, temp DB; touches nothing real). Run both flavours and report the real numbers:
CI=1 npm test
npm test
# one file / one milestone:
node --test test/m18-attachments-api.test.js test/m18-attachments-store.test.js test/m19-migration-v6.test.js   # only exist on wip/m6-attachments

# sanity checks before you start (should print nothing / be empty):
env | grep -E '^(ORCH_|CI=)'              # stray test variables from an earlier shell
echo "$HOME"                              # must be your real home, not a temp dir

# starting a disposable server to try the upload API by hand (never port 4310, never the real DB):
T=$(mktemp -d); ORCH_PORT=4399 ORCH_DB=$T/data/orch.db ORCH_LOG_DIR=$T/logs ORCH_WORKTREES=$T/wt node --no-warnings server.js &
curl -s -X POST -H 'Content-Type: application/octet-stream' -H 'X-Orch-Upload: 1' -H 'X-Filename: note.txt' --data-binary @README.md http://127.0.0.1:4399/api/attachments
curl -s http://127.0.0.1:4399/api/media/tools
kill %1

# commit (noreply identity; see core.mdc for the exact variable values) and push without force:
GIT_AUTHOR_NAME=<name> GIT_AUTHOR_EMAIL=<id>@users.noreply.github.com GIT_COMMITTER_NAME=<name> GIT_COMMITTER_EMAIL=<id>@users.noreply.github.com git commit -m "..."
git push origin main
```

After pushing, confirm the GitHub Actions run is green on **both** ubuntu and macos before declaring a milestone done, then update sections 1-3 of this file and the README test-count line.

Note: the `curl` example for the upload API only works on a checkout that contains M6 (`wip/m6-attachments` or later).
