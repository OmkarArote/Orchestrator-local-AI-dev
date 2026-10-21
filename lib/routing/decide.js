'use strict';
// Start from the decider route. Downgrade when the task is small. Step toward Cursor when it is large or has already failed locally.
const cfg = require('../../config');

const CHEAPER = { cursor: 'split', split: 'local-ornith', 'local-ornith': 'local-small', 'local-small': 'local-small' };
const DEARER = { 'local-small': 'local-ornith', 'local-ornith': 'split', split: 'cursor', cursor: 'cursor' };

function choose({ from = 'local-ornith', tokens = 0, files = 0, crossModule = false, failureRate = 0, localFails = 0 } = {}) {
  const start = CHEAPER[from] ? from : 'local-ornith';
  if (localFails >= cfg.V2_LOCAL_FAILS_BEFORE_CURSOR) {
    return { route: 'cursor', from: start, reasons: [`${localFails} failed local attempts`] };
  }
  const heavy = tokens > cfg.ROUTE_MAX_TOKENS || files > cfg.ROUTE_MAX_FILES || crossModule || failureRate >= cfg.ROUTE_FAIL_RATE;
  const light = tokens <= Math.floor(cfg.ROUTE_MAX_TOKENS / 4) && files <= 1 && !crossModule && failureRate < cfg.ROUTE_FAIL_RATE;
  const reasons = [];
  let route = start;
  const fileHeavy = files > cfg.ROUTE_MAX_FILES;
  const otherHeavy = tokens > cfg.ROUTE_MAX_TOKENS || crossModule || failureRate >= cfg.ROUTE_FAIL_RATE;
  if (heavy && route !== 'cursor') {
    if (!(route === 'split' && fileHeavy && !otherHeavy)) route = DEARER[route];
    if (tokens > cfg.ROUTE_MAX_TOKENS) reasons.push(`tokens ${tokens}`);
    if (fileHeavy) reasons.push(`files ${files}`);
    if (crossModule) reasons.push('cross-module');
    if (failureRate >= cfg.ROUTE_FAIL_RATE) reasons.push(`failure rate ${failureRate}`);
  } else if (light && route !== 'local-small') {
    route = CHEAPER[route];
    reasons.push('small task');
  }
  return { route, from: start, reasons };
}

module.exports = { choose, CHEAPER, DEARER };
