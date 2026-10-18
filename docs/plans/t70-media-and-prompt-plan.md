# Orchestrator plan T70 — media attachments, "auto" model choice, media model roles, icons, prompt optimisation

> **Status update (2026-10-19):** this plan was APPROVED with the defaults in section 12. P0 (minimal spike) and M6 (attachments foundation) are implemented; M7-M14 are pending. See `docs/HANDOFF-CURSOR.md` for the current state and the resume instructions. The text below is the original analysis, kept verbatim except for personal paths. Corrections found later are listed in the handoff ("P0 findings"), not edited in here.

Original status: READ-ONLY ANALYSIS. Nothing was implemented, committed, pushed, installed or downloaded. No live DB / port 4310 touched.
Repo state analysed: this repository @ `c0f605c` (origin/main), schema v5, Node 22, zero npm deps.
Date of analysis: 2026-10-19 (Asia/Calcutta). Author of this document: Grok Bot (executor subagent) for the maintainer.

Legend: **[V]** = verified by me today (command output, file read, or fetched page). **[A]** = assumed / from general knowledge / not exercised here. Everything marked [A] must be re-checked in the milestone's first step.

---------------------------------------------------------------------------------------------------
## 0. TL;DR (decisions I recommend)

1. **Attachments** are a new first-class, content-addressed store (`data/attachments/`, sibling of the DB like `CONTEXT_DIR`), uploaded as a *raw octet-stream* (not JSON/base64: the JSON gate caps bodies at 1 MiB), sniffed by magic bytes, size-capped, never executed, never served inline except re-validated raster images. The model never sees the file; it sees **derived text** (OCR / extracted text / table summary / VLM caption / transcript) wrapped as untrusted `<attachment>` data, budgeted by the existing `chat-context` ledger. Needs **schema v6** (3 new tables + model-roles CHECK rebuild).
2. **Local tools already on this Mac [V]:** `tesseract 5.5.2` (eng only), `ffmpeg/ffprobe 8.1.1`, `sips`, `textutil`, `unzip`, `swiftc` (PDFKit works), Pillow, `uv`, Ollama 0.35.1 with `ornith:9b` (**no vision**) and `deepseek-ocr` (vision). **Missing [V]:** `pdftotext/pdftoppm` (poppler), any Whisper, any general VLM. So today: images → tesseract (works, tested) or deepseek-ocr; PDFs → need poppler (or my tested PDFKit helper); DOCX → `textutil` or pure-Node zip reader; audio/video-speech → needs `whisper.cpp` (not installed); video frames → ffmpeg (tested).
3. **"auto"** = a pure, deterministic, explainable selector `selectModel(taskKind, needs, installed, loaded, roles)` over *installed* models only. It never downloads, never picks Cursor (the existing `engine=auto` + approval click stays the only path to cloud), always shows "auto → X because …", always overridable. Swap cost on 16 GB is real (see §6.4): the selector prefers the already-loaded model and prefers a **small (≤ ~4 GB) vision model that can co-reside** with `ornith:9b`.
4. **Media roles** `image`, `video`, `audio`, `document`, each `Default | Auto | explicit`, stored in `model_roles` (v6 rebuild of the CHECK, same pattern as v5) plus a capability/size/fit pre-check. Audio's "model" is a *tool preset* (whisper.cpp model file), not an Ollama model — Ollama has no Whisper support [V: issue tracker + search], so audio is detect-and-degrade.
5. **Prompt optimisation:** the honest best option is an **in-house deterministic compactor + better budgeting** (dedupe, boilerplate strip, BM25 ranking, prefix-stable prompts, rolling summary, token calibration from real `prompt_eval_count`). No candidate package is both safe for *code* and compatible with "zero npm deps" (§8 has the licence/feasibility table; one popular zero-dep JS candidate is **AGPL-3.0** [V], LLMLingua-2 is MIT but Python+PyTorch and garbles identifiers). Optional, flagged **LLMLingua-2 sidecar for prose-only attachments** (transcripts, long documents) as a later spike.
6. **Icons:** replace the Unicode glyphs (▦ ☰ ⇄ ◇ ☁ ● ✎ ◈ ▣ ◐ ⚡ …) with a tiny in-repo `public/js/icons.js` (inline SVG built with `createElementNS`, ~30 icons copied from **Tabler (MIT)** or Lucide (ISC+MIT notice)) + `THIRD_PARTY_NOTICES.md`. Lowest priority, 0.5–1 day.

Recommended order: **M6 foundation → M7 extractors → M8 chat integration → M9 auto selector → M10 media roles + vision → M11 task integration → M12 audio/video → M13 prompt optimiser → M14 icons** (details §11). Realistic total ≈ 20–26 focused dev-days incl. tests/review gates (estimates are my judgment, not measured).

---------------------------------------------------------------------------------------------------
## 1. Verified environment facts (this Mac, today)

| Fact | Evidence |
|---|---|
| MacBook, arm64, macOS 26.6.2, RAM 17,179,869,184 B (16 GiB) | `sw_vers`, `uname -m`, `sysctl hw.memsize` [V] |
| Disk free on `/`: 29 GiB of 228 GiB | `df -h /` [V] |
| Ollama 0.35.1; installed: `ornith:9b` 5.6 GB (arch qwen35, Q4_K_M, caps: completion,tools,thinking; **no vision**), `deepseek-ocr:latest` 6.7 GB (arch deepseekocr, F16, 3.3B, caps: completion,**vision**, ctx 8192) | `ollama list`, `ollama show` [V] |
| `OLLAMA_MAX_LOADED_MODELS/KEEP_ALIVE/NUM_PARALLEL` not set in launchd env; `iogpu.wired_limit_mb = 0` (macOS default GPU wired limit) | `launchctl getenv`, `sysctl` [V]. What the defaults *are* for Ollama 0.35.1 / macOS 26 I did **not** verify [A] |
| Nothing loaded in Ollama right now | `GET /api/ps` → `{"models":[]}` [V] |
| tesseract 5.5.2 at `/opt/homebrew/bin`, languages: `eng, osd, snum` only. Rendered-text PNG → correct text in 0.06 s | run [V] |
| ffmpeg 8.1.1 / ffprobe at `/opt/homebrew/bin`. **No `drawtext`, no `whisper` filter** in this build. Synthetic 6 s h264+aac: frame extraction (`fps=1/2,scale=512:-1` → 3 jpgs) and `-vn -ac 1 -ar 16000` wav extraction both work | run [V] |
| `/usr/bin/textutil -convert txt -stdout x.docx` extracts text from a hand-made DOCX | run [V] |
| `swiftc` present; a 6-line PDFKit program (`PDFDocument(url:).string`) compiled in ~29 s once and extracted text from a cupsfilter-made PDF in 0.5 s cold | run [V]. macOS-only; needs Xcode CLT |
| Apple on-device speech: `SFSpeechRecognizer(en-US).supportsOnDeviceRecognition == true`, auth status `notDetermined` (needs a TCC prompt; CLI-only use unproven) | `swift -e` [V]; usable from our server: **not verified** [A] |
| `pdftotext`, `pdftoppm`, `whisper-cli`, `mlx_whisper`, `tesseract` extra langs: **absent**; python libs (pypdf, fitz, docx, torch, transformers, llmlingua): **absent**; `uv` 0.x and `brew` present | `command -v`, import test, `brew list` [V] |
| Python 3.14 (python.org framework) and Pillow 12.3 present | [V]. Whether torch/transformers have 3.14 wheels: **not verified** (`uv` can pin an older Python) |

Registry sizes (read-only manifest GET, nothing downloaded, fetched 2026-10-19) [V]:
`qwen3-vl:2b 1.89 GB`, `qwen3-vl:4b 3.30`, `qwen3-vl:8b 6.14`, `qwen2.5vl:3b 3.20`, `qwen2.5vl:7b 5.97`, `gemma3:4b 3.35` (2.50 + 0.85 projector), `gemma3:12b 8.16`, `llama3.2-vision:11b 7.82`, `minicpm-v:8b 5.47`, `moondream 1.74`, `granite3.2-vision:2b 2.44`, `llava:7b 4.73`, `deepseek-ocr 6.69`, `nomic-embed-text 0.27`. (`qwen3-vl` page confirms it is a vision-language family, needs Ollama ≥ 0.12.7, 256K ctx, OCR in 32 languages [V].) That these tags carry Ollama's `vision` capability flag was **not** checked for any model except deepseek-ocr [A]; the app already reads capabilities from `/api/show`, so the catalog must reconcile at runtime.

Existing code facts used below (all read in this session) [V]:
* `lib/models.js`: `ROLES` = 9 (coding, planning, requirements, review, debugging, documentation, routing, memory, chat); `effective(role)` is sync, DB-only; `validateRole` requires `completion` capability; `fitClass`: ≤35 % RAM `recommended` (≤ 6.01 GB), ≤60 % `tight` (≤ 10.3 GB), else `too_large`; catalog is `lib/model-catalog.json` (chat models only, no vision entries).
* `lib/db.js`: schema v5; `model_roles.role` has a **CHECK list** (`MODEL_ROLES_V5` incl. reserved `embedding`) → adding roles needs a table rebuild (as v5 did); `chat_messages` has no attachment columns; `chat_conversations.summary` exists but is **unused**; `task_artifacts` is feature-contract only.
* `lib/chat.js`: one stream at a time; budget = `num_ctx` − 2048 out reserve − system − 25 % history; `context_max_chars = available × 0.6 × 3.5` (≈ 29 k chars at 16 k ctx and short history, computed from the constants); `ollama.chatStream` sends `messages` with only `role/content` (no `images`).
* `lib/chat-context.js`: lexical retrieval, per-mention ledger, `<context source=…>` wrapping with `</context>` escaping, redaction via `repo-reader.redact`. `lib/context.js buildBundle({extraParts})` is the natural hook for task attachments.
* `lib/router.js`: `engine`/`service` can already be `auto` (router suggestion, human approval click for Cursor); `COMPLEX_RE` heuristics reusable.
* `server.js`: `readJson` caps bodies at **1 MiB**; the write gate requires `Content-Type: application/json` and a same-origin `Origin` (CSRF/rebinding defence); **no CSP header**; no existing upload code anywhere (`grep multipart|upload|images` → nothing) [V].
* `lib/fsguard.js`: the only recursive delete is `removeOwnedDir` (directories only); `m1-guards` forbids `unlink/rm` elsewhere in lib/server; `config.ownDirs()` lists directories services may never target.
* `lib/proc.js run()` is the only generic spawner; `m1-guards` forbids shell-string exec/`spawnSync`.
* UI: ~2 k lines of vanilla ES modules, no SVG or `innerHTML` anywhere; nav/status icons are Unicode escapes (`\u25A6 ▦, \u2630 ☰, \u21C4 ⇄, \u25C7 ◇, \u2601 ☁, \u25CF ●, \u270E ✎, \u25C8 ◈, \u25A3 ▣, \u25D0 ◐, \u00D7 ×`, logo `&#9889;` ⚡) [V].

---------------------------------------------------------------------------------------------------
## 2. Request 1 — upload media to tasks and chat + "auto" model

### 2.1 Current state
* No upload path exists (verified). Chat messages and tasks are text only (`content` ≤ 20 000 chars, `prompt` ≤ 20 000 chars). Chat can only use `@mentions` of registered projects/services/files.
* `auto` exists only for *engine* (`local|cursor|auto|auto-route`) and *service*. There is **no** model-level auto: chat uses conversation override → `chat` role → `coding` role; local tasks use the `coding` role via `aiderModelArg()`.

### 2.2 Proposed design — attachments

**Pipeline (same for chat and tasks):**
`upload (raw bytes → temp file, streamed, capped)` → `sniff (magic bytes, ignore client MIME/ext)` → `store content-addressed blob` → `row in attachments` → `derive on demand (extractor chosen by kind; cached in attachment_derivations)` → `derived text wrapped + redacted + budgeted` → `existing chat context / task bundle`.

**Why derived text, not raw media, goes to models:** the local coding/chat model (`ornith:9b`) has no vision [V]; Cursor/aider image support depends on a vision-capable model (aider documents image support only for vision-capable models [V: aider docs]); and text is auditable, cacheable, redactable and cheap. Raw images are sent to an Ollama VLM only via the `image` role (§3) and only when a vision model is selected.

**API (all under the existing host/origin gate):**
* `POST /api/attachments` — body = raw bytes; required headers `Content-Type: application/octet-stream`, `X-Orch-Upload: 1` (non-simple header ⇒ any cross-origin page needs a CORS preflight we never grant), `X-Filename: <percent-encoded display name>`, `Content-Length` (reject missing/oversized *before* reading). The JSON gate gets one narrow, explicit carve-out for exactly this path. Response `{id, kind, mime, size, sha256, meta, warnings}`. Rate limit: 1 concurrent upload.
* `GET /api/attachments/:id` — metadata + derivation status. `GET /api/attachments/:id/raw` — only for raster images (png/jpeg/gif/webp) with `Content-Type` from sniffing, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Content-Disposition: attachment` for everything else (preview only for images; audio/video preview via blob URL is optional later).
* `POST /api/attachments/:id/derive {kind?, role_override?}` — run/refresh a derivation (job with progress/cancel through `lib/jobs.js`), `GET …/derivations`.
* `DELETE`-style `POST /api/attachments/:id/delete` (only when unreferenced) and `POST /api/attachments/gc` (unreferenced + older than 24 h).
* Chat: `POST /api/conversations/:id/messages {content, attachments:[ids], model?:'auto'|name, pin_attachments?}`. Tasks: `POST /api/tasks {…, attachments:[ids], attachments_to_cloud: bool}`.
* `GET /api/media/tools` — detect-and-report: which of tesseract / ffmpeg / pdftotext / whisper-cli / PDFKit-helper exist + version + the exact install command to show the user.

**Chat semantics:** derived text is injected *only on the turn it is attached* (or when the user pins it), inside the context ledger as its own layer `attachments` with a fair share (default 40 % of `context_max_chars`; mentions keep the rest). History replay keeps only a one-line stub (`[attachment: report.pdf (document, 12 pages): text omitted from history]`), exactly like the manifest is never replayed today. The manifest (`context_json`) records per attachment: id, name, kind, derivation tool/model, chars used/truncated, redactions, warnings — the existing "Context used" collapsible UI can show it.

**Task semantics:** attachments appear as a `ATTACHMENTS` part through `buildBundle({extraParts})` (placed last, capped share, `<attachment …>` blocks) so aider (`--read bundleFile`) and Cursor (bundle in prompt) both get it with no engine change. **Privacy gate:** for engines that leave the Mac (`cursor`, `auto`, `auto-route`), derived text is included only if `attachments_to_cloud=true` was ticked for that attachment in the New Task form (default **off**), and the task detail shows "sent to Cursor: yes/no". Local-only tasks always get it. Attachment files are *not* copied into the worktree (nothing committed by accident); if an engine needs a file on disk, a read-only copy goes to a task-scoped scratch dir outside the repo.

### 2.3 Proposed design — "auto" (summary; full design in §6)
`model: 'auto'` becomes a legal value for the chat conversation model, the `coding` role (local task model), and the four new media roles. It resolves at *use time* (per message / per task start / per derivation) to a concrete installed model with a recorded reason. `effective(role)` stays synchronous and unchanged for existing consumers (it returns `{model:'auto', auto:true}`); a new async `models.resolve(role, ctx)` is what consumers call. The task form gains `local model: default | auto | <installed>`; engine `auto`/`auto-route` keep their current meaning and approval rules.

### 2.4 Files / DB impact
New: `lib/attachments.js` (store, sniff, limits, refs, GC), `lib/attachments-api.js`, `lib/extract/{text,csv,zip-office,pdf,image,audio,video}.js`, `lib/media-tools.js` (detect + the *only* spawner of tesseract/ffmpeg/pdftotext/whisper via `proc.run`, argv arrays, timeouts, output caps, scratch cwd), `lib/model-select.js`, `public/js/attachments.js` (+ edits in `chat.js`, `tasks.js`, `models.js`, `ui.js`, `style.css`). Edits: `server.js` (route + gate carve-out), `config.js` (`ATTACH_DIR`, limits, `ownDirs()`), `lib/fsguard.js` (new `removeOwnedFile`), `lib/chat.js` (attachments param, ledger layer, history stubs), `lib/chat-context.js` (layer helper), `lib/context.js`/`runner.js` (ATTACHMENTS part), `lib/db.js` (v6), `lib/models.js` (roles, resolve), `lib/model-catalog.json` (vision/ocr/audio entries + `strengths`), README.

**Schema v6 (additive + one tiny rebuild; backup-first `VACUUM INTO`, one transaction, FK check — identical discipline to v4/v5):**
```
attachments(id PK, sha256 TEXT NOT NULL, size INTEGER, mime TEXT, kind TEXT CHECK(kind IN('image','audio','video','document','text','data')),
            orig_name TEXT (display only), meta_json TEXT /* width,height,duration,pages,has_gps… */, status TEXT CHECK(status IN('ready','rejected')),
            created_at, UNIQUE(sha256))                       -- blob-level, deduplicated
attachment_links(id PK, attachment_id FK, message_id FK NULL REFERENCES chat_messages ON DELETE CASCADE, task_id FK NULL,
                 pinned INTEGER DEFAULT 0, to_cloud INTEGER DEFAULT 0, created_at,
                 CHECK((message_id IS NULL) <> (task_id IS NULL)))
attachment_derivations(id PK, attachment_id FK ON DELETE CASCADE, kind TEXT /*text|ocr|caption|transcript|frames|table*/, tool TEXT, model TEXT,
                       params_hash TEXT, text TEXT, chars INTEGER, truncated INTEGER, redactions INTEGER, status TEXT, error TEXT, ms INTEGER,
                       created_at, UNIQUE(attachment_id, kind, tool, model, params_hash))   -- cache: avoids re-running OCR/VLM = avoids model swaps
model_roles: rebuild with CHECK widened by 'image','video','audio','document'  (same as v5's modelRolesDdl pattern)
```
Alternative considered: keep media roles out of `model_roles` and store them in `settings_kv` (`media.role.image` …) → **no CHECK rebuild**, smaller migration risk; downside: two role stores. I recommend the rebuild for one uniform Models page, but the settings_kv route is the fallback if the migration tests get painful.
Optional `model_stats(model, last_load_ms, last_used_at)` (or a settings_kv JSON) fed from the `load_ms` already parsed from Ollama's final chunk, for swap-cost display.

### 2.5 Storage, limits, safety (all values configurable; proposed defaults)
* Location: `ATTACH_DIR = <dirname(ORCH_DB)>/attachments` (like `CONTEXT_DIR`), layout `ab/ab12…` by sha256; temp uploads in `ATTACH_DIR/tmp/<random>`; added to `config.ownDirs()` so a service can never target it; *DB guard unchanged* (new code gets the DB only via server or `ORCH_DB`).
* Deletion: a new **`fsguard.removeOwnedFile(target, {root})`** (refuses symlinks/dirs, requires realpath inside `ATTACH_DIR`, journaled like `fs_journal`). Required because `m1-guards` forbids `unlinkSync` anywhere but `lib/fsguard.js`. Scratch dirs use the existing `removeOwnedDir`.
* Limits (env-overridable): image 20 MB (and ≤ 50 megapixels from the header before decode), document 50 MB, audio 100 MB / 60 min, video 500 MB / 10 min, text 5 MB, ≤ 8 files per message, ≤ 20 per task, store quota 5 GB (disk currently 29 GiB free [V]), 1 concurrent upload. Stream to disk with a running byte counter; abort and delete the partial on overflow, on client abort and on timeout.
* **MIME sniffing** by magic bytes (PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF8, WEBP `RIFF….WEBP`, PDF `%PDF-`, ZIP `PK\x03\x04` → then read `[Content_Types].xml`/entry names to classify docx/xlsx/pptx/odt/epub, MP4/MOV `ftyp`, WebM/MKV `1A 45 DF A3`, MP3 `ID3`/`FF Fx`, WAV `RIFF….WAVE`, OGG `OggS`, FLAC `fLaC`, M4A `ftyp`), text heuristics (valid UTF-8/UTF-16 BOM, no NUL) for txt/md/csv/json/code. Client-sent MIME/extension is *display only*. **Allowlist**; reject executables, scripts-as-binary, archives (zip/tar/7z) that are not an Office/EPUB container, disk images, SVG (script-capable; allow later as text-only), HTML (text-only extraction, never rendered).
* **Never executed / never opened by an app that executes macros:** we never run, open, or `qlmanage`/`open` a file; Office files are parsed as ZIP+XML by our reader (macro `vbaProject.bin` ignored and flagged `has_macros`).
* **Path traversal:** stored name is the sha256, never the client name; `orig_name` is sanitised (strip path separators/control chars, ≤ 120 chars) and only ever rendered via `textContent`. ZIP entries are read in memory by exact expected names, never extracted to disk.
* **Zip/decompression bombs:** zip reader caps — ≤ 2 000 entries, per-entry ≤ 20 MB inflated, total ≤ 100 MB, ratio ≤ 100:1, `zlib.inflateRawSync(buf,{maxOutputLength})`, reject nested archives and entries with `..`/absolute names; PDF: page cap (e.g. 200), `-l`, wall-clock timeout, stdout cap; image: header-declared dimensions checked before decode; media: `ffprobe` first, duration/size caps, wall-clock timeouts, `nice`, output caps.
* **ffmpeg hardening [A, general knowledge, not tested here]:** since we only pass sniffed known containers, still pass `-protocol_whitelist file` (blocks crafted playlists/concat files that read other local files or URLs), `-nostdin`, fixed input path inside `ATTACH_DIR`, `cwd` = scratch dir.
* **Metadata leaks:** derived text never includes EXIF/PDF-info/Office core-props; stored original keeps them; UI shows `has_gps` / `author` warning chips (JPEG EXIF GPS presence is a ~40-line pure-Node check [A]); derived/downscaled copies for a VLM are produced with `ffmpeg -map_metadata -1` (works for stripping in general [A]; `sips` metadata behaviour **not verified**).
* **Prompt injection:** (1) all derived text is wrapped `<attachment id name kind derived_by>` inside the same untrusted-data header as `<context>`, with `</attachment>` escaping; system prompt already says context blocks are data; (2) `repo-reader.redact()` runs on derived text (secrets-like values counted in the manifest); (3) a heuristic scanner flags "ignore previous instructions", fake `system:`/tool-call markup, hidden-text signals (white-on-white can't be detected after OCR; PDF text layer ≠ visible text) as a **warning chip, not a guarantee**; (4) chat has no tools, so impact is limited to misleading answers; (5) **tasks are the real risk** (aider/Cursor can edit files and Cursor can run shell): mitigations = cloud opt-in gate, existing approve-start/plan-first/diff-review/approve-merge gates, ATTACHMENTS block labelled as data and placed after the task text, and README warning. Residual risk is **not eliminated**.
* **Retention:** attachments live while referenced (message/task); deleting a conversation cascades links; blobs with zero links are removed by GC after 24 h (`removeOwnedFile`); optional `ORCH_ATTACH_RETENTION_DAYS` (default 0 = keep); a Settings panel shows usage, per-attachment size and "delete unreferenced".

### 2.6 UI
Chat composer: paperclip button + drag-drop + paste image; chips under the textarea (icon, name, size, state: uploading → ready → derived N chars; ✕ remove; "pin"); model selector gets **Auto** at top (`auto → qwen3-vl:4b · image attached`); the existing "Context used" block gains an *Attachments* section. New Task form: attachments zone, `local model` select (default/auto/…), "allow derived text to go to Cursor" checkbox shown only for cloud engines.

---------------------------------------------------------------------------------------------------
## 3. Request 2 — media model roles (Image, Video, Audio, Documents), Default usable

### 3.1 Current state
* `ROLES` has no media roles; `CONSUMERS` lists only coding/routing/memory/chat as wired. `validateRole` insists on the `completion` capability and an *installed* Ollama model; the catalog has chat models only. The UI role editor (`public/js/models.js`) is generic over `ROLES`.
* Only `deepseek-ocr` is a vision model here [V]; no catalog entry or consumer exists for it. (The user said "existing vision/OCR role" — **there is no such role in the code**; only the model is installed.)

### 3.2 Proposed design
Each new role = `{mode: 'default'|'auto'|'explicit', model?, options?}` stored as one `model_roles` row (`model` = `'auto'` sentinel, an installed model name, or absent row = **Default**). Resolution (`models.resolve(role, ctx)`):
* **Default** → the role's built-in policy: `image`/`video` → the `chat`-effective model if it has `vision`, else the best installed vision model, else **tesseract-only degrade** (OCR text, no scene understanding) with an explicit "no vision model installed" notice; `document` → the chat-effective text model; `audio` → the detected transcriber (whisper-cli + chosen model file) else "unavailable".
* **Auto** → selector (§6) restricted to the role's required capability.
* **Explicit** → validated like today but with role-specific capability checks: `image`/`video` need `vision`; `document` needs `completion` and `context_length ≥ 8 k`; `audio` is validated as a **tool preset** (binary present + model file exists + size shown), not through `ollama.validName`.

| Role | What it controls | Extractor chain (cheap first) | Model used when |
|---|---|---|---|
| `image` | image captions / VQA / hard OCR | tesseract (no model, no swap) → VLM only if (a) question is not text-centric, or (b) tesseract confidence low | explicit/auto/default as above |
| `video` | per-frame captions | ffprobe → ≤ 8–16 frames (scene-change + uniform, ≤ 768 px, metadata stripped) → VLM per frame (default = `image` role's model) → timeline text; audio track → `audio` role | same VLM as image unless overridden |
| `audio` | transcription | ffmpeg → 16 kHz mono wav → `whisper-cli` (whisper.cpp) | tool preset; no Ollama model |
| `document` | reading/summarising long docs | text extraction (no model) → budgeted retrieval by BM25 (default) → optional map-reduce summary job with this model | long docs only; explicit "Summarise whole document" |

Document handling needs **no LLM** for extraction; the role only picks the model for summarise/QA over long text. This keeps the 16 GB constraint honest: most uploads cost zero model loads.

### 3.3 What is feasible dependency-free (explicit)
| Type | Dependency-free in pure Node | Needs external tool | Verdict |
|---|---|---|---|
| txt/md/json/code/log | yes (UTF-8/UTF-16 decode, cap) | – | v1 |
| csv/tsv | yes (RFC-4180 parser ~60 lines; summary = header, row count, column types/min/max/top values, first N rows — never dump 100k rows) | – | v1 |
| docx / pptx / xlsx / odt / epub | **yes**: ZIP central-directory reader + `zlib.inflateRawSync` (built-in) + regex/streaming XML for `w:t`/`a:t`/shared strings/sheet cells, with the bomb limits above (~200 lines) | `textutil` (verified for docx on this Mac) is a macOS-only fallback; no xlsx/pptx | v1 |
| html | yes (strip tags, drop script/style) | – | v1 |
| pdf (text layer) | **not reliably**: Flate streams + font encodings/CID maps/ToUnicode; a naive extractor works for simple PDFs only | `pdftotext -layout` (poppler, **not installed**) = robust & portable; or my tested PDFKit helper (macOS-only, needs `swiftc`, ~29 s one-time compile, cache binary under `ATTACH_DIR/bin`) | recommend poppler; PDFKit helper as zero-install macOS fallback; pure-Node heuristic only as last resort, labelled "low fidelity" |
| scanned pdf | no | render pages (`pdftoppm -r 150 -png`, or PDFKit page render) → tesseract / VLM | needs poppler or PDFKit; page cap + time cap |
| image OCR | no | `tesseract` (installed, eng only; extra langs via `brew install tesseract-lang` ≈ large, ask first) | v1 |
| image understanding | no | Ollama VLM | needs a downloaded vision model (confirmation) |
| audio | no | `whisper.cpp` (`whisper-cli`) + ggml model file | optional, detect-and-degrade |
| video | no | ffmpeg (installed) + VLM + whisper | optional |

### 3.4 Exact commands the user would have to run himself (I ran none of these)
```
# documents (PDF text + page render)
brew install poppler                                   # pdftotext, pdftoppm
# more OCR languages (check size first; tessdata is large)
brew info tesseract-lang
# audio
brew install whisper.cpp                               # formula "whisper.cpp" 1.9.5 [V: brew info], provides whisper-cli; MIT
curl -L -o <models-dir>/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin      # 142 MiB [V: model README]
#   better quality / multilingual alternatives (sizes from the model README [V]): small-q5_1 181 MiB, large-v3-turbo-q5_0 547 MiB, large-v3-turbo-q8_0 834 MiB
# vision models (each only after the app shows the verified size and he confirms; sizes [V] above)
ollama pull qwen3-vl:4b        # 3.30 GB  (recommended first candidate: small enough to co-reside with ornith:9b, see 6.4)
ollama pull qwen3-vl:8b        # 6.14 GB  (tight; swap with ornith)
ollama pull gemma3:4b          # 3.35 GB  (alternative)
```
The orchestrator itself never installs or downloads any of this. Model pulls stay behind `ORCH_ALLOW_MODEL_PULL=1` + size confirmation (existing flow); whisper model files are never fetched by the app — the Models page shows the command and size and a "re-detect" button.

### 3.5 Memory fit on 16 GB (using the code's own `fitClass`)
`recommended ≤ 6.01 GB`, `tight ≤ 10.3 GB` (35 % / 60 % of 17.18 GB). Weights only; KV cache and image tokens come on top [A].
| Model | Weights | Class | Co-resides with `ornith:9b` (5.63 GB)? (assumes ~2/3 of RAM ≈ 11.4 GB usable by the GPU [A, default not verified]) |
|---|---|---|---|
| qwen3-vl:2b | 1.89 | recommended | yes (7.5 GB total) |
| granite3.2-vision:2b | 2.44 | recommended | yes |
| qwen2.5vl:3b | 3.20 | recommended | yes |
| qwen3-vl:4b | 3.30 | recommended | yes (8.9 GB) |
| gemma3:4b | 3.35 | recommended | yes |
| minicpm-v:8b | 5.47 | recommended | borderline (11.1 GB) |
| qwen2.5vl:7b | 5.97 | recommended (just) | borderline/no (11.6 GB) |
| qwen3-vl:8b | 6.14 | tight | no → swap |
| deepseek-ocr (installed) | 6.69 | tight | no → swap (12.3 GB) |
| llama3.2-vision:11b | 7.82 | tight | no |
| gemma3:12b | 8.16 | tight | no |
The Models page must show per-role "fits / swaps with X" using these numbers, and the role editor blocks `too_large` and warns on `tight`.

### 3.6 Catalog / capability tags
Extend `model-catalog.json` entries with `capabilities_expected: ['vision'|'ocr'|'completion'|'tools'|'thinking'|'audio_in']` and `strengths: ['code','general','vision','ocr','reasoning','multilingual','long_context']` (curated, flagged "suggestions, not benchmarks" like today). Runtime truth comes from `/api/show`; a mismatch is shown as a warning. Add vision entries (names/sizes above). Add `kind: 'tool'` entries for whisper presets (informational, not pullable).

---------------------------------------------------------------------------------------------------
## 4. Request 3 — better icons (lowest priority)
Current [V]: Unicode glyphs in `NAV` (▦ ☰ ⇄ ◇ …), `☁ CURSOR` badges, `●` status dots, `✎`, `×`, `◐ Theme`, logo ⚡; they render differently per font/OS, have no consistent weight and no accessible names beyond text.
Plan: `public/js/icons.js` exporting `icon(name, {size=16, title})` that builds `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden>` via `createElementNS` + `path` elements from a small in-file map (≈30 icons: folder/projects, list-checks/tasks, git-merge or arrows/features, message-square/chat, cpu/models, cloud, paperclip, upload, image, file-text, table, music/mic, video, trash, pencil, x, check, alert, info, play, stop, refresh, sun/moon, sparkles for "auto"). No `innerHTML` (keeps the textContent-only rule). CSS: `.ico svg{width:1em;height:1em;vertical-align:-0.125em}`.
Licences [V]: **Tabler Icons — MIT** (GitHub licence API); **Lucide — ISC plus MIT for the Feather-derived subset** (its LICENSE lists them, including `check, x, plus, trash, upload, search, server, terminal, code, …`); Feather — MIT but last pushed 2025-03. Recommendation: **Tabler** (single clean MIT notice) or Lucide with both notices. Add `THIRD_PARTY_NOTICES.md` (copyright line + licence text per set) and mention it in README; copy only the path data we use.
Impact: `app.js NAV`, `tasks.js` engine badges/options (`\u2601`), `chat.js` KIND_ICON/status dots, `ui.js empty()`/modal close, `index.html` logo, `style.css`. Tests: `m10-ui` lint extended (no raw icon codepoints in nav, every `icon('x')` name exists in the map); screenshots refreshed (the README gallery has stale shots already). ≈ 0.5–1 day.

---------------------------------------------------------------------------------------------------
## 5. Request 4 — prompt optimisation for better context (see §8 for the package evaluation)

### 5.1 Current state (verified by reading code)
* Context is already budgeted and ledgered (`chat-context` shares: managed 25 %, docs 20 %, tree 7 %, code rest; `context_max_chars` from `num_ctx`); clipping is `slice` + marker, i.e. **truncation, not compaction**. History keeps the last turns that fit 25 % of `num_ctx`; older turns are dropped with no summary (`chat_conversations.summary` column exists, unused).
* Token estimate is a fixed 3.5 chars/token although the real `prompt_eval_count` is returned and shown after the fact.
* Retrieval is keyword overlap (no BM25/IDF). Task bundle `CONTEXT_MAX_CHARS = 12000` (~3 k tokens), RULES 40 % / ARCHITECTURE 20 % / MAP 25 % shares, MEMORY by relevance.
* The system prompt is a short constant and context is appended to the **system** message (volatile text early in the prompt ⇒ Ollama's prompt-prefix reuse can't help across turns [A: general KV-cache behaviour, not measured here]).

### 5.2 Recommended approach (low effort, high value, zero deps)
Build `lib/prompt-compact.js` (pure functions, unit-tested, ~300 lines) and wire it in three places (chat context, task bundle, attachment derivations):
1. **Lossless hygiene (always on):** normalise CRLF, collapse ≥ 3 blank lines, trim trailing spaces, drop identical consecutive lines, strip zero-width/control chars, de-dupe repeated paragraphs/blocks **across layers** (README intro vs docs vs managed files — the same text often appears twice), collapse long runs of box-drawing/`=== ---`, truncate absurd single lines (minified/base64/hashes) with a marker.
2. **Boilerplate strip (text/docs only, never inside code fences):** licence headers, badges, tables of contents, "Generated by" footers, nav menus from HTML extraction, repeated page headers/footers in PDFs (lines repeating on > 40 % of pages).
3. **Structure-preserving shrink for data:** CSV/JSON → schema + stats + sample rows; long logs → head/tail + de-duplicated error signatures with counts.
4. **Better selection instead of cutting:** replace keyword-overlap with a small **BM25** (IDF over the candidate chunks; ~60 lines), chunk by heading/page/function-window, include top-k with provenance (`file:lines` / `page N`); MMR-style de-dup of near-identical chunks.
5. **Budget accuracy:** calibrate `chars_per_token` per model from observed `prompt_eval_count / prompt_chars` (EWMA stored in `settings_kv`), keep 3.5 as the cold default; report the calibrated value in the manifest.
6. **Prefix-stable prompt layout:** constant system prompt first, then slowly-changing context, then volatile (question) last; keeps Ollama's prefix cache useful [A, to be measured via `prompt_eval_count`/`load_ms` before/after].
7. **Rolling conversation summary:** when history exceeds its share, ask the *same loaded chat model* (no swap) for a ≤ 200-token factual summary of dropped turns → store in the existing `chat_conversations.summary`; prepend as a data block. Off by default behind a setting, shows a "summary used" chip; costs one extra local call.
8. **Structured prompt templates** for the router/memory/review/summarise prompts (fixed field order, explicit output schema, few-shot only when measured useful) — mostly already true for the router.
9. **Tiny eval harness (in-house, no promptfoo):** `scripts/prompt-eval.js` over a golden set of (context, question, expected-substring) cases → records `prompt_tokens`, answer-contains rate, latency before/after each compaction step; compaction ships only if tokens drop ≥ X % and answers don't regress. Runs against the fake/stub Ollama in CI and against the real one manually.
**Expected effect:** hygiene+dedup+boilerplate typically reclaims a double-digit percentage on README/doc-heavy contexts [A, to be measured by the harness — I did not measure on his data]; BM25 + page/line provenance improves *relevance per token* more than raw compression does.

### 5.3 Optional sidecar (later spike, flagged): LLMLingua-2 for prose-only inputs
`ORCH_COMPRESSOR=llmlingua2` → a persistent Python sidecar launched via `uv run --python 3.12 --with llmlingua` in its own venv, listening on loopback or stdio; model `microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank` (177 M params, F32 ≈ 0.71 GB RAM, Apache-2.0 [V]) — **only** applied to transcripts / long prose attachments, **never** to code, instructions, tables or the user's own message; shows `compressed 41 % (origin→compressed tokens)` and a "view original" toggle; always optional, never required. Feasibility not verified here: torch wheels for the Python in use, CPU latency on M4, quality on non-meeting text. See §8.

---------------------------------------------------------------------------------------------------
## 6. "Auto" model selection — full design

### 6.1 Inputs / outputs
`selectModel({ taskKind, needs:{vision,audio,tools,thinking,minCtxTokens}, difficulty, installed[], loaded[], roles, prefs })` → `{ model, reason:[…], score_table:[{model,score,parts}], swap:{needed,from,to,est_ms|null}, fit, warnings[], rule }`.
`taskKind` ∈ `chat_text | code_edit | image_qa | image_ocr | doc_qa | audio_transcribe | video_summary`. `difficulty` reuses router heuristics (`COMPLEX_RE`, length, multi-service). Pure function; all I/O (installed, loaded via `/api/ps`, roles) is done by the caller, so it is unit-testable with table-driven cases.

### 6.2 Algorithm (deterministic)
1. **Filter**: installed only; required capabilities present (`vision` for image/video; `completion` otherwise; `tools` if the engine needs tool-calling); `fit != too_large`; `context_length ≥ needed`. Empty set ⇒ result `none` with the *reason and the exact missing capability* (e.g. "no installed model has `vision`; tesseract-only OCR will be used; candidates to download: qwen3-vl:4b 3.30 GB") — **never** a download, never a silent fallback to Cursor.
2. **Score** each candidate (integers, shown in the UI):
   `+40` strength match for the taskKind (catalog `strengths`, else name/capability heuristics: `coder` → code, `vision` → image, `ocr` → ocr, `thinking` + complex → reasoning),
   `+25` currently loaded (no swap), `+10` role-assigned or global default, `+5` when a smaller model suffices (difficulty simple),
   `−10` fit `tight` (only one model resident), `−(15 + min(20, size_GB×2))` if it requires a swap (observed `load_ms` replaces the heuristic once known), `−30` if it cannot co-reside and another model is loaded and a task is running.
   Tie-break: smaller weights, then name.
3. **Output** top-1 with human-readable reasons, plus the next 2 alternatives and their score deltas.
4. **Overrides**: explicit user choice always wins and is never "corrected"; a conversation-level "lock model" stops per-message re-selection; the chip is a dropdown (`Auto`, installed models, `Default`).
5. **Hard rules**: (a) never calls `pull`; (b) never selects a non-Ollama engine — cloud stays on the existing `engine=auto|auto-route` + escalation approval click; (c) when `localTasksRunning()` is non-empty and the best candidate would force a swap, the result is `defer` ("an aider task is using the GPU — will run after / switch anyway?"), consistent with the existing `gpu_shared` note; (d) every resolution is written to the message manifest / task event (`auto → model, reason, score table`).
6. **Cheap-first routing inside "auto"** (biggest practical win): text-centric image → tesseract (0.06 s, no model); PDF/DOCX/CSV → extraction (no model); only escalate to a VLM when needed. This is a *tool* decision made by the same explainable function (`taskKind=image_ocr` first, `image_qa` if OCR is empty/low-confidence or the question is visual).

### 6.3 Where it plugs in
chat (`resolveTurn`), local task start (`aiderModelArg()` caller in `runner.js`), media derivations (`image`/`video`/`document` roles), router suggestion card (shows "local model: auto → …" next to the engine policy). `models.effective()` and every existing test of it remain unchanged because `'auto'` is only a *role value*, resolved by the new async function.

### 6.4 Interplay with Ollama swap cost on 16 GB (quantified as far as verifiable)
* RAM 17.18 GB; `ornith:9b` 5.63 GB; `deepseek-ocr` 6.69 GB ⇒ both resident = 12.32 GB. If the GPU-usable share is the usual ~2/3 (≈ 11.4 GB) [A], they **cannot** co-reside ⇒ every image question that uses `deepseek-ocr` evicts the chat model, and the next text turn reloads it (two full loads per round trip). With a ≤ 4 GB VLM (`qwen3-vl:4b` 3.30 GB) both fit (8.93 GB) [A], so no swap — hence the recommendation to **pull a ≤ 4 GB VLM first and make it the default `image` model**, and the Models page "fits with" column.
* **Load time is not measured** (I deliberately did not load models on his live Ollama). Method: Ollama's final chunk already carries `load_duration`; `chat.js` forwards it as `load_ms`. M9 records last observed `load_ms` per model and shows "last load 7.2 s" and the estimated swap penalty; until then the UI says "unknown (first load)". Disk read speed is the bound; do not quote a number before it is measured.
* Mitigations: prefer already-loaded model; batch derivations (do all images of a message in one VLM residency); cache derivations (UNIQUE key) so re-asking never re-runs OCR/VLM; optional per-role `keep_alive` hint only if he asks (changes memory pressure; default untouched); serialise "heavy media lane" with the existing local-task lane (`llm.js` chain / `localTasksRunning`).
* Context cost of images: a VLM consumes image tokens (count depends on model and resolution [A]); downscale to ≤ 768 px long edge before sending and show the measured `prompt_tokens` afterwards.

---------------------------------------------------------------------------------------------------
## 7. Media handling matrix (what really works on his machine)
| Input | Works now with zero installs | Works after one install | Degrades to |
|---|---|---|---|
| text/markdown/code/json/csv | yes (pure Node) | – | – |
| docx/xlsx/pptx/odt | yes (pure-Node ZIP+XML; `textutil` as macOS fallback for docx) | – | "unsupported/encrypted" notice |
| PDF with text layer | yes via PDFKit helper (needs `swiftc` compile once, macOS-only) | `brew install poppler` (portable, best) | low-fidelity pure-Node text or "install poppler" |
| scanned PDF / image with text | tesseract (English) | `tesseract-lang` for others | VLM if installed |
| photo / diagram understanding | `deepseek-ocr` (installed; OCR-centric, general VQA quality **not verified** [A]) | `ollama pull qwen3-vl:4b` | tesseract text only + notice |
| audio | – (Apple Speech needs TCC, unproven) | `brew install whisper.cpp` + model file | "transcriber not installed" (attachment kept, no derivation) |
| video | frames via ffmpeg (verified) + captions if a VLM is installed | + whisper for speech | frames-only timeline or metadata-only |
Everything is **detect-and-degrade**: `GET /api/media/tools` reports each tool, version, and the command to install it; the UI never hides a missing capability behind a silent fallback.

---------------------------------------------------------------------------------------------------
## 8. Prompt-optimisation package evaluation (licences/stars from GitHub/npm/PyPI/HF APIs fetched 2026-10-19 [V])
| Candidate | Licence | Maturity | Runtime / deps | Fit for this repo |
|---|---|---|---|---|
| **LLMLingua / LongLLMLingua** (microsoft/LLMLingua) | MIT | 6.7 k★, pushed 2026-09; PyPI `llmlingua 0.2.2` (Apr 2024) | Python; requires `transformers, accelerate, torch, tiktoken, nltk, numpy`; original uses GPT-2/LLaMA-class scorer | Heavy; scorer LM competes for 16 GB; token-dropping output is visibly garbled (README sample "reanged", "sixlters") ⇒ **unsafe for code/identifiers** |
| **LLMLingua-2** (same repo; models `microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank` Apache-2.0, 177 M params; `…xlm-roberta-large-meetingbank` MIT, 559 M params ≈ 2.2 GB F32) | MIT / Apache-2.0 | models trained on meeting transcripts (MeetingBank) | torch+transformers; or `@atjsh/llmlingua-2` (JS port, MIT, 32★, v3.0.0) which needs `@huggingface/transformers`, `@tensorflow/tfjs`, `js-tiktoken` (npm deps ⇒ breaks the zero-dep promise) | Best of the learned options; **only for prose** (transcripts/docs), optional sidecar behind a flag |
| **Selective Context** (liyucheng09) | **none declared on GitHub (no licence ⇒ cannot vendor)** | 425★, last push 2024-02 | Python, GPT-2 | Reject |
| **context-compression-engine** (npm, zero deps, ESM, code-aware, reversible) | **AGPL-3.0-only** | 3★, created 2026-02 | pure TS | Reject: AGPL is incompatible with vendoring into an MIT project without relicensing; tiny community. Its *ideas* (verbatim code, dedupe, budget search) are reimplemented in-house |
| **TokenZero** (npm) | MIT | 1★, created 2026-05 | deps `ignore, commander, picomatch`; whitespace/structure only | Reject as dependency; ideas covered by §5.2.1–2 |
| **winnow** (GitHub only, not on npm) | MIT | 0★, created 2026-06 | zero runtime deps core; optional `typescript` peer | Reject (immature); ideas (reversible, prefix-aligned) noted |
| **promptfoo** | MIT | 26 k★, TS, very active | large Node dep tree (`npx`) | Evaluation harness, not a compressor; **dev-time optional tool outside the repo** if he wants it; in-repo we use the tiny harness §5.2.9 |
| **DSPy** | MIT | 38.7 k★, Python | needs many LLM calls + a metric/dataset; strong model advised | Not suitable for a 9B local model on 16 GB; skip |
| **Adala** | Apache-2.0 | 1.6 k★ | Python agent framework | Not relevant |
Vendoring option considered: copying a small MIT/Apache snippet with notice is legally fine but nothing found is small, mature **and** code-safe. **Honest conclusion: implement a small in-house compactor (§5.2); offer LLMLingua-2 as an optional, flagged Python sidecar for prose only.**

---------------------------------------------------------------------------------------------------
## 9. Test impact (verified by reading the tests)
* `test/m9-models.test.js`: asserts **9** roles (`Array(9)`), `all 9 roles are stored` → update to 13 and add per-role validation tests (vision capability, `auto` sentinel, tool-preset audio role).
* `test/m3-migration.test.js` and `test/m0-fixture-db.test.js`: assert `schemaVersion() === 5` ("schema v5 (via v4)", `out.v, 5`, brand-new DB at v5) → v6; add v5→v6 tests (backup-first, failure injection hook `ORCH_TEST_FAIL_MIGRATION_V6`, empty DB, roles rebuild preserves rows, rollback drill with a **baseline-v5.tgz** fixture added next to v3/v4). README says "schema v5" in several places (fixed by `m17-readme` once updated).
* `test/m1-guards.test.js`: add guards — external binaries (`tesseract|ffmpeg|ffprobe|pdftotext|pdftoppm|whisper`) spawned only in `lib/media-tools.js`; no `unlink*`/`rm*` outside `fsguard` (new `removeOwnedFile`); no `child_process` string/shell exec (existing rule keeps holding); uploads handler only in `lib/attachments-api.js`; no write path under `ATTACH_DIR` outside `lib/attachments.js`.
* `test/m1-fsguard.test.js`: tests for `removeOwnedFile` (symlink refused, outside-root refused, directory refused).
* `test/m10-ui.test.js`: modules still free of `alert/confirm/prompt`; add "no `innerHTML`" and icon-name lint; `scripts/ui-smoke.js` extended (attach chip, auto chip, roles cards).
* `test/m15-db-guard.test.js`: unaffected, but every new helper/script that loads `lib/db` must set `ORCH_DB`; new tests use `startServer` temp DB + a **new** temp `ORCH_ATTACH_DIR`.
* `test/m17-readme.test.js`: README must document new env vars (`ORCH_ATTACH_DIR`, `ORCH_UPLOAD_MAX_MB`…, `ORCH_ATTACH_QUOTA_GB`, `ORCH_COMPRESSOR`, `ORCH_WHISPER_MODEL`, tool path overrides), routes and files (the test enforces both directions).
* New suites: `m18-attachments` (sniffing table, limits, abort cleanup, traversal names, dedupe, GC, zip bombs with generated fixtures, magic-byte spoofing), `m19-extractors` (docx/xlsx/pptx/csv fixtures generated in-test; PDF/tesseract/ffmpeg tests **skip when the tool is absent**, like the Ollama-live test), `m20-select` (table-driven auto selector), `m21-prompt-compact` (idempotence, code fences untouched, golden before/after sizes), `m22-chat-attachments` (SSE with stub Ollama capturing the request: derived text present only on the attaching turn; `images` only when a vision model is selected).
* Fake Ollama in `test/helpers` needs `images` in the request log and a `capabilities:['vision']` model. README test count updated to the real number at that time (current: 356 locally / 346–350 fresh clone).
* CI (ubuntu+macos): tool-dependent tests must self-skip; no network; no model downloads.

---------------------------------------------------------------------------------------------------
## 10. Security summary / residual risks
Covered above (sniffing, limits, hash-named blobs, no execution, zip/PDF/image/media bombs, ffmpeg protocol whitelist, metadata, prompt injection, cloud opt-in, retention). Residual and honest: (1) injection via documents can still mislead a chat answer and, for tasks, bias an editing agent — gates reduce but do not remove this; (2) parsers (our zip/XML code, tesseract, ffmpeg, poppler, whisper) process hostile input — we bound time/size/memory and run with argv arrays in a scratch cwd, but cannot sandbox beyond what macOS gives a normal user process (`sandbox-exec` is deprecated; **not evaluated**); (3) derived text can contain PII the redactor doesn't recognise; (4) local attachments are stored unencrypted under `data/` (same as DB today); (5) `X-Orch-Upload` CSRF defence relies on the existing Host/Origin checks — covered by new tests (bad Origin, wrong content type, missing header ⇒ 403/415).

---------------------------------------------------------------------------------------------------
## 11. Milestones (estimates = my judgment of focused dev-days incl. tests + review gates; not measured)
| # | Milestone | Scope | Est. |
|---|---|---|---|
| P0 | Spike (before M6) | measure `load_ms` of deepseek-ocr/ornith swap on his Mac, tesseract/PDFKit/textutil quality on 5 of his real files, decide poppler vs PDFKit; confirm vision capability flags of candidate models via registry `show` once he chooses to pull one | 0.5 d |
| M6 | Attachment foundation | schema v6 (attachments, links, derivations, roles CHECK widened), `ATTACH_DIR`, upload endpoint + gate carve-out, sniffing, limits, hash store, `removeOwnedFile`, GC, tools status API, tests incl. v5→v6 migration + baseline-v5 fixture | 3 d |
| M7 | Extractors | text, csv summary, pure-Node ZIP/XML (docx/xlsx/pptx/odt/epub) with bomb limits, html, PDF (poppler → PDFKit helper → low-fi), tesseract OCR with confidence, derivation cache + redaction + injection flag, `media-tools.js` spawner | 3 d |
| M8 | Chat integration | composer attach/drag/paste, chips, ledger layer + budgeting, history stubs, manifest + "Context used" section, pin/unpin, SSE tests, UI smoke | 2.5 d |
| M9 | Auto selector | `model-select.js` + `models.resolve`, catalog `strengths/capabilities_expected`, vision catalog entries, `load_ms` stats, chat "Auto" chip with reasons/override/lock, task form `local model` select, tests | 2.5 d |
| M10 | Media roles + vision | roles `image/video/audio/document` (Default/Auto/Explicit), role validation (vision cap, tool preset), Models page cards + fit/"swaps with", `images` support in `ollama.chatStream` (adapter-only), VLM derivation job, deepseek-ocr/qwen3-vl paths, fake-Ollama tests | 3 d |
| M11 | Task integration | New Task attachments, ATTACHMENTS bundle part, cloud opt-in gate + task-detail disclosure, stub aider/agent tests, router card shows auto model | 2 d |
| M12 | Audio + video | whisper.cpp adapter (detect/degrade), ffmpeg frame/audio pipelines, jobs with progress/cancel, heavy-media lane vs local-task lane, limits | 2.5 d |
| M13 | Prompt optimiser | `prompt-compact.js`, BM25, token calibration, prefix-stable layout, rolling summary (flag), eval harness, wiring in chat/bundle/attachments; optional LLMLingua-2 sidecar spike (+1.5 d, separate go/no-go) | 3 d (+1.5) |
| M14 | Icons | `icons.js`, replace glyphs, notices file, lint test, new screenshots | 0.5–1 d |
Total ≈ 22–25 d (+1.5 optional). **Recommended order:** P0 → M6 → M7 → M8 → M9 → M10 → M11 → M12 → M13 → M14. M6–M8 deliver the visible win (attach docs/images to chat with OCR/extraction, zero model downloads); M9–M10 add "auto" and vision once he has chosen/pulled a VLM; M12 is the most optional. Each milestone keeps the existing gate: full suite 3× CI=1 + 3× non-CI green, CI green on both OS, README/test-count/env-table kept true by `m17`.

---------------------------------------------------------------------------------------------------
## 12. Open questions (with proposed defaults)
1. Which vision model first? **Default: `qwen3-vl:4b` (3.30 GB) after he confirms the size**; keep `deepseek-ocr` as OCR specialist.
2. PDF engine: **poppler via `brew install poppler`** (portable, recommended) vs zero-install PDFKit helper (macOS-only). Default: support both, prefer poppler when present.
3. Cloud engines and attachments: **default off per attachment** (explicit tick). OK?
4. Audio: install whisper.cpp + `ggml-base.en` (142 MiB)? Default: not installed; feature shows "not installed" until he decides.
5. Size limits above acceptable (image 20 MB, doc 50 MB, audio 100 MB, video 500 MB, 5 GB store)?
6. Retention default: keep until owner deleted + GC of unreferenced after 24 h. OK?
7. Rolling summary on by default? **Default off** (extra local call).
8. Should `auto` also apply to the existing background roles (routing/memory)? Default: **no** (they are fixed small-model jobs); only chat, coding, media roles.
9. Icons: Tabler (single MIT) vs Lucide (ISC+MIT). Default: Tabler.
10. Allow SVG uploads as text-only? Default: reject in v1.
11. Whether the Models page may *offer* (not run) the exact install commands for tools — default yes, copy-to-clipboard only.

---------------------------------------------------------------------------------------------------
## 13. What I could NOT verify (be skeptical of these)
* Ollama's actual defaults on this machine: max loaded models, keep-alive, GPU-usable memory share, and therefore whether two models truly co-reside; **model load/swap times** (I did not load any model); KV/image-token memory cost per image.
* Which candidate Ollama tags actually advertise the `vision` capability (only `deepseek-ocr` checked locally; `qwen3-vl` is documented as vision-language on its page); quality of `deepseek-ocr` for general photo Q&A (it is OCR-oriented; not tested); Ollama's `images` field behaviour in 0.35.1 (documented API, not exercised); aider/Cursor image handling with our local models.
* Apple Speech from a headless server process (permission/TCC), `sips` metadata stripping, `ffmpeg -protocol_whitelist` behaviour on crafted inputs, pure-Node JPEG-EXIF GPS detection (feasible, not written), PDF behaviour of the PDFKit helper on encrypted/huge/CID-font PDFs (tested on one simple generated PDF only), textutil on malformed docx.
* LLMLingua-2: torch wheel availability for Python 3.14 (`uv` can pin another Python), CPU latency/quality on his prose, real compression ratios; the claimed token savings of §5.2 (needs the harness on his real contexts).
* Star/licence data come from API fetches dated 2026-10-19 and can change; whether Lucide's/Tabler's per-icon SVGs need only the notices (I read Lucide's LICENSE; I did not review each icon file).
* The effort estimates in §11.
* Whether the macOS `brew install whisper.cpp` bottle includes Metal in his macOS 26.6.2 (formula page lists tahoe/Apple Silicon bottles [V]; runtime not tested).
* Nothing in this plan was implemented or run against the repo; all file/line claims were read at `c0f605c`.
