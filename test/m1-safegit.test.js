'use strict';
require('./helpers/temp-env');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sg = require('../lib/safegit');

describe('M1 safegit: remote URL validation', () => {
  const ACCEPT = [
    ['https://github.com/octocat/Hello-World.git', 'github.com/octocat/hello-world'],
    ['https://github.com/octocat/Hello-World', 'github.com/octocat/hello-world'],
    ['https://GitHub.com/Octocat/Hello-World.git/', 'github.com/octocat/hello-world'],
    ['https://gitlab.com/group/sub/group/repo.git', 'gitlab.com/group/sub/group/repo'],
    ['https://example.com:8443/a/b.git', 'example.com:8443/a/b'],
    ['https://example.com:443/a/b', 'example.com/a/b'],
    ['https://git.example.org/~user/repo.git', 'git.example.org/~user/repo'],
    ['https://example.com/a/b+c_d.e-f', 'example.com/a/b+c_d.e-f'],
    ['https://example.com/a@b/c', 'example.com/a@b/c'],
    ['https://192.168.1.10/a/b.git', '192.168.1.10/a/b', true],
    ['https://10.0.0.5:3000/a/b', '10.0.0.5:3000/a/b', true],
    ['https://localhost/a/b', 'localhost/a/b', true],
    ['https://gitlab.corp/a/b', 'gitlab.corp/a/b', true],
    ['https://myserver/a/b', 'myserver/a/b', true],
    ['git@github.com:octocat/Hello-World.git', 'github.com/octocat/hello-world'],
    ['git@github.com:octocat/Hello-World', 'github.com/octocat/hello-world'],
    ['git@gitlab.com:group/sub/repo.git', 'gitlab.com/group/sub/repo'],
    ['ssh://git@github.com/octocat/Hello-World.git', 'github.com/octocat/hello-world'],
    ['ssh://git@github.com:22/octocat/Hello-World.git', 'github.com/octocat/hello-world'],
    ['ssh://git@example.com:2222/a/b.git', 'example.com:2222/a/b'],
    ['deploy@git.example.com:team/repo.git', 'git.example.com/team/repo'],
    ['git@192.168.0.2:team/repo.git', '192.168.0.2/team/repo', true],
    ['  https://github.com/a/b  ', 'github.com/a/b'],
  ];
  for (const [u, norm, lan] of ACCEPT) {
    it(`accepts ${JSON.stringify(u)}`, () => {
      const r = sg.parseRemote(u);
      assert.equal(r.normalized, norm);
      assert.equal(!!r.lan, !!lan);
      if (lan) assert.ok(r.warnings.length > 0);
    });
  }
  const REJECT = [
    ['http://github.com/a/b', /http/], ['git://github.com/a/b', /not allowed/], ['file:///etc/passwd', /not allowed/], ['file:///tmp/repo', /not allowed/],
    ['ftp://host/a/b', /not allowed/], ['ext::sh -c id', /./], ['ext::sh-c-id', /transport helpers/], ['fd::3', /transport helpers/], ['EXT::sh', /transport helpers/],
    ['-oProxyCommand=touch /tmp/x', /'-'/], ['--upload-pack=evil', /'-'/], ['-c', /'-'/],
    ['https://user:pass@github.com/a/b', /credentials/], ['https://token@github.com/a/b', /credentials/], ['https://:pw@github.com/a/b', /credentials/],
    ['ssh://git:pw@github.com/a/b', /ssh user|invalid/], ['ssh://github.com/a/b', /need a user/], ['ssh://@github.com/a/b', /invalid ssh user/],
    ['/Users/me/repo', /not a remote/], ['./repo', /not a remote/], ['../repo', /not a remote/], ['~/repo', /not a remote/], ['repo', /not a remote/], ['C:\\repo', /./], ['github.com/a/b', /not a remote/],
    ['https://github.com/a/b?x=1', /forbidden/], ['https://github.com/a/b#frag', /forbidden/], ['https://github.com/a/b;ls', /forbidden/], ['https://github.com/a/b|id', /forbidden/],
    ['https://github.com/a/b&id', /forbidden/], ['https://github.com/a/`id`', /forbidden/], ['https://github.com/a/$(id)', /forbidden/], ['https://github.com/a\\b', /forbidden/],
    ['https://github.com/a/b c', /whitespace/], ['https://github.com/a/b\nx', /whitespace/], ['https://github.com/a/b\0', /whitespace|control/], ['https://github.com/a\tb', /whitespace/],
    ['https://github.com/../etc', /\.\./], ['https://github.com/a/../b', /\.\./], ['https://github.com/a/./b', /\./], ['https://github.com//a/b', /empty path/], ['https://github.com/a//b', /empty path/],
    ['https://github.com/a/%2e%2e/b', /encoded/], ['https://github.com/a%2fb/c', /encoded/], ['https://github.com/a/b%00', /encoded/], ['https://github.com/a/b%0a', /encoded/],
    ['https://github.com/-evil/x', /'-'/], ['https://github.com', /no repository path/], ['https://github.com/', /no repository path/],
    ['https://', /./], ['https:///a/b', /./], ['https://-bad.com/a/b', /host|malformed/], ['https://bad_host.com/a/b', /host|malformed/], ['https://exa mple.com/a/b', /whitespace/],
    ['https://[::1]/a/b', /./], ['https://0x7f.1/a/b', /numeric|host/], ['https://2130706433/a/b', /numeric|host/], ['https://999.1.1.1/a/b', /numeric|host/],
    ['https://example.com:0/a/b', /port/], ['https://example.com:99999/a/b', /port|malformed/], ['https://example.com:abc/a/b', /malformed/],
    ['git@github.com:-oProxyCommand=x', /malformed|'-'/], ['git@github.com:../x', /\.\./], ['git@github.com:a b', /whitespace/], ['git@github.com:', /malformed/], ['git@-host:a/b', /./],
    ['git@github.com:a/b;id', /forbidden/], ['git@github.com:a/$x', /forbidden/],
    ['https://github.com/ü/b', /forbidden/], ['', /required/], ['   ', /required/], [null, /string/], [undefined, /string/], [42, /string/], [{}, /string/],
    ['https://example.com/' + 'a'.repeat(2100), /too long/],
    ['javascript:alert(1)', /./], ['data:text/plain,hi', /./],
  ];
  for (const [u, re] of REJECT) {
    it(`rejects ${JSON.stringify(typeof u === 'string' ? u.slice(0, 60) : u)}`, () => assert.throws(() => sg.parseRemote(u), (e) => e.status === 400 && re.test(e.message), `no/incorrect rejection for ${u}`));
  }
  it('has >= 60 cases in total', () => assert.ok(ACCEPT.length + REJECT.length >= 60, String(ACCEPT.length + REJECT.length)));
  it('duplicate detection: https and scp forms normalise equally', () => {
    assert.equal(sg.normalizeRemote('https://github.com/a/b.git'), sg.normalizeRemote('git@github.com:a/b'));
    assert.equal(sg.normalizeRemote('ssh://git@github.com:22/A/B/'), sg.normalizeRemote('https://GITHUB.com/a/b'));
    assert.notEqual(sg.normalizeRemote('https://github.com/a/b'), sg.normalizeRemote('https://github.com/a/c'));
  });
  it('file:// is only accepted behind the test-only flag', () => {
    assert.throws(() => sg.parseRemote('file:///tmp/x.git'));
    process.env.ORCH_TEST_ALLOW_FILE = '1';
    try { assert.equal(sg.parseRemote('file:///tmp/x.git').kind, 'file'); assert.match(sg.buildEnv().GIT_ALLOW_PROTOCOL, /file/); } finally { delete process.env.ORCH_TEST_ALLOW_FILE; }
    assert.equal(sg.buildEnv().GIT_ALLOW_PROTOCOL, 'https:ssh');
  });
});

describe('M1 safegit: redaction', () => {
  it('redacts credentials, tokens and key paths', () => {
    const cases = [
      ['fatal: unable to access https://user:secret@github.com/a/b', /secret/],
      ['remote: https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/a/b', /ghp_|x-access/],
      ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked', /ghp_abc/],
      ['github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', /github_pat_11/],
      ['glpat-abcdefghij1234567890', /glpat-abc/],
      ['Authorization: Bearer abc.def.ghi', /abc\.def/],
      ['Load key "/Users/me/.ssh/id_ed25519": invalid format', /id_ed25519/],
      ['Permission denied (publickey) using /home/x/.ssh/id_rsa', /id_rsa/],
      ['password=hunter2 and api_key: zzz', /hunter2|zzz/],
    ];
    for (const [text, leak] of cases) { const r = sg.redact(text); assert.doesNotMatch(r, leak, r); }
    assert.equal(sg.redact('plain text https://github.com/a/b'), 'plain text https://github.com/a/b');
    assert.equal(sg.redact(null), '');
  });
  it('friendly errors never contain raw credentials', () => {
    const m = sg.friendlyGitError("fatal: could not read Username for 'https://github.com': terminal prompts disabled");
    assert.match(m, /not found|not accessible/);
    assert.match(sg.friendlyGitError('Host key verification failed.'), /ssh -T/);
    assert.match(sg.friendlyGitError('fatal: unable to access https://u:p@h/x: Could not resolve host: h'), /resolve/);
    assert.doesNotMatch(sg.friendlyGitError('weird https://u:p@h/x failure'), /u:p@/);
  });
  it('parses clone progress', () => {
    assert.equal(sg.parseProgress('Receiving objects:  50% (5/10)'), 45);
    assert.equal(sg.parseProgress('Resolving deltas: 100% (3/3), done.'), 95);
    assert.equal(sg.parseProgress('Cloning into x...'), null);
  });
});

describe('M1 safegit: hardened execution', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sg-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('environment is an allowlist: secrets from the parent never reach git or its children', async () => {
    process.env.ORCH_TEST_SECRET_TOKEN = 'supersecret'; process.env.AWS_SECRET_ACCESS_KEY = 'aws'; process.env.GITHUB_TOKEN = 'gh';
    try {
      const e = sg.buildEnv();
      for (const k of ['ORCH_TEST_SECRET_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN']) assert.equal(e[k], undefined, k);
      assert.equal(e.GIT_TERMINAL_PROMPT, '0');
      assert.equal(e.GIT_ALLOW_PROTOCOL, 'https:ssh');
      assert.match(e.GIT_SSH_COMMAND, /BatchMode=yes/);
      assert.doesNotMatch(e.GIT_SSH_COMMAND, /StrictHostKeyChecking/);
      // real child: a git alias with '!' runs `env` in a shell child of git
      const r = await sg.git(dir, ['-c', 'alias.showenv=!env', 'showenv']);
      assert.equal(r.code, 0, r.err);
      assert.doesNotMatch(r.out, /supersecret|AWS_SECRET|GITHUB_TOKEN/);
      assert.match(r.out, /GIT_TERMINAL_PROMPT=0/);
      assert.match(r.out, /GIT_ALLOW_PROTOCOL=https:ssh/);
      const keys = r.out.split('\n').map((l) => l.split('=')[0]).filter(Boolean);
      const allowed = new Set([...sg.ENV_ALLOW, 'PATH', 'GIT_TERMINAL_PROMPT', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_EDITOR', 'GIT_PAGER', 'GCM_INTERACTIVE', 'GIT_ALLOW_PROTOCOL', 'GIT_SSH_COMMAND', 'GIT_CONFIG_NOSYSTEM', 'NO_COLOR', 'LC_MESSAGES', 'PWD', 'SHLVL', '_', 'OLDPWD', 'GIT_EXEC_PATH', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_PREFIX', 'GIT_CONFIG_KEY_0']);
      for (const k of keys) if (!allowed.has(k) && !/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k) && !/^LC_/.test(k) && !/^__/.test(k)) assert.fail(`unexpected env var in git child: ${k}`);
    } finally { delete process.env.ORCH_TEST_SECRET_TOKEN; delete process.env.AWS_SECRET_ACCESS_KEY; delete process.env.GITHUB_TOKEN; }
  });

  it('protocols: ext:: and file:// are refused by git itself; no network is contacted', async () => {
    const c1 = await sg.git(dir, ['ls-remote', '--', 'ext::sh -c "touch ' + path.join(dir, 'pwned') + '"']);
    assert.notEqual(c1.code, 0);
    assert.ok(!fs.existsSync(path.join(dir, 'pwned')));
    const c2 = await sg.git(dir, ['ls-remote', '--', 'file:///etc']);
    assert.notEqual(c2.code, 0);
    assert.match(c2.err, /not allowed|protocol/i);
  });

  it('hooks are disabled by default for untrusted repos and can be re-enabled explicitly', async () => {
    const repo = path.join(dir, 'hookrepo'); fs.mkdirSync(repo);
    await sg.initRepo(repo, { identity: { name: 'T', email: 't@t' } });
    const hook = path.join(repo, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch "${path.join(dir, 'hook-ran')}"\n`); fs.chmodSync(hook, 0o755);
    const off = await sg.git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'x']);
    assert.equal(off.code, 0, off.err);
    assert.ok(!fs.existsSync(path.join(dir, 'hook-ran')), 'hook must not run with hooks=off');
    const on = await sg.git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'y'], { hooks: 'inherit' });
    assert.equal(on.code, 0, on.err);
    assert.ok(fs.existsSync(path.join(dir, 'hook-ran')), 'hook runs when explicitly inherited');
  });

  it('initRepo always makes an initial commit on main (allow-empty), with the given identity', async () => {
    const repo = path.join(dir, 'newrepo'); fs.mkdirSync(repo);
    const id = await sg.initRepo(repo, { identity: { name: 'Jane', email: 'jane@x.org' } });
    assert.equal(id.name, 'Jane');
    const log = await sg.git(repo, ['log', '--format=%an <%ae> %s']);
    assert.match(log.out, /^Jane <jane@x\.org> Initial commit/);
    assert.equal((await sg.git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim(), 'main');
    const repo2 = path.join(dir, 'newrepo2'); fs.mkdirSync(repo2);
    await sg.initRepo(repo2, { identity: null });
    assert.match((await sg.git(repo2, ['log', '--format=%an <%ae>'])).out, /AI Dev Orchestrator <ai-orchestrator@localhost>/);
  });

  it('rejects invalid argv (non-array / NUL)', async () => {
    assert.match((await sg.git(dir, 'status')).error, /invalid/);
    assert.match((await sg.git(dir, ['status', 'a\0b'])).error, /invalid/);
  });
});
