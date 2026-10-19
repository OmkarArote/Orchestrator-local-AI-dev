#!/usr/bin/env node
'use strict';
// HTTP client for a running orchestrator. It never opens the database.
const http = require('node:http');

function usage() {
  console.error('usage:\n  orc do "<task>" --service <name> [--base <ref>] [--title <text>] [--check <cmd>]\n  orc status <id>\n  orc review <id>');
  process.exit(2);
}

function request(method, path, body) {
  const port = Number(process.env.ORCH_PORT || 4310);
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = {};
        try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text.slice(0, 300) }; }
        if (res.statusCode < 200 || res.statusCode >= 300) reject(new Error(json.error || `HTTP ${res.statusCode}`));
        else resolve(json);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, flags };
}

async function settle(id) {
  for (;;) {
    const t = await request('GET', `/api/tasks/${id}`);
    if (['review', 'failed', 'rejected', 'done'].includes(t.status)) return t;
    await sleep(400);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parse(rest);
  if (cmd === 'do') {
    const prompt = positional[0];
    if (!prompt || !flags.service) usage();
    const created = await request('POST', '/api/do', {
      prompt, service: flags.service, title: flags.title || prompt.slice(0, 200),
      base: flags.base, check_cmd: flags.check, files: flags.files ? flags.files.split(',') : undefined,
    });
    const t = await settle(created.id);
    console.log(JSON.stringify({ id: t.id, status: t.status, head_sha: t.head_sha || null, summary: t.result_summary || '' }));
    process.exit(t.status === 'review' || t.status === 'done' ? 0 : 1);
  }
  if (cmd === 'status' || cmd === 'review') {
    const id = positional[0];
    if (!id) usage();
    const t = await request('GET', `/api/tasks/${id}`);
    const line = { id: t.id, status: t.status, head_sha: t.head_sha || null, summary: t.result_summary || '' };
    if (cmd === 'review') line.lineage = await request('GET', `/api/tasks/${id}/lineage`);
    console.log(JSON.stringify(line));
    return;
  }
  usage();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
