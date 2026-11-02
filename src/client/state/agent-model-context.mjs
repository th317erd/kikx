'use strict';

// Context-window defaults for the agent form.
//
// A blank `contextWindowTokens` used to read as "you must guess a number", even
// though providers can discover a model's real window. These helpers derive the
// default from the selected model's config-field option, while preserving any
// explicit human override.

const CONTEXT_FIELD = 'contextWindowTokens';
const MODEL_FIELD = 'model';

function positiveWindow(value) {
  let number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
}

function modelField(provider) {
  return (provider?.configFields || []).find((field) => field?.name === MODEL_FIELD) || null;
}

function modelOptions(provider) {
  let field = modelField(provider);
  return Array.isArray(field?.options) ? field.options : [];
}

export function contextWindowForModel(provider, modelID) {
  let id = typeof modelID === 'string' ? modelID : '';
  if (!id)
    return null;

  let option = modelOptions(provider).find((candidate) => String(candidate?.value ?? candidate?.id ?? '') === id);
  return positiveWindow(option?.contextWindow);
}

export function isAutoContextWindowValue(provider, value) {
  if (value === null || value === undefined || value === '')
    return true;

  let number = positiveWindow(value);
  if (number === null)
    return false;

  return modelOptions(provider).some((option) => positiveWindow(option?.contextWindow) === number);
}

export function seedContextWindowForModel(provider, config, { onlyAuto = true } = {}) {
  let source = config && typeof config === 'object' ? { ...config } : {};
  let hasField = (provider?.configFields || []).some((field) => field?.name === CONTEXT_FIELD);
  if (!hasField)
    return source;

  let current = source[CONTEXT_FIELD];
  if (onlyAuto && !isAutoContextWindowValue(provider, current))
    return source;

  let window = contextWindowForModel(provider, source[MODEL_FIELD]);
  if (window === null) {
    // The previous model's auto value would be a lie for an unknown model.
    if (current !== null && current !== undefined && current !== '' && isAutoContextWindowValue(provider, current))
      source[CONTEXT_FIELD] = null;
    return source;
  }

  source[CONTEXT_FIELD] = window;
  return source;
}
