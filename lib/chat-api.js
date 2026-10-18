'use strict';
// HTTP surface of the dashboard chat: /api/chat/* and /api/llm/info. server.js has already applied the Host/Origin/Content-Type gate.
//   GET  /api/conversations[?project_id=&archived=1]    POST /api/conversations {title?, project_id?, model?, options?, think?}
//   GET  /api/conversations/:id                         (with messages)
//   POST /api/conversations/:id/update {title?, model?, options?, think?, archived?}      POST .../:id/delete
//   POST /api/conversations/:id/messages {content, think?}   -> text/event-stream: meta, token*, thinking*, done | error
//   GET  /api/llm/info[?model=&num_ctx=]                     model card data (read-only)
// A POST cannot use EventSource, so the dashboard reads the stream with fetch(); aborting the fetch aborts the Ollama request.
const chat = require('./chat');
const models = require('./models');
const store = require('./db');

module.exports = function createChatApi({ sendJson, fail, readJson }) {
  function sse(req, res, handle) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); }); // 'close' on the RESPONSE: the request side ends as soon as the body was read
    const emit = (ev, data) => { if (!res.destroyed && !res.writableEnded) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); };
    const hb = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n'); }, 15000);
    return handle.run(emit, ac.signal).finally(() => { clearInterval(hb); handle.release(); if (!res.writableEnded && !res.destroyed) res.end(); });
  }

  return async function chatApi(req, res, url) {
    if (url.pathname === '/api/llm/info') {
      if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
      const numCtx = Number(url.searchParams.get('num_ctx'));
      const info = await models.llmInfo(url.searchParams.get('model') || null, { numCtx: Number.isInteger(numCtx) && numCtx > 0 ? numCtx : undefined });
      const local = store.localTasksRunning();
      return sendJson(res, 200, { ...info, chat_active: chat.activeStream(), gpu_shared: { local_tasks_running: local.map((t) => ({ id: t.id, title: t.title })), note: local.length ? 'a local coding task is running; chat and aider share one GPU/RAM budget and will slow each other down' : null } });
    }
    const m = url.pathname.match(/^\/api\/conversations(?:\/(\d+)(?:\/(update|delete|messages))?)?$/);
    if (!m) return fail(res, 404, 'unknown endpoint');
    const id = m[1] ? Number(m[1]) : null, act = m[2] || null;
    if (!id) {
      if (req.method === 'GET') return sendJson(res, 200, { conversations: chat.listConversations({ projectId: Number(url.searchParams.get('project_id')) || null, includeArchived: url.searchParams.get('archived') === '1' }), active: chat.activeStream() });
      if (req.method === 'POST') return sendJson(res, 201, await chat.createConversation(await readJson(req)));
      return fail(res, 405, 'method not allowed');
    }
    if (!act) {
      if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
      return sendJson(res, 200, chat.getConversation(id));
    }
    if (req.method !== 'POST') return fail(res, 405, 'POST only');
    const body = await readJson(req);
    if (act === 'update') return sendJson(res, 200, await chat.updateConversation(id, body));
    if (act === 'delete') return sendJson(res, 200, chat.deleteConversation(id));
    const handle = await chat.prepare(id, body); // 400/404/409 are plain JSON errors, before any SSE headers
    return sse(req, res, handle);
  };
};
