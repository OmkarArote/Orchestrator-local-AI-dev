'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-m12av-'));
process.env.ORCH_DB = path.join(root, 'o.db');
process.env.ORCH_LOG_DIR = path.join(root, 'logs');
process.env.ORCH_WORKTREES = path.join(root, 'wt');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const media = require('../lib/media-tools');
const audio = require('../lib/extract/audio');
const bin = path.join(root, 'bin');
fs.mkdirSync(bin, { mode: 0o700 });
const prevPath = process.env.PATH;
const prevModel = process.env.ORCH_WHISPER_MODEL;

function script(name, body) {
  const p = path.join(bin, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

after(() => {
  process.env.PATH = prevPath;
  if (prevModel === undefined) delete process.env.ORCH_WHISPER_MODEL; else process.env.ORCH_WHISPER_MODEL = prevModel;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('M12 audio extractor', () => {
  it('says the transcriber is not installed and leaves no scratch files', async (t) => {
    if (!media.detect().ffmpeg.found) return t.skip('ffmpeg absent');
    const wav = path.join(root, 'tiny.wav');
    execFileSync('ffmpeg', ['-nostdin', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.2', wav], { stdio: 'ignore' });
    delete process.env.ORCH_WHISPER_MODEL;
    const scratch = path.join(root, 'scratch1');
    const r = await audio.extract(wav, { scratchParent: scratch, root });
    assert.equal(r.status, 'tool_missing');
    assert.match(r.reason, /transcriber not installed/);
    assert.equal(fs.existsSync(scratch) ? fs.readdirSync(scratch).length : 0, 0);
  });

  it('reads a fake whisper-cli and cleans up after a timeout', async (t) => {
    if (!media.detect().ffmpeg.found) return t.skip('ffmpeg absent');
    script('whisper-cli', '#!/bin/sh\nif [ "$1" = "sleep" ]; then sleep 30; else echo "transcript-ok"; fi\n');
    process.env.PATH = `${bin}${path.delimiter}${prevPath}`;
    process.env.ORCH_WHISPER_MODEL = path.join(root, 'model.bin');
    fs.writeFileSync(process.env.ORCH_WHISPER_MODEL, 'not-a-real-model');
    const wav = path.join(root, 'tiny.wav');
    if (!fs.existsSync(wav)) execFileSync('ffmpeg', ['-nostdin', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.2', wav], { stdio: 'ignore' });
    const ok = await audio.extract(wav, { scratchParent: path.join(root, 'scratch2'), root, timeoutMs: 10000 });
    assert.equal(ok.status, 'ok');
    assert.match(ok.text, /transcript-ok/);
    fs.writeFileSync(path.join(bin, 'whisper-cli'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const scratch = path.join(root, 'scratch3');
    const hung = await audio.extract(wav, { scratchParent: scratch, root, timeoutMs: 400 });
    assert.equal(hung.status, 'error');
    assert.match(hung.reason, /timeout/);
    assert.equal(fs.existsSync(scratch) ? fs.readdirSync(scratch).length : 0, 0);
  });
});
