# Scope gate

The gate runs only when `ORCH_DECIDER=1`, after the reader has a file list and before the planner. With the flag off, v2 does not call it.

## Contract

`decide(state, questions)` returns `{ answers, confidence, backend }`.

| type | question | answer |
|---|---|---|
| `noul` | yes/no | `{ "p": 0.0-1.0 }` probability of yes |
| `choice` | one of `options` | `{ "choice": "...", "probs": { "option": 0.0-1.0 } }` |
| `score` | integer `min`..`max` | `{ "value": n, "p": 0.0-1.0 }` |

The scope gate asks one `noul` per candidate file (`in_scope:<path>`), one `choice` named `route` (`local-small`, `local-ornith`, `split`, `cursor`), and one `score` named `risk` (0..3). `state` is the task text plus each file and its one-line index summary.

Confidence of a label is `p` when the label is yes, `1 - p` when it is no, the chosen option's probability, or the score's `p`. A missing, non-object, out-of-range, or unlisted answer is invalid. The gate re-asks only those question ids once, naming the required JSON fields. If any are still invalid, the action is `invalid` and the task pauses at `awaiting_approval` with `routing_state` `gate`. A thrown gate error pauses the same way. Neither path calls Cursor.

`ORCH_DECIDER_ACT` (0.90) applies a valid label. From `ORCH_DECIDER_ASK` (0.60) up to that, the task pauses. Below that, a valid answer goes to Cursor and no local edit runs. Only a valid `route=cursor` in the act band, or that low-confidence escalation, sets the Cursor path. The coder may only change files the gate kept. Other paths are reverted and logged.

An ornith reply is capped at `ORCH_DECIDER_FALLBACK_CAP` (0.85), or the project setting `decider_fallback_cap`. That sits below the act band, so an ornith route asks instead of auto-acting. Laya answers stay raw.

`local-small` prefers `qwen2.5-coder`. `local-ornith` prefers `ornith`. `split`, and any non-cursor route with more files than `ORCH_LOCAL_MAX_FILES` (3), uses the existing split sequence in parts of at most 3. A valid `route=cursor` in the act band is the decider path to the Cursor planner. More than `ORCH_DECIDER_FILE_CAP` edit files (20, project setting `decider_file_cap`) may go to Cursor without asking. Two failed local attempts still escalate from `lib/flow/policy.js`. The cost router may move a route toward a cheaper local model. It does not promote `split` to `cursor` because of file count.

Approve scope with `POST /api/tasks/:id/approve-gate`. Escalate with `POST /api/tasks/:id/escalate-gate`.

Every follow-up (`iteration` > 1) asks one `noul`, `needs_code_change`, with the same Laya-then-ornith client, even when `ORCH_DECIDER` is off. A valid no is one local `ornith:9b` answer over the instruction, task events, lineage, and retrieved snippets. That path does not write the worktree, run the check, or commit. The task returns to `review` with the answer in the result. A valid yes uses the edit pipeline. An invalid or ask-band answer pauses. It does not call Cursor. The ornith cap applies here too, so an ornith follow-up classification asks.

Every call is a lineage `decision` node: each answer's value, confidence, backend, whether it was retried, and whether it was invalid. A route node carries `rule`: `decider`, `failed-attempts`, `file-cap`, or `manual`.

`GET /api/decider/status` reports `laya` when the sidecar health check passes, `ornith` when the sidecar is down and `ornith:9b` is installed, and `down` when neither is available. The payload includes the setup line when `import laya_mlx` fails. The sidebar badge shows Laya, ornith fallback, or down. Startup logs that status. It starts the sidecar only when `ORCH_DECIDER=1`.

## Backends

1. Laya sidecar, `tools/laya-sidecar/server.py`, `127.0.0.1` and `ORCH_LAYA_PORT` (4327). `GET /health`, `POST /decide` with `{ state, questions }`. It wraps `laya_mlx.load` and `predict`. `tools/laya-sidecar/setup.sh` only checks that the import works. It does not download weights.
2. `ornith:9b` through the local Ollama JSON chat, thinking off, if Laya's health check fails. The log says `backend: ornith`.
3. Empty slot for a hosted Jev client that speaks this same request. It is not implemented.

The sidecar is stopped before the coder loads an Ollama model unless `ORCH_LAYA_KEEP=1`.
