'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGuard, removeOwnedDir, removeOwnedFile, inside, same } = require('../lib/fsguard');

describe('M1 fsguard: authorized roots + canonicalisation', () => {
  let base, home, work, other, g, own;
  before(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fsg-')));
    home = path.join(base, 'home'); work = path.join(home, 'work'); other = path.join(home, 'other');
    own = path.join(work, 'orch-own');
    for (const d of [path.join(work, 'inside'), other, path.join(own, 'data'), path.join(home, '.ssh'), path.join(home, 'Library', 'x'), path.join(work, '.hidden')]) fs.mkdirSync(d, { recursive: true });
    fs.symlinkSync(other, path.join(work, 'link-out'));
    fs.symlinkSync(path.join(work, 'inside'), path.join(work, 'link-in'));
    fs.writeFileSync(path.join(work, 'file.txt'), 'x');
    g = createGuard({ home, ownDirs: [own], getRoots: () => [work] });
  });
  after(() => fs.rmSync(base, { recursive: true, force: true }));

  describe('validateRoot', () => {
    for (const [label, input, re] of [
      ['filesystem root', '/', /root|system/],
      ['home itself', () => home, /home directory itself/],
      ['/etc', '/etc', /system directory/],
      ['/usr', '/usr', /system directory/],
      ...(process.platform === 'darwin' ? [['/System', '/System', /system directory/], ['/Applications', '/Applications', /system directory/], ['/Volumes', '/Volumes', /system directory|\/Volumes/]] : []), // macOS-only locations
      ['hidden dir in home', () => path.join(home, '.ssh'), /hidden/],
      ['~/Library', () => path.join(home, 'Library', 'x'), /Library/],
      ['file, not dir', () => path.join(work, 'file.txt'), /not a directory/],
      ['missing', () => path.join(work, 'nope'), /does not exist/],
      ['relative', 'work/x', /absolute/],
      ['NUL byte', () => work + '\0x', /control/],
      ['~user', '~root', /not supported/],
      ['empty', '  ', /required/],
      ['non-string', 42, /required/],
      ['inside own dir', () => path.join(own, 'data'), /own directory/],
    ]) {
      it(`rejects ${label}`, () => assert.throws(() => g.validateRoot(typeof input === 'function' ? input() : input), re));
    }
    it('accepts a normal directory; warns when it contains the orchestrator dirs', () => {
      const r = g.validateRoot(work);
      assert.equal(r.path, fs.realpathSync(work));
      assert.ok(r.warnings.some((w) => /contains the orchestrator/.test(w)));
      assert.deepEqual(g.validateRoot(path.join(work, 'inside')).warnings, []);
    });
    it('expands ~', () => {
      const old = process.env.HOME; // createGuard captured `home`, so ~ is expanded against it
      assert.equal(g.validateRoot('~/work').path, fs.realpathSync(work)); process.env.HOME = old;
    });
  });

  describe('resolveInRoots', () => {
    const ok = (p, o) => g.resolveInRoots(p, o);
    it('accepts paths inside the root (existing and not-yet-existing)', () => {
      assert.equal(ok(path.join(work, 'inside')), path.join(work, 'inside'));
      assert.equal(ok(path.join(work, 'inside', 'new', 'deeper')), path.join(work, 'inside', 'new', 'deeper'));
      assert.equal(ok(work), work);
      assert.equal(ok('~/work/inside'), path.join(work, 'inside'));
      assert.equal(ok(path.join(work, 'inside') + '/'), path.join(work, 'inside'));
      assert.equal(ok(path.join(work, 'inside', '.', 'x', '..', 'y')), path.join(work, 'inside', 'y'));
    });
    it('rejects traversal out of the root', () => {
      for (const p of [path.join(work, '..', 'other'), path.join(work, 'inside', '..', '..', 'other'), home, base, '/', '/etc/passwd', path.join(work + 'x'), path.join(work, '..', 'work2')]) {
        assert.throws(() => ok(p), /outside the authorized roots|absolute|resolve/, p);
      }
    });
    it('rejects symlink escapes (existing or to-be-created below a symlink)', () => {
      assert.throws(() => ok(path.join(work, 'link-out')), /outside/);
      assert.throws(() => ok(path.join(work, 'link-out', 'newrepo')), /outside/);
      assert.throws(() => ok(path.join(work, 'link-out', 'a', 'b')), /outside/);
    });
    it('follows symlinks that stay inside the root and returns the canonical path', () => {
      assert.equal(ok(path.join(work, 'link-in')), path.join(work, 'inside'));
      assert.equal(ok(path.join(work, 'link-in', 'x')), path.join(work, 'inside', 'x'));
    });
    if (process.platform === 'darwin') {
      it('case-insensitive spellings normalise to the same location (darwin)', () => {
        assert.equal(ok(path.join(home, 'WORK', 'INSIDE')), path.join(work, 'inside'));
        assert.ok(same(ok(path.join(home, 'Work', 'brand-new')), path.join(work, 'brand-new')));
        assert.throws(() => ok(path.join(home, 'OTHER')), /outside/);
        assert.ok(inside(path.join(home, 'WORK', 'x'), work));
      });
    }
    it('rejects NUL, control characters, empty, relative, ~user, over-long, non-string', () => {
      for (const p of [work + '\0', work + '/a\nb', work + '/a\tb', '', '   ', 'relative/x', '~bob/x', '/'.padEnd(5000, 'a'), null, undefined, 5, {}, []]) assert.throws(() => ok(p), /./, String(p).slice(0, 30));
    });
    it('rejects hidden segments unless allowHidden; own dirs always off limits', () => {
      assert.throws(() => ok(path.join(work, '.hidden', 'x')), /hidden/);
      assert.equal(ok(path.join(work, '.orch-clone-abc'), { allowHidden: true }), path.join(work, '.orch-clone-abc'));
      assert.throws(() => ok(path.join(own, 'data'), { allowHidden: true }), /own directory/);
      assert.throws(() => ok(own), /own directory/);
    });
    it('forCreate: refuses existing paths and symlinks; mustExist; allowRoot=false', () => {
      assert.throws(() => ok(path.join(work, 'inside'), { forCreate: true }), /already exists/);
      assert.throws(() => ok(path.join(work, 'link-in'), { forCreate: true }), /already exists/);
      assert.throws(() => ok(path.join(work, 'file.txt'), { forCreate: true }), /already exists/);
      assert.equal(ok(path.join(work, 'fresh'), { forCreate: true }), path.join(work, 'fresh'));
      assert.throws(() => ok(path.join(work, 'missing'), { mustExist: true }), /does not exist/);
      assert.throws(() => ok(work, { allowRoot: false }), /not the root itself/);
      const e = (() => { try { ok(path.join(work, 'inside'), { forCreate: true }); } catch (x) { return x; } })();
      assert.equal(e.extra.code, 'exists');
    });
    it('no roots configured -> everything refused', () => {
      const none = createGuard({ home, getRoots: () => [] });
      assert.throws(() => none.resolveInRoots(work), /no authorized roots/);
    });
    it('multiple roots; roots must match on a path boundary (work vs work2)', () => {
      const w2 = path.join(home, 'work2'); fs.mkdirSync(w2);
      const two = createGuard({ home, getRoots: () => [work, w2] });
      assert.equal(two.resolveInRoots(path.join(w2, 'a')), path.join(w2, 'a'));
      const one = createGuard({ home, getRoots: () => [work] });
      assert.throws(() => one.resolveInRoots(path.join(w2, 'a')), /outside/);
    });
    it('recheck: detects a symlink swapped in after resolution', () => {
      const target = path.join(work, 'swap'); fs.mkdirSync(target);
      assert.equal(g.recheck(target), target);
      fs.rmSync(target, { recursive: true }); fs.symlinkSync(other, target);
      assert.throws(() => g.recheck(target), /outside the authorized roots/);
      fs.unlinkSync(target);
      assert.throws(() => g.recheck(target), /vanished/);
    });
  });

  describe('removeOwnedDir (the only rm -rf)', () => {
    let d;
    before(() => { d = path.join(work, 'rm-tests'); fs.mkdirSync(d); });
    const mk = (n, withFile = true) => { const p = path.join(d, n); fs.mkdirSync(p); if (withFile) fs.writeFileSync(path.join(p, 'f'), 'x'); return p; };
    it('refuses unowned dirs, roots, home, symlinks, files, relative paths', () => {
      const p = mk('plain');
      assert.throws(() => removeOwnedDir(p, { home }), /not owned/);
      assert.ok(fs.existsSync(p));
      assert.throws(() => removeOwnedDir('/', { home }), /root|not owned/);
      assert.throws(() => removeOwnedDir(home, { home, isOwned: () => true }), /home/);
      assert.throws(() => removeOwnedDir('relative', { home }), /absolute/);
      const link = path.join(d, 'lnk'); fs.symlinkSync(p, link);
      assert.throws(() => removeOwnedDir(link, { home, isOwned: () => true }), /symbolic link/);
      assert.throws(() => removeOwnedDir(path.join(p, 'f'), { home, isOwned: () => true }), /not a directory/);
      assert.ok(fs.existsSync(p) && fs.existsSync(path.join(p, 'f')));
    });
    it('refuses protected (registered service) locations even when journaled', () => {
      const p = mk('svc');
      assert.throws(() => removeOwnedDir(p, { home, isOwned: () => true, protect: (r) => r === fs.realpathSync(p) }), /protected/);
      assert.ok(fs.existsSync(p));
    });
    it('removes journaled dirs, dirs strictly under owned prefixes, and .orch-clone- staging dirs in clone parents', () => {
      const a = mk('journaled');
      assert.equal(removeOwnedDir(a, { home, isOwned: (x) => same(x, a) }), true);
      assert.ok(!fs.existsSync(a));
      const pre = mk('prefix', false); const inner = path.join(pre, 'task-1'); fs.mkdirSync(inner); fs.writeFileSync(path.join(inner, 'f'), 'x');
      assert.throws(() => removeOwnedDir(pre, { home, ownedPrefixes: [pre] }), /not owned/); // the prefix itself is not removable
      assert.equal(removeOwnedDir(inner, { home, ownedPrefixes: [pre] }), true);
      const st = path.join(d, '.orch-clone-abc123'); fs.mkdirSync(st); fs.writeFileSync(path.join(st, 'f'), 'x');
      assert.throws(() => removeOwnedDir(st, { home }), /not owned/); // prefix alone is not enough: needs a clone parent
      assert.equal(removeOwnedDir(st, { home, cloneParents: [d] }), true);
      assert.equal(removeOwnedDir(path.join(d, 'gone'), { home, isOwned: () => true }), false);
    });
    it('does not follow symlinks inside the removed tree', () => {
      const a = mk('withlink'); const victim = path.join(other, 'victim.txt'); fs.writeFileSync(victim, 'keep');
      fs.symlinkSync(other, path.join(a, 'lnk'));
      removeOwnedDir(a, { home, isOwned: () => true });
      assert.ok(fs.existsSync(victim), 'target of an inner symlink survives');
    });
  });
});

describe('M6 fsguard.removeOwnedFile (the only single-file delete)', () => {
  let base, home, root, other;
  before(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fsf-')));
    home = path.join(base, 'home'); root = path.join(base, 'own'); other = path.join(base, 'other');
    for (const d of [home, path.join(root, 'ab'), other]) fs.mkdirSync(d, { recursive: true });
  });
  after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = (...p) => { const f = path.join(root, ...p); fs.writeFileSync(f, 'x'); return f; };

  it('removes a regular file inside the owned root; false when it is already gone', () => {
    const f = file('ab', 'one'); assert.equal(removeOwnedFile(f, { root, home }), true); assert.equal(fs.existsSync(f), false);
    assert.equal(removeOwnedFile(f, { root, home }), false);
    const top = file('top'); assert.equal(removeOwnedFile(top, { root, home }), true, 'a file directly in the root is fine');
  });
  it('refuses files outside the root (also via ..), relative paths, control characters and bad roots', () => {
    const victim = path.join(other, 'victim'); fs.writeFileSync(victim, 'keep');
    assert.throws(() => removeOwnedFile(victim, { root, home }), /outside the owned directory/);
    assert.throws(() => removeOwnedFile(path.join(root, 'ab', '..', '..', 'other', 'victim'), { root, home }), /outside/);
    assert.throws(() => removeOwnedFile('relative/file', { root, home }), /absolute path/);
    assert.throws(() => removeOwnedFile(path.join(root, 'a\nb'), { root, home }), /absolute path/);
    assert.throws(() => removeOwnedFile(victim, { root: '/', home }), /root or the home/);
    assert.throws(() => removeOwnedFile(victim, { root: home, home }), /root or the home/);
    assert.throws(() => removeOwnedFile(victim, { root: 'rel', home }), /absolute root/);
    assert.throws(() => removeOwnedFile(victim, { root: path.join(base, 'nope'), home }), /root does not exist/);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  });
  it('never follows symlinks: not as the file, not as a parent directory', () => {
    const victim = path.join(other, 'victim2'); fs.writeFileSync(victim, 'keep');
    const link = path.join(root, 'ab', 'lnk'); fs.symlinkSync(victim, link);
    assert.throws(() => removeOwnedFile(link, { root, home }), /symbolic link/);
    const dirLink = path.join(root, 'escape'); fs.symlinkSync(other, dirLink);
    assert.throws(() => removeOwnedFile(path.join(dirLink, 'victim2'), { root, home }), /outside the owned directory/);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  });
  it('refuses directories', () => {
    assert.throws(() => removeOwnedFile(path.join(root, 'ab'), { root, home }), /not a regular file/);
    assert.ok(fs.existsSync(path.join(root, 'ab')));
  });
});
