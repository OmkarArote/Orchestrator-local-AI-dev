'use strict';
/** Error carrying an HTTP status; server.js turns it into {error, ...extra}. */
class ProjectError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const bad = (m, extra) => new ProjectError(400, m, extra);
const conflict = (m, extra) => new ProjectError(409, m, extra);
const forbidden = (m, extra) => new ProjectError(403, m, extra);
const notFound = (m, extra) => new ProjectError(404, m, extra);
module.exports = { ProjectError, bad, conflict, forbidden, notFound };
