'use strict';
// Per-project settings (projects.settings JSON). Everything has an env/config default; a project value overrides it.
const cfg = require('../config');

const ENGINES = ['local', 'cursor', 'auto'];
const DEFAULTS = () => ({
  route_apply: cfg.ROUTE_APPLY,                  // 'suggest' (default) | 'auto': auto = the routing result is applied to the task as soon as it is ready
  complex_engine: cfg.ROUTE_COMPLEX_ENGINE,      // engine for needs_thinking / complex tasks
  simple_engine: cfg.ROUTE_SIMPLE_ENGINE,        // engine for simple tasks ('auto' = local first, escalation allowed)
  plan_first_complex: cfg.ROUTE_PLAN_FIRST,      // complex tasks routed to cursor default to a plan-first run
  memory_proposals: cfg.MEMORY_PROPOSALS,        // generate a memory proposal after a task reaches review
  context_max_chars: cfg.CONTEXT_MAX_CHARS,      // cap of the context bundle
  decider_fallback_cap: cfg.DECIDER_FALLBACK_CAP, // ornith confidence ceiling; below the act band
  decider_file_cap: cfg.DECIDER_FILE_CAP,        // edit files above this may go to Cursor
});

function effective(project) {
  return { ...DEFAULTS(), ...((project && project.settings) || {}) };
}

/** Validate a partial settings object; returns {settings} (merged over the project's stored overrides) or {error}. */
function validate(input, current = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { error: 'settings must be an object' };
  const out = { ...current };
  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === '') { delete out[k]; continue; } // reset to default
    switch (k) {
      case 'route_apply': if (!['suggest', 'auto'].includes(v)) return { error: "route_apply must be 'suggest' or 'auto'" }; out[k] = v; break;
      case 'complex_engine': case 'simple_engine': if (!ENGINES.includes(v)) return { error: `${k} must be one of ${ENGINES.join(', ')}` }; out[k] = v; break;
      case 'plan_first_complex': case 'memory_proposals': out[k] = v === true || v === 'true' || v === 1 || v === '1'; break;
      case 'context_max_chars': { const n = Number(v); if (!Number.isInteger(n) || n < 2000 || n > 60000) return { error: 'context_max_chars must be an integer 2000..60000' }; out[k] = n; break; }
      case 'decider_fallback_cap': { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 1) return { error: 'decider_fallback_cap must be a number 0..1' }; out[k] = n; break; }
      case 'decider_file_cap': { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 200) return { error: 'decider_file_cap must be an integer 1..200' }; out[k] = n; break; }
      default: return { error: `unknown setting '${k}'` };
    }
  }
  return { settings: out };
}

module.exports = { DEFAULTS, effective, validate };
