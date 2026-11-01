'use strict';

export const BEHAVIOR_SCRIPT_FIELD = 'behaviorScript';

export const MAX_BEHAVIOR_SCRIPT_LENGTH = 16384;

export function normalizeBehaviorScript(value, fieldName = BEHAVIOR_SCRIPT_FIELD) {
  if (value == null)
    return '';

  if (typeof value !== 'string')
    throw new TypeError(`${fieldName} must be a string`);

  if (value.length > MAX_BEHAVIOR_SCRIPT_LENGTH)
    throw new TypeError(`${fieldName} must be ${MAX_BEHAVIOR_SCRIPT_LENGTH} characters or fewer`);

  return value;
}
