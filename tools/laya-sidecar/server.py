#!/usr/bin/env python3
"""Local Laya sidecar for the orchestrator scope gate.

Binds to 127.0.0.1 only. Does not download weights. Install Laya yourself, then run tools/laya-sidecar/setup.sh.
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("ORCH_LAYA_PORT", "4327"))
MODEL = os.environ.get("ORCH_LAYA_MODEL", "")

predictor = None
load_error = None


def load_model():
    global predictor, load_error
    try:
        import laya_mlx
        predictor = laya_mlx.load(MODEL) if MODEL else laya_mlx.load()
    except Exception as exc:
        load_error = str(exc)


def normalize(raw, questions):
    if isinstance(raw, dict) and isinstance(raw.get("answers"), dict):
        return {"answers": raw["answers"], "confidence": float(raw.get("confidence") or 0)}
    seq = raw if isinstance(raw, list) else []
    answers = {}
    for i, q in enumerate(questions or []):
        p = float(seq[i]) if i < len(seq) else 0.5
        kind = q.get("type")
        if kind == "noul":
            answers[q["id"]] = {"p": p}
        elif kind == "choice":
            options = q.get("options") or []
            choice = options[0] if options else None
            probs = {opt: (p if opt == choice else 0) for opt in options}
            answers[q["id"]] = {"choice": choice, "probs": probs}
        elif kind == "score":
            lo = int(q.get("min") or 0)
            hi = int(q.get("max") if q.get("max") is not None else lo)
            value = min(hi, max(lo, int(round(p * (hi - lo)))))
            answers[q["id"]] = {"value": value, "p": p}
    conf = min((a.get("p", 1) for a in answers.values()), default=0)
    return {"answers": answers, "confidence": conf}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def _send(self, code, obj):
        raw = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.split("?", 1)[0] != "/health":
            return self._send(404, {"ok": False})
        self._send(200 if predictor is not None else 503, {
            "ok": predictor is not None,
            "model_loaded": predictor is not None,
            "error": load_error,
        })

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/decide":
            return self._send(404, {"ok": False})
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return self._send(400, {"ok": False, "error": "invalid JSON"})
        if predictor is None:
            return self._send(503, {"ok": False, "error": load_error or "model not loaded"})
        state = body.get("state", "")
        questions = body.get("questions") or []
        try:
            if hasattr(predictor, "predict"):
                raw = predictor.predict(state, questions)
            else:
                import laya_mlx
                raw = laya_mlx.predict(predictor, state, questions)
        except Exception as exc:
            return self._send(500, {"ok": False, "error": str(exc)})
        out = normalize(raw, questions)
        out["backend"] = "laya"
        self._send(200, out)


def main():
    load_model()
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
