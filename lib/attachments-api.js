'use strict';
// HTTP surface of the attachments store. The server gate (server.js) has already checked Host / Origin; POST /api/attachments additionally needs
// Content-Type: application/octet-stream and the custom header X-Orch-Upload: 1 (a custom header forces a CORS preflight, which is never granted).
const att = require('./attachments');
const store = require('./db');
const cfg = require('../config');
const mediaTools = require('./media-tools');

const UPLOAD_HEADER = 'x-orch-upload';

function createAttachmentsApi({ sendJson, fail, readJson }) {
  const view = (a, deduped) => ({ id: a.id, sha256: a.sha256, size: a.size, kind: a.kind, mime: a.mime, ext: a.ext, name: a.orig_name, meta: a.meta, created_at: a.created_at, ...(deduped === undefined ? {} : { deduped }) });

  async function upload(req, res) {
    if (!String(req.headers['content-type'] || '').startsWith('application/octet-stream')) { res.setHeader('Connection', 'close'); fail(res, 415, 'Content-Type must be application/octet-stream'); return att.drain(req); }
    if (req.headers[UPLOAD_HEADER] !== '1') { res.setHeader('Connection', 'close'); fail(res, 403, 'missing X-Orch-Upload: 1 header'); return att.drain(req); }
    try {
      const r = await att.receive(req, { name: req.headers['x-filename'] });
      return sendJson(res, r.deduped ? 200 : 201, view(r.attachment, r.deduped));
    } catch (e) {
      if (e instanceof att.UploadError) { res.setHeader('Connection', 'close'); return fail(res, e.status, e.message, { code: e.code, ...e.extra }); }
      throw e;
    }
  }

  return async function attachmentsApi(req, res, url) {
    const p = url.pathname;
    if (p === '/api/media/tools') {
      if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
      return sendJson(res, 200, { tools: mediaTools.detect() });
    }
    if (p === '/api/attachments') {
      if (req.method === 'POST') return upload(req, res);
      if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
      return sendJson(res, 200, {
        items: store.attList(Number(url.searchParams.get('limit')) || 100).map((a) => ({ ...view(a), link_count: a.link_count })),
        totals: store.attTotals(), quota_bytes: cfg.ATTACH_QUOTA_BYTES, limits: cfg.UPLOAD_LIMITS,
        retention: { gc_hours: cfg.ATTACH_GC_HOURS, retention_days: cfg.ATTACH_RETENTION_DAYS },
      });
    }
    if (p === '/api/attachments/gc') {
      if (req.method !== 'POST') return fail(res, 405, 'method not allowed');
      const b = await readJson(req);
      let hours = cfg.ATTACH_GC_HOURS;
      if (b.older_than_hours !== undefined) { hours = Number(b.older_than_hours); if (!Number.isFinite(hours) || hours < 0 || hours > 8760) return fail(res, 400, 'older_than_hours must be a number between 0 and 8760'); }
      return sendJson(res, 200, att.gc({ olderThanHours: hours }));
    }
    const m = p.match(/^\/api\/attachments\/(\d{1,12})(?:\/(raw|derive|delete))?$/);
    if (!m) return fail(res, 404, 'unknown endpoint');
    const id = Number(m[1]); const action = m[2];
    const a = store.attGet(id);
    if (!a) return fail(res, 404, 'attachment not found');
    if (!action) {
      if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
      return sendJson(res, 200, { ...view(a), links: store.attLinksOf(id), derivations: store.attDerivList(id) });
    }
    if (action === 'raw') {
      if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
      if (a.kind !== 'image') return fail(res, 403, 'raw download is only available for images');
      res.writeHead(200, { 'Content-Type': a.mime, 'Content-Length': a.size, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=3600' });
      const s = att.openBlob(a);
      s.on('error', () => res.destroy());
      return s.pipe(res);
    }
    if (req.method !== 'POST') return fail(res, 405, 'method not allowed');
    if (action === 'derive') {
      const r = att.deriveText(id);
      return sendJson(res, r.status === 'ok' ? 200 : 422, r);
    }
    if (action === 'delete') {
      try { att.remove(id); } catch (e) { if (e.status === 409) return fail(res, 409, e.message, { links: e.links }); throw e; }
      return sendJson(res, 200, { ok: true });
    }
    return fail(res, 404, 'unknown action');
  };
}

module.exports = { createAttachmentsApi, UPLOAD_HEADER };
