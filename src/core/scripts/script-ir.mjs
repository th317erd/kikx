'use strict';

import { MAX_BEHAVIOR_SCRIPT_LENGTH } from '../agents/script-limits.mjs';

// P5(a) — deterministic structural validation of compiled script IR
// (plan §12.2(5), §7 P5). The model is the compiler; this proves SHAPE only:
// every goto resolves, no empty handlers, size within the script cap,
// known version. Semantics stay with the model at execution time.

export const SCRIPT_IR_VERSION = 1;

// Carry-through normalizer for the agent-record field: accepts a plain
// object or null, drops anything else (validation is validateScriptIR's job).
export function normalizeScriptIRFieldValue(value) {
  if (value == null)
    return null;
  if (typeof value === 'object' && !Array.isArray(value))
    return value;
  return null;
}

const DIRECTIVE_KEYS = new Set([ 'goto', 'say', 'continue', 'ask', 'end' ]);

export function validateScriptIR(ir) {
  const errors = [];

  if (ir == null || typeof ir !== 'object' || Array.isArray(ir))
    return fail([ 'IR must be an object' ]);

  if (ir.version !== SCRIPT_IR_VERSION)
    errors.push(`unknown IR version: ${String(ir.version)} (expected ${SCRIPT_IR_VERSION})`);

  const serialized = safeSerialize(ir);
  if (serialized.length > MAX_BEHAVIOR_SCRIPT_LENGTH)
    errors.push(
      `IR size cap exceeded: ${serialized.length} > ${MAX_BEHAVIOR_SCRIPT_LENGTH} bytes`,
    );

  if (!Array.isArray(ir.phases) || ir.phases.length === 0) {
    errors.push('IR must declare at least one phase');
    return fail(errors);
  }

  if (ir.events != null && (typeof ir.events !== 'object' || Array.isArray(ir.events)))
    errors.push('events must be an object when present');

  const labels = [];
  const seen = new Set();
  for (const phase of ir.phases) {
    if (phase == null || typeof phase !== 'object') {
      errors.push('phase must be an object');
      continue;
    }
    const id = typeof phase.id === 'string' ? phase.id.trim() : '';
    if (id === '')
      errors.push('phase is missing a string id');
    else if (seen.has(id))
      errors.push(`duplicate phase id: ${id}`);
    else {
      seen.add(id);
      labels.push(id);
    }
  }

  for (const phase of ir.phases) {
    if (phase == null || typeof phase !== 'object')
      continue;
    const id = typeof phase.id === 'string' ? phase.id : '<missing id>';
    const branch = phase.branch;
    const phaseEvents = phase.events;
    const hasEvents = phaseEvents != null
      && typeof phaseEvents === 'object'
      && !Array.isArray(phaseEvents)
      && Object.keys(phaseEvents).length > 0;

    if (!Array.isArray(branch) || branch.length === 0) {
      if (!hasEvents)
        errors.push(`phase ${id}: no branch and no event handlers`);
      continue;
    }

    for (const arm of branch) {
      if (arm == null || typeof arm !== 'object') {
        errors.push(`phase ${id}: branch arm must be an object`);
        continue;
      }
      if (typeof arm.when !== 'string' || arm.when.trim() === '')
        errors.push(`phase ${id}: branch arm missing a "when" question`);
      const then = arm.then;
      if (!Array.isArray(then)) {
        errors.push(`phase ${id}: branch arm missing directive list`);
        continue;
      }
      if (then.length === 0) {
        errors.push(`phase ${id}: empty directive list for "${truncate(arm.when)}"`);
        continue;
      }
      for (const directive of then) {
        if (directive == null || typeof directive !== 'object' || Array.isArray(directive)) {
          errors.push(`phase ${id}: directive must be an object`);
          continue;
        }
        const keys = Object.keys(directive);
        if (keys.length === 0 || !keys.some((k) => DIRECTIVE_KEYS.has(k))) {
          errors.push(`phase ${id}: unknown directive ${truncate(JSON.stringify(directive))}`);
          continue;
        }
        if ('goto' in directive) {
          const target = directive.goto;
          if (typeof target !== 'string' || target.trim() === '')
            errors.push(`phase ${id}: goto requires a label string`);
          else if (!seen.has(target))
            errors.push(`phase ${id}: unknown label "${target}" in goto`);
        }
        if ('end' in directive)
          errors.push(`phase ${id}: "end" is not permitted — v1 has no terminal branch (§12.2(7))`);
        if ('say' in directive && (typeof directive.say !== 'string' || directive.say.trim() === ''))
          errors.push(`phase ${id}: say requires a non-empty string`);
      }
    }
  }

  if (errors.length > 0)
    return fail(errors);
  return { ok: true, errors: [], labels };
}

function fail(errors) {
  return { ok: false, errors };
}

function safeSerialize(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function truncate(text) {
  const value = String(text ?? '');
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}
