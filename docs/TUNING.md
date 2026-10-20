# Local model tuning (branch `tune/local-models`)

This tuning comes from the 2026-10-20 failure review. Tasks #1-#31 were all v1, and 31 of 32 failed:
- 21 were cancelled while a thinking 9B model was slow.
- 7 stopped because aider auto-added 29-57 KB of files.
- 7 left empty "0 insertions" commits.
- 1 was a Cursor timeout on 14 files.
- 1 failed because its branch already existed.
- 3 had pinned paths ending in `;`.

## Ollama server (do this yourself; the orchestrator never restarts Ollama)

```sh
launchctl setenv OLLAMA_FLASH_ATTENTION 1
launchctl setenv OLLAMA_KV_CACHE_TYPE q8_0
launchctl setenv OLLAMA_MAX_LOADED_MODELS 1
# then quit and reopen the Ollama app, so it reads the new environment
osascript -e 'quit app "Ollama"' && sleep 3 && open -a Ollama
```

Verify: run `launchctl getenv OLLAMA_KV_CACHE_TYPE` (it should print `q8_0`). Then, during a local task, `ollama ps` should show one model, `100% GPU` and `CONTEXT 16384`.

RAM on a 16 GB M4 (estimate):
- Weights: ornith:9b is 5.6 GB, qwen2.5-coder:7b is 4.7 GB.
- KV cache at 16k with q8_0: about 1 GB (about 2 GB at f16).
- Compute buffers: about 0.5 GB.
- One model loaded uses about 7 GB, which leaves about 5 GB for macOS, Node, aider and Cursor.
- Two 9B models together would be 13 GB or more and would swap. That is why `OLLAMA_MAX_LOADED_MODELS=1` is set and the pipeline unloads on every switch.

## Changes

| # | Where | Old -> new | Why / failure it prevents | Verify |
|---|---|---|---|---|
| 1 | `lib/flow/roles.js` (new), `lib/models.js` | thinking from the stored role (`think:true`) -> `think:false` for every role unless `ORCH_AIDER_THINK=1` | 21 cancellations of slow thinking runs | `node --test test/m28-aider-think.test.js`; the settings yaml in `logs/aider-task-N.model-settings.yml` contains `think: false` |
| 2 | coder role | temp model default (0.6 / 1.0), no seed, num_predict 4096 -> temp 0.1, top_p 0.9, top_k 20, repeat_penalty 1.05, seed 42, num_predict 2048, num_ctx `ORCH_LOCAL_NUM_CTX` (16384) | reproducible edits; no output runaway | `test/m31-local-defaults.test.js` (M50) |
| 3 | planner role (`lib/flow/plan.js`) | no num_ctx (Ollama 4096 default, prompt silently cut) -> num_ctx 12288, num_predict 1536, seed 42; prompt capped at 31000 chars | truncated plan prompts | `test/m36-plan.test.js` |
| 4 | reader / repair / review / merge roles | n/a -> reader 8192/512; repair temp 0.3, seed 7 on the second model; review 12288/1024; env-merge num_ctx 16384 + seed | each role has explicit options (the reader is still regex-only, so its row is ready for a model) | M50 roles test |
| 5 | `config.js` `ORCH_LOCAL_MAX_REQUEST_CHARS` | 60000 -> derived `(num_ctx - num_predict - 1500) * 3.45`, which is 44000 | 60000 chars filled the whole 16k window with no room for a reply | M50 config test |
| 6 | `ORCH_LOCAL_NUM_CTX` (new env) | hard-coded 16384 -> env, 2048..32768 | one knob for window and cap | M50 config test |
| 7 | `ORCH_LOCAL_MAX_FILES` | 5 -> 3 | 4+ file runs were too big for one local pass | `test/m29-aider-request.test.js` |
| 8 | `ORCH_LOCAL_MAP_TOKENS(_WITH_FILES)` | 2048/1024 -> 1024/512 | frees about 1k tokens | m29 |
| 9 | `lib/aider-prep.js`, `ORCH_AIDER_PIN_ONLY` | mentioned files auto-added -> with pinned files, `/**` plus `!/pinned` in the run's ignore file. aider 0.86.2 has no `--no-auto-add`; checked against aider's own pathspec. v2 steps also pass `--map-tokens 0` | 7 "request too large" stops (#15-#21, #30) | m29 (M50 pin-only) |
| 10 | `lib/runner.js` commitIfChanged | committed mode-only or empty-file changes -> unstaged and logged. `.aider*` stays excluded | "3 files changed, 0 insertions" commits | `test/m31-empty-commit.test.js` |
| 11 | `lib/file-list.js`, `server.js`, `lib/db.js` | `"src/x.js;"` kept -> split on `; , \n`, trim quotes and punctuation, `./`; old rows are cleaned on read (the DB is not rewritten) | #30-#32 pinned paths matched nothing | `test/m50-file-list.test.js` |
| 12 | `lib/runner.js` branchPlan | "a branch named ai/task-N already exists" -> the task's own free branch is reused; a branch held by another worktree fails with that path | #1 | `test/m50-branch-reuse.test.js` |
| 13 | `lib/context.js` | shares summed to 1.3 -> at most 1 (BRIEF .25, RULES .25, ARCH .15, MAP .15, service brief .15 / notes .10, extra .20, MEMORY gets the rest). `RULES/ARCHITECTURE/MEMORY.brief.md` are read instead of the originals while they are as new as the original | RULES cut 69%, ARCH cut 86%, MEMORY starved | `test/m50-context-shares.test.js`; the context preview shows `truncated:false` |
| 14 | `lib/flow/pipeline.js`, `lib/flow/split.js` | a multi-file prompt went straight to the Cursor planner -> up to 3 files stay local; more than 3 become a pending stacked sequence of parts with at most 3 files each (`ORCH_V2_LOCAL_FAILS_BEFORE_CURSOR=0` restores the old routing) | #7 Cursor timeout on 14 files; Cursor use | `test/m33-multifile-route.test.js` |
| 15 | `lib/flow/policy.js`, `ORCH_V2_LOCAL_FAILS_BEFORE_CURSOR` (2) | soft reasons (files, diff_size, ...) jumped to Cursor -> attempt 1 ornith:9b (coder), attempt 2 qwen2.5-coder:7b (repair), then Cursor | Cursor use | `test/m38-policy.test.js` (M50) |
| 16 | `ORCH_V2_LOCAL_MODELS` | `ornith:9b,qwen3.5:9b` -> `ornith:9b,qwen2.5-coder:7b` (qwen3.5:9b stays installed as an option) | qwen2.5-coder:7b is a code model with no thinking, 1.9 GB smaller | `ollama list` |
| 17 | pipeline `switchModel` | unload only before local2 -> unload (keep_alive 0) on every model switch and before Cursor | two models resident on 16 GB | m38 (M50 switchModel) |

`ORCH_AIDER_EDIT_FORMAT` is unchanged. The auto choice is still `diff` for files of 4096 bytes or more and `whole` below that, and v2 steps always use `diff`.

## Context docs (swap-relook, `data/context/swap-relook/`)

New files sit next to the originals; none of the originals were edited:
- `RULES.brief.md`: about 2.6k chars (RULES.md is 15.5k).
- `ARCHITECTURE.brief.md`: about 2.5k chars (ARCHITECTURE.md is 17.4k).
- `MEMORY.brief.md`: about 2.9k chars. It is a merge of `data/context/.../MEMORY.md` (14.2k) and `~/Work/flipswap/services/MEMORY.md` (8k). The second is a strict subset of the first. The SHA-256 dumps and duplicated rules were dropped.

How the bundle picks them:
- It uses a brief while the brief's mtime is at least the original's.
- When a memory proposal is accepted, it appends to MEMORY.md, so the original wins again until you refresh MEMORY.brief.md.
- Caveat: the RULES and ARCHITECTURE briefs only take effect when the project has no `BRIEF.md` in its context dir. A non-empty `BRIEF.md` replaces RULES and ARCHITECTURE outright.

Not done:
- The RULES.md last line ("store the hash of the code in memory") is not in the brief. It made MEMORY.md grow by hash lists.

## Re-running the Book Genre feature on v2 (optional)

Task #32 already did this work, on its Cursor branch, approved without merge. To redo it locally, create a sequence (POST `/api/projects/:id/groups`, dependency `stack`) of these 4 parts, each engine `auto`, service api-seva, at most 3 pinned files:

1. `src/constants/book.js`, `src/models/product.model.js`, `src/validationSchemas/book.schema.js`: `BOOK_GENRE_CUSTOM='OTHER'`, `BOOK_SUBGENRE_MAX_LENGTH=100`, `book.subGenre`, write schemas.
2. `src/utils/book.util.js`, `src/services/book.service.js`, `tests/bookEdit.test.js`: `resolveBookGenreWrite`, create/bulk/edit persistence, partial-edit rules.
3. `src/services/bookCatalogue.service.js`, `src/utils/catalogueTextSearch.util.js`, `tests/bookCatalogueGenreCounts.test.js`: `OTHER` filter and count key, subGenre text weight 1.
4. `src/docs/openapi/bookPaths.js`, `README.md`, `tests/book.test.js`: OpenAPI and text-index docs.

If you paste the whole feature as one v2 task naming all of these files, it is now split this way automatically, in groups of 3.

## Verify end to end

1. `ORCH_DB=$(mktemp -d)/t.db npm test`
2. Restart the orchestrator yourself when convenient. The running server on 4310 still has the old code and env.
3. Run part 1 above and watch the events:
   - `pin-only run`
   - `tokens: ~N / num_ctx 16384; cap 44000`
   - settings showing `temperature: 0.1 ... seed: 42 ... think: false`
   - `unloaded ornith:9b` before any qwen2.5-coder attempt
