'use strict';
// Hand-rolled checker: type, required, enum, range. Returns an error string or null.

function check(value, schema, path = 'value') {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.type === 'object') {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return `${path} should be an object`;
    for (const key of schema.required || []) {
      if (value[key] === undefined || value[key] === null) return `${path}.${key} is required`;
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined && value[key] !== null) {
        const err = check(value[key], sub, `${path}.${key}`);
        if (err) return err;
      }
    }
    return null;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} should be an array`;
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const err = check(value[i], schema.items, `${path}[${i}]`);
        if (err) return err;
      }
    }
    return null;
  }
  if (schema.type === 'string' && typeof value !== 'string') return `${path} should be a string`;
  if (schema.type === 'number' && typeof value !== 'number') return `${path} should be a number`;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return `${path} should be a boolean`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(', ')}`;
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) return `${path} is below ${schema.minimum}`;
    if (schema.maximum != null && value > schema.maximum) return `${path} is above ${schema.maximum}`;
  }
  return null;
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['steps'],
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file'],
        properties: { file: { type: 'string' }, intent: { type: 'string' }, acceptance: { type: 'string' }, estLines: { type: 'number' } },
      },
    },
  },
};

module.exports = { check, PLAN_SCHEMA };
