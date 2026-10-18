'use strict';
/** Branch names: ai/task-<id>-<title-slug>. Accepts a task row (preferred) or a bare id (legacy ai/task-<id>). A stored task.branch always wins. */
const slugify = (s, max = 40) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
const branchOf = (t) => {
  if (t && typeof t === 'object') {
    if (t.branch) return t.branch;
    const slug = slugify(t.title);
    return slug ? `ai/task-${t.id}-${slug}` : `ai/task-${t.id}`;
  }
  return `ai/task-${t}`;
};
// worktree layout lives in lib/repo.js (worktreeFor): <WORKTREES>/<project.slug>/<service.name>/task-<id>; legacy tasks keep their stored worktree_path.
module.exports = { branchOf, slugify };
