'use strict';

// AeorDB's native where grammar is a condition tree:
//
//   { field, op, value }        one condition
//   { and: [...] }              all children
//   { or: [...] }               any child
//   { not: ... }                negation
//
// Models repeatedly send the same idea in other reasonable shapes, especially
// `{ authorType: 'user' }` and `{ authorType: { eq: 'user' } }`. Rejecting those
// with "requires a non-empty field" is a tool-design failure: the filter is
// obvious, only the spelling differs. Normalize the common shapes once, here,
// and reject genuinely ambiguous input with examples.

export const WHERE_OPERATORS = Object.freeze([
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'prefix', 'exists',
]);

const OPERATORS = new Set(WHERE_OPERATORS);
const CONDITION_KEYS = new Set([ 'field', 'name', 'key', 'op', 'operator', 'value', 'val' ]);

export const WHERE_SHAPE_HELP = 'where accepts {field:"authorType",op:"eq",value:"user"}, shorthand {authorType:"user"} or {authorType:{eq:"user"}}, and/or/not groups, or a string such as "authorType=eq user, createdAt=gt 1793120000000000".';

export function normalizeWhereClause(value) {
  if (value == null)
    return null;

  if (typeof value === 'string')
    return parseWhereString(value);

  if (Array.isArray(value)) {
    let children = value.map((child) => normalizeWhereClause(child));
    if (value.length === 0)
      throw whereError('where array must contain at least one condition');
    return children.length === 1 ? children[0] : { and: children };
  }

  if (typeof value !== 'object')
    throw whereError('where must be an object or a condition string');

  return normalizeObject(value);
}

export function parseWhereString(value) {
  let text = String(value || '').trim();
  if (text === '')
    throw whereError('where string must not be empty');

  if (text.startsWith('{') || text.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw whereError(`where JSON could not be parsed: ${error.message}`);
    }
    return normalizeWhereClause(parsed);
  }

  let parts = splitTopLevel(text, ',');
  let conditions = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map(parseConditionString);

  if (conditions.length === 0)
    throw whereError('where string must contain at least one condition');

  return conditions.length === 1 ? conditions[0] : { and: conditions };
}

function normalizeObject(value) {
  let keys = Object.keys(value);
  if (keys.length === 0)
    throw whereError('where must contain at least one condition or and/or/not group');

  if (Object.hasOwn(value, 'and')) {
    if (!Array.isArray(value.and))
      throw whereError('where.and must be an array');
    return { and: value.and.map((child) => normalizeWhereClause(child)) };
  }

  if (Object.hasOwn(value, 'or')) {
    if (!Array.isArray(value.or))
      throw whereError('where.or must be an array');
    return { or: value.or.map((child) => normalizeWhereClause(child)) };
  }

  if (Object.hasOwn(value, 'not')) {
    let child = normalizeWhereClause(value.not);
    if (!child)
      throw whereError('where.not must contain a condition');
    return { not: child };
  }

  // A canonical condition (including one missing `field`, which should fail
  // loudly) is distinguishable from a shorthand field map by these keys.
  if (keys.some((key) => CONDITION_KEYS.has(key)))
    return normalizeCondition(value);

  let conditions = [];
  for (let [field, spec] of Object.entries(value))
    conditions.push(...conditionsForField(field, spec));

  if (conditions.length === 0)
    throw whereError('where must contain at least one condition');

  return conditions.length === 1 ? conditions[0] : { and: conditions };
}

function normalizeCondition(value) {
  let field = normalizeField(value.field ?? value.name ?? value.key);
  let rawOp = value.op ?? value.operator;
  let op = normalizeOperator(rawOp);
  let hasValue = Object.hasOwn(value, 'value') || Object.hasOwn(value, 'val');
  let conditionValue = hasValue ? (Object.hasOwn(value, 'value') ? value.value : value.val) : true;

  if (op === 'exists')
    conditionValue = true;

  if (op === 'in' && !Array.isArray(conditionValue))
    throw whereError('where op "in" requires an array value');

  return { field, op, value: conditionValue };
}

function conditionsForField(fieldName, spec) {
  let field = normalizeField(fieldName);

  if (Array.isArray(spec))
    return [ { field, op: 'in', value: spec } ];

  if (spec && typeof spec === 'object') {
    let keys = Object.keys(spec);
    if (keys.some((key) => key === 'op' || key === 'operator' || key === 'value')) {
      return [ normalizeCondition({ ...spec, field: spec.field ?? field }) ];
    }

    let conditions = [];
    for (let [rawOp, value] of Object.entries(spec)) {
      let op = normalizeOperator(rawOp);
      let conditionValue = op === 'exists' ? true : value;
      if (op === 'in' && !Array.isArray(conditionValue))
        throw whereError('where op "in" requires an array value');
      conditions.push({ field, op, value: conditionValue });
    }

    if (conditions.length === 0)
      throw whereError(`where field "${field}" has no operator`);

    return conditions;
  }

  return [ { field, op: 'eq', value: spec } ];
}

function parseConditionString(value) {
  let match = /^\s*([A-Za-z0-9_.-]+)\s*(?:=|:)\s*(?:(eq|ne|gt|gte|lt|lte|in|contains|prefix|exists)\b\s*:?\s*)?(.*?)\s*$/i.exec(value);
  if (!match)
    throw whereError(`where condition "${value}" is not understood; ${WHERE_SHAPE_HELP}`);

  let field = normalizeField(match[1]);
  let op = normalizeOperator(match[2] || 'eq');
  let raw = match[3] ?? '';

  if (op === 'exists')
    return { field, op, value: true };

  let conditionValue = parseScalar(raw);
  if (op === 'in' && !Array.isArray(conditionValue))
    throw whereError('where op "in" requires an array value, for example name=in:["a","b"]');

  return { field, op, value: conditionValue };
}

function parseScalar(value) {
  let text = String(value ?? '').trim();
  if (text === '')
    return '';

  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
    return text.slice(1, -1);

  try {
    return JSON.parse(text);
  } catch (_error) {
    return text;
  }
}

function splitTopLevel(value, separator) {
  let parts = [];
  let current = '';
  let depth = 0;
  let quote = '';

  for (let index = 0; index < value.length; index += 1) {
    let char = value[index];

    if (quote) {
      current += char;
      if (char === quote && value[index - 1] !== '\\')
        quote = '';
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === '[' || char === '{' || char === '(') {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ']' || char === '}' || char === ')') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }

    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  parts.push(current);
  return parts;
}

function normalizeField(value) {
  let field = typeof value === 'string' ? value.trim() : '';
  if (!field)
    throw whereError('where condition requires a non-empty field');
  return field;
}

function normalizeOperator(value) {
  let op = typeof value === 'string' ? value.trim().replace(/^\$/, '').toLowerCase() : '';
  if (!op)
    throw whereError('where condition requires an operator');
  if (!OPERATORS.has(op))
    throw whereError(`unsupported where operator: ${op}`);
  return op;
}

function whereError(message) {
  let error = new TypeError(`${message}. ${WHERE_SHAPE_HELP}`);
  error.code = 'INVALID_WHERE';
  return error;
}
