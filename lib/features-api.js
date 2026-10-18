'use strict';
// /api/features/* (cross-repo features). Factory like chat-api: the server injects its helpers. Never under /api/chat.
//   GET  /api/features[?project_id=]              list (owner OR any step's project)
//   POST /api/features                            create {project_id, title, brief?, contract?, steps:[{project_id?, service_id, title, prompt, engine, ...}]}
//   GET  /api/features/:id                        detail (steps, contract versions, actual, drift, merge order, overrides, graph)
//   GET  /api/features/:id/merge-plan             per-step merge pre-flight + merge order
//   POST /api/features/:id/contract               {content}            propose a new contract version
//   POST /api/features/:id/approve-contract       {version?}           human approves the proposed contract
//   POST /api/features/:id/accept-actual          promote the provider's extracted API to the contract (resolves drift)
//   POST /api/features/:id/ignore-drift           {reason}             keep the contract despite drift (typed reason, recorded)
//   POST /api/features/:id/start                  {reason?}            approve-start of all pending steps (Cursor CLI check included)
//   POST /api/features/:id/retry-step             {task_id}            re-queue a failed/rejected step as a new pending task
//   POST /api/features/:id/cancel                 {reason}             reject not-yet-started steps; running ones are left alone
const features = require('./features');
const store = require('./db');
const repo = require('./repo');
const cursor = require('./cursor');

module.exports = function makeFeaturesApi({ sendJson, fail, readJson, validateTask, mergePlan }) {
  return async function featuresApi(req, res, url) {
    const m = url.pathname.match(/^\/api\/features(?:\/(\d+)(?:\/([a-z-]+))?)?$/);
    if (!m) return fail(res, 404, 'unknown endpoint');
    try {
      if (!m[1]) {
        if (req.method === 'GET') {
          const pid = Number(url.searchParams.get('project_id')) || null;
          let list = store.listFeatures();
          if (pid) list = list.filter((f) => f.project_id === pid || store.featureTasks(f.id).some((t) => t.project_id === pid));
          return sendJson(res, 200, list.slice(0, 100).map((f) => features.view(f)));
        }
        if (req.method !== 'POST') return fail(res, 405, 'method not allowed');
        const r = features.create(await readJson(req), { validateStep: validateTask, usable: repo.assertUsable });
        return sendJson(res, 201, features.view(store.getFeature(r.id), { full: true }));
      }
      const f = features.mustGet(m[1]);
      if (!m[2]) { if (req.method !== 'GET') return fail(res, 405, 'method not allowed'); return sendJson(res, 200, features.view(f, { full: true })); }
      if (m[2] === 'merge-plan') {
        if (req.method !== 'GET') return fail(res, 405, 'GET only');
        const v = features.view(f, { full: true });
        const plan = f.group_id ? await mergePlan(store.getGroup(f.group_id)) : null;
        return sendJson(res, 200, { feature_id: f.id, merge_order: v.merge_order, overrides: v.overrides, plan });
      }
      if (req.method !== 'POST') return fail(res, 405, 'POST only');
      const body = await readJson(req);
      const done = () => sendJson(res, 200, features.view(store.getFeature(f.id), { full: true }));
      switch (m[2]) {
        case 'contract': features.saveContract(f, body.content); return done();
        case 'approve-contract': features.approveContract(f, body.version); return done();
        case 'accept-actual': features.acceptActual(f); return done();
        case 'ignore-drift': features.ignoreDrift(f, body.reason); return done();
        case 'start': await features.start(f, String(body.reason ?? '').trim().slice(0, 2000), { cursorStatus: () => cursor.getStatus() }); return done();
        case 'retry-step': features.retryStep(f, body.task_id); return done();
        case 'cancel': features.cancel(f, body.reason); return done();
        default: return fail(res, 404, 'unknown endpoint');
      }
    } catch (e) {
      if (e instanceof features.FeatureError) return fail(res, e.status, e.message);
      throw e;
    }
  };
};
