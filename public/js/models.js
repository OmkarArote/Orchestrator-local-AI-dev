// Models panel: Ollama status, installed models, role assignment (validated against /api/show), catalog with verified sizes. Downloads are disabled.
import { el, clear, api, badge, chip, bytes, empty, skeletonCards, field, select, modal, confirmDialog, toast, toastError, busy } from './ui.js';
import { loadOllama } from './state.js';

const ROLE_HELP = {
  coding: 'aider (local engine) edits files', chat: 'dashboard Chat page (default model + num_ctx 16384, thinking off)', routing: 'task router: picks service + engine', memory: 'drafts MEMORY.md proposals',
  planning: 'stored only (planning runs on Cursor)', requirements: 'stored only (no local consumer yet)', review: 'stored only (review runs on Cursor)', debugging: 'stored only', documentation: 'stored only',
};
const OPT_FIELDS = [['num_ctx', 'num_ctx', 'int', 'context window (tokens)'], ['temperature', 'temperature', 'num', '0 - 2'], ['top_p', 'top_p', 'num', '0 - 1'], ['top_k', 'top_k', 'int', '>= 0'], ['repeat_penalty', 'repeat_penalty', 'num', '0.5 - 2'], ['num_predict', 'num_predict', 'int', 'max new tokens'], ['seed', 'seed', 'int', 'optional']];

export async function render(main) {
  let state = { status: null, models: null, roles: null, catalog: null, verified: {}, fit: 'all' };
  const root = el('div'); main.append(root);
  async function load(fresh = false) {
    const [status, models, roles, catalog] = await Promise.all([api('/ollama/status'), api('/ollama/models' + (fresh ? '?refresh=1' : '')).catch((e) => ({ error: e.message, models: [] })), api('/models/roles'), api('/ollama/catalog')]);
    state = { ...state, status, models, roles: roles.roles, catalog };
    loadOllama(); draw();
  }
  let pullJob = null, pullTimer = null;
  function pollPull() {
    if (pullTimer) return;
    pullTimer = setInterval(async () => {
      try {
        const j = await api(`/jobs/${pullJob}`); state.pull = j;
        if (['done', 'failed', 'cancelled'].includes(j.state)) {
          clearInterval(pullTimer); pullTimer = null; pullJob = null; state.pull = null;
          if (j.state === 'done') toast(`${j.meta.name} downloaded`, 'ok'); else toast(`download ${j.state}${j.error ? ': ' + j.error : ''}`, 'warn');
          await load(true);
        } else draw();
      } catch (e) { clearInterval(pullTimer); pullTimer = null; pullJob = null; }
    }, 1000);
  }
  function draw() {
    const { status: st, models, roles, catalog } = state;
    const installed = (models.models || []);
    clear(root,
      el('div', { className: 'page-head' }, el('div', { className: 'grow' }, el('h1', {}, 'Models'), el('p', {}, 'Local models served by Ollama. Assign them to roles; settings are validated against what the model really supports.')),
        el('button', { className: 'btn sec', textContent: '\u21BB Refresh', onclick: (e) => busy(e.currentTarget, () => load(true)) })),
      statusCard(st), el('h2', { className: 'mt mb' }, 'Installed'), models.error ? el('div', { className: 'callout bad' }, `Cannot list models: ${models.error}`) : installed.length ? el('div', { className: 'grid auto' }, ...installed.map(modelCard)) : empty({ icon: '\u25C8', title: 'No models installed', text: 'Ollama has no models yet. Downloads are disabled in this build; install one with the ollama CLI yourself.' }),
      el('h2', { className: 'mt mb' }, 'Roles'), rolesCard(roles, installed, st),
      el('h2', { className: 'mt mb' }, 'Catalog'), catalogView(catalog));
  }
  const statusCard = (st) => el('div', { className: 'card' }, el('div', { className: 'head' }, el('h3', {}, 'Ollama'), badge(st.reachable ? 'reachable' : 'offline', st.reachable ? 's-ok' : 's-failed'), st.pull_enabled ? badge('downloads enabled', 's-review', 'every download asks for confirmation') : badge('downloads disabled', 's-archived', st.pull_note || '')),
    el('dl', { className: 'kv' }, el('dt', {}, 'Version'), el('dd', {}, st.version || '-'), el('dt', {}, 'Address'), el('dd', {}, el('code', {}, st.base_url), st.loopback_only ? ' (loopback only)' : ''),
      el('dt', {}, 'RAM'), el('dd', {}, bytes(st.ram_bytes)), el('dt', {}, 'Disk free'), el('dd', {}, bytes(st.disk_free_bytes)),
      el('dt', {}, 'Default model'), el('dd', {}, el('b', {}, st.default_model), ` (${st.default_source})`), el('dt', {}, 'Coding model'), el('dd', {}, st.coding_model)),
    st.error ? el('div', { className: 'callout bad mt' }, st.error.message) : null,
    el('div', { className: 'callout info mt small' }, st.pull_enabled ? 'Downloads are enabled (ORCH_ALLOW_MODEL_PULL=1). Nothing downloads automatically: each download needs your confirmation of the verified size.' : 'Downloads are disabled (ORCH_ALLOW_MODEL_PULL=0). Nothing is ever downloaded automatically; this panel only lists, assigns and validates installed models.'));
  const modelCard = (m) => el('div', { className: 'card' },
    el('div', { className: 'head' }, el('h3', { className: 'ellipsis', title: m.name }, m.name), m.loaded ? badge('loaded', 's-running') : null, m.is_default ? badge('default', 's-review') : null),
    el('div', { className: 'row small dim' }, m.parameter_size || '', m.quantization ? ` \u00B7 ${m.quantization}` : '', ` \u00B7 ${bytes(m.size)}`, m.family ? ` \u00B7 ${m.family}` : ''),
    el('div', { className: 'row mt' }, ...(m.capabilities || []).map((c) => chip(c)), m.context_length ? chip(`ctx ${m.context_length.toLocaleString()}`, 'mono') : null),
    m.running ? el('div', { className: 'callout ok small mt', title: 'from Ollama /api/ps: what is in memory right now' }, el('strong', { textContent: 'Running now ' }),
      [m.running.context_length ? `ctx ${m.running.context_length.toLocaleString()} in use` : null, m.running.gpu_pct != null ? `${m.running.gpu_pct}% on GPU${m.running.gpu_pct < 100 ? ' (rest on CPU)' : ''}` : null,
        m.running.size ? `${bytes(m.running.size)} in memory` : null, m.running.expires_at ? `unloads ${new Date(m.running.expires_at).toLocaleTimeString([], { hour12: false })}` : null].filter(Boolean).join(' \u00B7 ')) : null,
    m.defaults && Object.keys(m.defaults).length ? el('div', { className: 'small dim mt' }, 'model defaults: ' + Object.entries(m.defaults).map(([k, v]) => `${k} ${v}`).join(', ')) : null,
    m.in_use_by.length ? el('div', { className: 'row mt' }, el('span', { className: 'small dim' }, 'used by'), ...m.in_use_by.map((u) => chip(u.role, u.source === 'role' ? 'e-local' : ''))) : null,
    m.show_error ? el('div', { className: 'small t-bad mt' }, m.show_error) : null);

  function rolesCard(roles, installed, st) {
    const defSel = select([['', `config / env (${st.default_source === 'config' ? st.default_model : 'cleared'})`], ...installed.map((m) => [m.name, m.name])], st.default_source === 'setting' ? st.default_model : '');
    const defBtn = el('button', { className: 'btn sec sm', textContent: 'Set default', onclick: (e) => busy(e.currentTarget, async () => { await api('/models/default', { model: defSel.value || null }); toast('default model updated', 'ok'); await load(); }) });
    return el('div', { className: 'card' },
      el('div', { className: 'row mb' }, el('b', {}, 'Default model for roles without an override'), el('div', { style: { width: '260px' } }, defSel), defBtn),
      el('table', {}, el('thead', {}, el('tr', {}, ...['Role', 'Model', 'Options', 'Used by', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...roles.map((r) => el('tr', {},
          el('td', {}, el('b', {}, r.role), r.wired ? null : el('div', { className: 'tiny dim' }, 'stored only')),
          el('td', {}, r.model, ' ', r.source === 'role' ? badge('override', 's-review nodot') : r.source === 'setting' ? badge('default setting', 'nodot') : badge('config', 'nodot s-archived')),
          el('td', { className: 'small mono' }, Object.keys(r.options || {}).length ? Object.entries(r.options).map(([k, v]) => `${k}=${v}`).join(' ') : el('span', { className: 'dim' }, 'model defaults')),
          el('td', { className: 'small dim' }, ROLE_HELP[r.role]),
          el('td', { className: 'nowrap' }, el('button', { className: 'btn sm sec', textContent: 'Edit', onclick: () => editRole(r, installed) }), ' ', r.source === 'role' ? el('button', { className: 'btn sm ghost', textContent: 'Reset', onclick: (e) => busy(e.currentTarget, async () => { await api('/models/roles/clear', { role: r.role }); toast(`${r.role} reset`, 'ok'); await load(); }) }) : null))))));
  }
  function editRole(r, installed) {
    const modelSel = select(installed.map((m) => [m.name, `${m.name}  (ctx ${m.context_length || '?'})`]), r.model);
    const inputs = {}; const grid = el('div', { className: 'form-grid' });
    for (const [k, label, , hint] of OPT_FIELDS) { inputs[k] = el('input', { value: (r.options || {})[k] ?? '', placeholder: 'model default', inputMode: 'decimal' }); grid.append(field(label, inputs[k], hint)); }
    const think = el('input', { value: (r.options || {}).think ?? '', placeholder: 'empty / true / false / low / medium / high' });
    const large = el('input', { type: 'checkbox' });
    const result = el('div', { className: 'stack' });
    const collect = () => { const o = {}; for (const [k, , t] of OPT_FIELDS) { const v = inputs[k].value.trim(); if (v !== '') o[k] = t === 'int' ? Number(v) : Number(v); } const tv = think.value.trim(); if (tv) o.think = tv === 'true' ? true : tv === 'false' ? false : tv; return o; };
    const call = async (path, btn) => busy(btn, async () => {
      const body = { role: r.role, model: modelSel.value, options: collect(), allow_large_ctx: large.checked };
      if (path === '/models/roles/validate') {
        const v = await api(path, body);
        clear(result, ...(v.errors || []).map((e) => el('div', { className: 'callout bad' }, e)), ...(v.warnings || []).map((w) => el('div', { className: 'callout warn' }, w)), v.ok ? el('div', { className: 'callout ok' }, `valid for ${modelSel.value}${v.model_info ? ` (context ${v.model_info.context_length})` : ''}`) : null);
      } else { await api(path, body); toast(`${r.role} saved`, 'ok'); m.close(); await load(); }
    });
    const m = modal({ title: `Role: ${r.role}`, wide: true,
      body: el('div', {}, el('div', { className: 'callout info small mb' }, ROLE_HELP[r.role]), field('Model (installed only)', modelSel), grid, field('think', think, 'only for models with the thinking capability'),
        el('label', { className: 'chk' }, large, 'allow num_ctx above 32768 (needs lots of RAM)'), result),
      footer: [el('button', { className: 'btn sec', textContent: 'Cancel', onclick: () => m.close() }), el('button', { className: 'btn sec', textContent: 'Validate', onclick: (e) => call('/models/roles/validate', e.currentTarget) }), el('button', { className: 'btn primary', textContent: 'Save', onclick: (e) => call('/models/roles', e.currentTarget) })] });
  }

  function catalogView(c) {
    const seg = el('div', { className: 'seg', role: 'tablist' }, ...[['all', 'All'], ['recommended', 'Fits comfortably'], ['installed', 'Installed'], ['base', 'Base / completion']].map(([k, l]) => el('button', { className: state.fit === k ? 'on' : '', textContent: l, onclick: () => { state.fit = k; draw(); } })));
    const shown = c.models.filter((m) => state.fit === 'all' || (state.fit === 'recommended' && m.fit === 'recommended') || (state.fit === 'installed' && m.installed) || (state.fit === 'base' && m.kind === 'base'));
    return el('div', {}, el('div', { className: 'row mb' }, seg, el('span', { className: 'small dim' }, `sizes verified ${c.verified_at} against the Ollama registry (read-only) \u00B7 RAM ${bytes(c.ram_bytes)} \u00B7 disk free ${bytes(c.disk_free_bytes)}`)),
      el('div', { className: 'grid auto' }, ...shown.map((m) => catalogCard(m, c))));
  }
  function catalogCard(m, c) {
    const v = state.verified[m.name];
    const canDl = c.download_enabled && !m.installed && m.can_download !== false;
    const dlTitle = !c.download_enabled ? 'downloads disabled \u2014 enable later' : m.installed ? 'already installed' : m.can_download === false ? (m.fit === 'too_large' ? 'too large for this Mac' : 'not enough free disk') : 'Verify the size, confirm, then download';
    const dl = el('button', { className: 'btn sm primary', textContent: m.installed ? 'Installed' : 'Download', disabled: !canDl, title: dlTitle, onclick: (e) => busy(e.currentTarget, async () => {
      try {
        const vv = await api('/ollama/models/verify', { name: m.name, fresh: true }); state.verified[m.name] = vv;
        const size = vv.total_bytes || vv.weights_bytes;
        if (!(await confirmDialog({ title: `Download ${m.name}`, message: `Download ${m.name} (${bytes(size)}) into Ollama? Your Mac has ${bytes(c.ram_bytes)} RAM and ${bytes(c.disk_free_bytes)} free disk. Only one download runs at a time.`, confirmText: 'Download' }))) { draw(); return; }
        const j = await api('/ollama/models/pull', { name: m.name, confirm_size_bytes: size });
        toast(`downloading ${m.name}`, 'ok'); pullJob = j.id; pollPull();
      } catch (er) { toastError(er); }
      draw();
    }) });
    const ver = el('button', { className: 'btn sm sec', textContent: v ? 'Re-verify' : 'Verify size', title: 'Read-only registry lookup (nothing is downloaded)', onclick: (e) => busy(e.currentTarget, async () => { try { state.verified[m.name] = await api('/ollama/models/verify', { name: m.name, fresh: true }); } catch (er) { state.verified[m.name] = { error: er.message }; } draw(); }) });
    return el('div', { className: 'card' },
      el('div', { className: 'head' }, el('h3', { className: 'ellipsis', title: m.name }, m.name), badge(m.fit_label, `fit-${m.fit} nodot`)),
      el('div', { className: 'row small' }, el('b', {}, `${m.weights_gb} GB`), m.kind === 'base' ? chip('base model') : null, m.installed ? badge('installed', 's-ok') : null),
      el('div', { className: 'small dim mt' }, m.note), el('div', { className: 'row mt' }, ...m.roles.map((r) => chip(r))),
      v ? el('div', { className: `small mt ${v.error || v.exists === false ? 't-bad' : 't-ok'}` }, v.error ? v.error : v.exists === false ? 'not found in the registry' : `registry: ${bytes(v.weights_bytes)} weights, ${bytes(v.total_bytes)} total`) : null,
      el('div', { className: 'row mt' }, ver, dl, c.download_enabled ? null : el('span', { className: 'tiny dim' }, 'downloads disabled \u2014 enable later')),
      pullJob && state.pull && state.pull.meta && state.pull.meta.name === m.name ? el('div', { className: 'small mt' }, `${state.pull.phase || 'downloading'} \u00B7 ${state.pull.percent}%`, el('div', { className: 'progress' }, el('i', { style: { width: `${state.pull.percent}%` } }))) : null);
  }

  clear(root, el('div', { className: 'page-head' }, el('div', { className: 'grow' }, el('h1', {}, 'Models'))), skeletonCards(3));
  try { await load(); } catch (e) { clear(root, el('div', { className: 'callout bad' }, e.message)); }
}
