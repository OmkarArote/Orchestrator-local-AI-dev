'use strict';
// Fixed prefix, then the variable part. The prefix order does not change between calls.

const SECTIONS = ['SYSTEM RULES', 'ARCHITECTURE', 'SERVICE BRIEF'];

function compose({ rules = '', architecture = '', brief = '', variable = '' } = {}) {
  return [
    'SYSTEM RULES',
    String(rules),
    'ARCHITECTURE',
    String(architecture),
    'SERVICE BRIEF',
    String(brief),
    'TASK',
    String(variable),
  ].join('\n');
}

function prefixOf(text) {
  const i = String(text || '').indexOf('\nTASK\n');
  return i < 0 ? String(text || '') : String(text).slice(0, i);
}

module.exports = { SECTIONS, compose, prefixOf };
