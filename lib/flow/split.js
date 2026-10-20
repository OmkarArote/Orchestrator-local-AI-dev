'use strict';
// A feature that names more than LOCAL_MAX_FILES files is split into a stacked sequence of small v2 tasks (at most `max` files each)
// instead of one Cursor run. The parts are created pending: each still needs its own start approval. Nothing runs here.

/** Order paths by directory (first-seen order, so the caller's layer order stays), then cut into chunks of at most `max`. */
function splitFiles(paths, max = 3) {
  const uniq = [...new Set((paths || []).map(String).filter(Boolean))];
  const byDir = new Map();
  for (const p of uniq) {
    const i = p.lastIndexOf('/');
    const d = i < 0 ? '.' : p.slice(0, i);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(p);
  }
  const flat = [...byDir.values()].flat();
  const chunks = [];
  for (let i = 0; i < flat.length; i += Math.max(1, max)) chunks.push(flat.slice(i, i + Math.max(1, max)));
  return chunks;
}

/** Create the sequence. Returns { groupId, taskIds, chunks }. `store` is lib/db (injected for tests). */
function createSplit(task, paths, { store, max = 3 } = {}) {
  const chunks = splitFiles(paths, max);
  const title = String(task.title || `task ${task.id}`).slice(0, 150);
  const groupId = store.createGroup({ project_id: task.project_id, title: `${title} (split from #${task.id})`, dependency: 'stack' });
  const taskIds = chunks.map((files, i) => {
    const id = store.createTask({
      project_id: task.project_id, title: `${title} - part ${i + 1}/${chunks.length}`.slice(0, 200),
      prompt: `${task.prompt}\n\nThis is part ${i + 1} of ${chunks.length}. Only change these files: ${files.join(', ')}. Other parts handle the rest.`,
      files, check_cmd: task.check_cmd || null, engine: 'auto', model: task.model || null, allow_escalation: true,
      service_id: task.service_id || null, group_id: groupId, step_no: i + 1, routing_source: 'split', flow: 'v2',
    });
    store.addEvent(id, 'system', `task created as part ${i + 1}/${chunks.length} of sequence #${groupId}, split from #${task.id} (${files.length} file(s): ${files.join(', ')}); status pending, awaiting start approval`);
    return id;
  });
  return { groupId, taskIds, chunks };
}

module.exports = { splitFiles, createSplit };
