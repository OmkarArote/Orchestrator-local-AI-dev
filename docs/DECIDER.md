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

Confidence of a label is `p` when the label is yes, `1 - p` when it is no, the chosen option's probability, or the score's `p`. `ORCH_DECIDER_ACT` (0.90) applies the label. From `ORCH_DECIDER_ASK` (0.60) up to that, the task pauses at `awaiting_approval` with `routing_state` `gate`. Below that, the task goes to Cursor and no local edit runs. The coder may only change files the gate kept. Other paths are reverted and logged.

`local-small` prefers `qwen2.5-coder`. `local-ornith` prefers `ornith`. `split` uses the existing split sequence. Approve scope with `POST /api/tasks/:id/approve-gate`. Escalate with `POST /api/tasks/:id/escalate-gate`.

Every call is a lineage `decision` node: backend, probabilities, action.

## Backends

1. Laya sidecar, `tools/laya-sidecar/server.py`, `127.0.0.1` and `ORCH_LAYA_PORT` (4327). `GET /health`, `POST /decide` with `{ state, questions }`. It wraps `laya_mlx.load` and `predict`. `tools/laya-sidecar/setup.sh` only checks that the import works. It does not download weights.
2. `ornith:9b` through the local Ollama JSON chat, thinking off, if Laya's health check fails. The log says `backend: ornith`.
3. Empty slot for a hosted Jev client that speaks this same request. It is not implemented.

The sidecar is stopped before the coder loads an Ollama model unless `ORCH_LAYA_KEEP=1`.
