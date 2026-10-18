'use strict';
// Fake Ollama HTTP server for tests. Records every request. Never contacts the real Ollama.
const http = require('node:http');

function startFakeOllama(opts = {}) {
  const state = {
    version: '0.35.1',
    models: opts.models || [
      { name: 'ornith:9b', model: 'ornith:9b', size: 5630000000, digest: 'sha256:aaa', modified_at: '2026-01-01T00:00:00Z', details: { family: 'qwen35', parameter_size: '9B', quantization_level: 'Q4_K_M' }, capabilities: ['completion', 'tools', 'thinking'], context_length: 262144 },
      { name: 'deepseek-ocr:latest', model: 'deepseek-ocr:latest', size: 6690000000, digest: 'sha256:bbb', modified_at: '2026-01-01T00:00:00Z', details: { family: 'deepseek-ocr', parameter_size: '3B', quantization_level: 'Q8_0' }, capabilities: ['completion', 'vision'], context_length: 8192 },
    ],
    show: opts.show || {
      'ornith:9b': { parameters: 'temperature 0.6\ntop_k 20\ntop_p 0.95', template: '{{ .Prompt }}', details: { family: 'qwen35' }, model_info: { 'general.architecture': 'qwen35', 'general.parameter_count': 9000000000, 'qwen35.context_length': 262144, 'qwen35.block_count': 32, 'qwen35.full_attention_interval': 4, 'qwen35.embedding_length': 4096, 'qwen35.attention.head_count': 16, 'qwen35.attention.head_count_kv': 4, 'qwen35.attention.key_length': 256, 'qwen35.attention.value_length': 256 }, capabilities: ['completion', 'tools', 'thinking'], thinking: { values: ['low', 'medium', 'high'] } },
      'deepseek-ocr:latest': { parameters: '', details: { family: 'deepseek-ocr' }, model_info: { 'deepseek2.context_length': 8192 }, capabilities: ['completion', 'vision'] },
    },
    loaded: [],
    tagsMode: 'normal',        // normal | broken-json | 500 | oldversion (no capabilities/context_length)
    chatReply: null,           // (path, body) => string content; default = valid routing/memory JSON
    pullScript: null,          // array of NDJSON objects for /api/pull (or function)
    chatDelayMs: 0,
    streamScript: null,        // streaming /api/chat: array (or (body) => array) of NDJSON objects; specials: {__delay:ms} {__hang:true} {__close:true} (destroy the socket mid-stream)
    streamPromptTokens: 42,    // prompt_eval_count of the default final chunk
    streamAborts: 0,           // streams whose client went away before the final chunk (the abort reached the upstream socket)
    imageCalls: 0,
    streamsOpen: 0, streamsStarted: 0,
    requests: [],
    pullCalls: 0, deleteCalls: 0,
  };
  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { /* keep null */ }
      state.requests.push({ method: req.method, path: req.url, body });
      const u = req.url.split('?')[0];
      if (u === '/api/version') return json(res, 200, { version: state.version });
      if (u === '/api/tags') {
        if (state.tagsMode === 'broken-json') { res.writeHead(200); return res.end('{not json'); }
        if (state.tagsMode === '500') return json(res, 500, { error: 'boom' });
        let models = state.models;
        if (state.tagsMode === 'oldversion') models = models.map(({ capabilities, context_length, ...m }) => m);
        return json(res, 200, { models });
      }
      if (u === '/api/ps') return json(res, 200, { models: state.loaded });
      if (u === '/api/show') {
        const s = state.show[body && (body.model || body.name)];
        return s ? json(res, 200, s) : json(res, 404, { error: `model '${body && body.model}' not found` });
      }
      if (u === '/api/pull') {
        state.pullCalls++;
        const script = typeof state.pullScript === 'function' ? state.pullScript(body) : (state.pullScript || [{ status: 'pulling manifest' }, { status: 'pulling abc', digest: 'sha256:abc', total: 100, completed: 50 }, { status: 'pulling abc', digest: 'sha256:abc', total: 100, completed: 100 }, { status: 'success' }]);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        for (const line of script) {
          if (line && line.__delay) { await new Promise((r) => setTimeout(r, line.__delay)); continue; }
          if (line && line.__hang) { await new Promise((r) => req.on('close', r)); return; }
          if (res.destroyed) return;
          res.write(JSON.stringify(line) + '\n');
        }
        return res.end();
      }
      if (u === '/api/delete') { state.deleteCalls++; return json(res, 200, {}); }
      if (u === '/api/chat' && body && body.stream === true) {
        if ((body.messages || []).some((m) => Array.isArray(m.images) && m.images.length)) state.imageCalls++;
        state.streamsStarted++; state.streamsOpen++;
        res.on('close', () => { state.streamsOpen--; if (!res.writableFinished) state.streamAborts++; });
        const script = typeof state.streamScript === 'function' ? state.streamScript(body) : (state.streamScript || [
          ...(body.think ? [{ message: { role: 'assistant', content: '', thinking: 'Let me ' } }, { message: { role: 'assistant', content: '', thinking: 'think.' } }] : []),
          { message: { role: 'assistant', content: 'Hello' }, done: false }, { message: { role: 'assistant', content: ' world' }, done: false },
          { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: state.streamPromptTokens, eval_count: 2, load_duration: 5000000, total_duration: 9000000 }]);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        for (const line of script) {
          if (line && line.__delay) { await new Promise((r) => setTimeout(r, line.__delay)); continue; }
          if (line && line.__hang) { await new Promise((r) => res.on('close', r)); return; }
          if (line && line.__close) { await new Promise((r) => setTimeout(r, 40)); res.socket.destroy(); return; } // let earlier chunks flush first
          if (res.destroyed) return;
          res.write(JSON.stringify(line) + '\n');
        }
        return res.end();
      }
      if (u === '/api/chat' || u === '/v1/chat/completions') {
        if (state.chatDelayMs) await new Promise((r) => setTimeout(r, state.chatDelayMs));
        const user = ((body && body.messages) || []).map((m) => m.content).join('\n');
        let content;
        if (state.chatReply) content = state.chatReply(u, body, user);
        else if (/"notes"/.test(user) || /MEMORY/.test(user)) content = JSON.stringify({ notes: ['Changed the code via task (fake memory note about conventions).', 'Remember: keep fake tests deterministic.'] });
        else {
          const m = user.match(/one of (\[[^\]]*\])/);
          let names = []; try { names = JSON.parse(m ? m[1] : '[]'); } catch { /* ignore */ }
          content = JSON.stringify({ service: names[0] || null, confidence: 0.9, difficulty: 'simple', needs_thinking: false, reason: 'fake router' });
        }
        if (content === '__HTTP500__') return json(res, 500, { error: 'fake failure' });
        if (u === '/api/chat') return json(res, 200, { message: { role: 'assistant', content }, prompt_eval_count: 11, eval_count: 7 });
        return json(res, 200, { choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
      }
      json(res, 404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({ state, port, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }) });
  }));
}
module.exports = { startFakeOllama };
