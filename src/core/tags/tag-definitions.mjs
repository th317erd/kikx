'use strict';

// Core tag definitions. A definition turns a tag name into a typed, meaningful
// data point. Plugins may register their own via `registerTagDefinition`.
//
// `priority: true` means higher numeric values are selected first when the core
// needs to pick one tagged actor for a role (leadership, compaction, OCR).

export const CORE_TAG_DEFINITIONS = [
  {
    name: 'leadership_score',
    label: 'Leadership score',
    description: 'Higher scores are selected first as the default/leader agent.',
    targetTypes: [ 'agent' ],
    type: 'integer',
    min: 0,
    max: 10,
    defaultValue: 0,
    priority: true,
    group: 'Agent roles',
    pluginID: 'core',
    agentAction: {
      icon: 'crown',
      className: 'kikx-agent-list__crown',
      activeClass: 'is-master',
      rankClass: 'kikx-agent-list__crown--rank-',
      label: 'Crown as master agent',
      activeLabel: 'Master agent',
      onValue: 10,
      offValue: 0,
      legacyToggle: 'crown',
    },
  },
  {
    name: 'compaction_score',
    label: 'Compaction bot score',
    description: 'Higher scores are preferred when choosing a designated compaction agent.',
    targetTypes: [ 'agent' ],
    type: 'integer',
    min: 0,
    max: 10,
    defaultValue: 0,
    priority: true,
    group: 'Agent roles',
    pluginID: 'core',
    agentAction: {
      icon: 'clamp',
      className: 'kikx-agent-list__compaction-bot',
      activeClass: 'is-compaction-bot',
      rankClass: 'kikx-agent-list__compaction-bot--rank-',
      label: 'Set as compaction bot',
      activeLabel: 'Compaction bot',
      onValue: 10,
      offValue: 0,
      legacyToggle: 'compaction',
    },
  },
  {
    name: 'ocr_score',
    label: 'OCR bot score',
    description: 'Higher scores are tried first for OCR requests; failures fall back to the next OCR agent.',
    targetTypes: [ 'agent' ],
    type: 'integer',
    min: 0,
    max: 10,
    defaultValue: 0,
    priority: true,
    group: 'Agent roles',
    pluginID: 'core',
    agentAction: {
      icon: 'eyeball',
      className: 'kikx-agent-list__ocr-bot',
      activeClass: 'is-ocr-bot',
      rankClass: 'kikx-agent-list__ocr-bot--rank-',
      label: 'Set as OCR bot',
      activeLabel: 'OCR bot',
      onValue: 10,
      offValue: 0,
    },
  },
];

export function registerBuiltInTagDefinitions(pluginRegistry) {
  if (!pluginRegistry?.registerTagDefinition)
    throw new TypeError('registerBuiltInTagDefinitions() requires a plugin registry');

  for (let definition of CORE_TAG_DEFINITIONS)
    pluginRegistry.registerTagDefinition(definition.name, definition);
}

export function normalizeTagDefinition(value = {}, fallbackName = '') {
  let name = normalizeName(value.name || fallbackName);
  let type = normalizeType(value.type);
  let definition = {
    name,
    label: normalizeOptionalString(value.label) || name,
    description: normalizeOptionalString(value.description),
    targetTypes: normalizeTargetTypes(value.targetTypes),
    type,
    defaultValue: value.defaultValue,
    priority: value.priority === true,
    group: normalizeOptionalString(value.group),
    pluginID: normalizeOptionalString(value.pluginID),
    agentAction: normalizeAgentAction(value.agentAction),
  };

  if (type === 'integer' || type === 'number') {
    if (value.min != null)
      definition.min = Number(value.min);
    if (value.max != null)
      definition.max = Number(value.max);
    if (value.step != null)
      definition.step = Number(value.step);
  }

  if (type === 'select' && Array.isArray(value.options))
    definition.options = value.options.map((option) => (
      typeof option === 'string'
        ? { value: option, label: option }
        : { value: String(option?.value ?? ''), label: String(option?.label ?? option?.value ?? '') }
    ));

  return definition;
}

export function normalizeTagDefinitions(values = []) {
  let definitions = [];
  for (let value of Array.isArray(values) ? values : []) {
    try {
      definitions.push(normalizeTagDefinition(value));
    } catch (_error) {}
  }

  return definitions;
}

function normalizeAgentAction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null;

  let icon = normalizeOptionalString(value.icon);
  if (!icon)
    return null;

  return {
    icon,
    className: normalizeOptionalString(value.className),
    activeClass: normalizeOptionalString(value.activeClass),
    rankClass: normalizeOptionalString(value.rankClass),
    label: normalizeOptionalString(value.label),
    activeLabel: normalizeOptionalString(value.activeLabel),
    onValue: normalizeActionValue(value.onValue, 10),
    offValue: normalizeActionValue(value.offValue, 0),
    legacyToggle: normalizeOptionalString(value.legacyToggle),
  };
}

function normalizeActionValue(value, fallback) {
  let number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function validateTagValue(definition, value) {
  if (!definition)
    return value;

  if (value == null)
    throw tagError(`Tag ${definition.name} requires a value`);

  switch (definition.type) {
    case 'integer': {
      let number = Number(value);
      if (!Number.isInteger(number))
        throw tagError(`Tag ${definition.name} must be an integer`);
      if (definition.min != null && number < definition.min)
        throw tagError(`Tag ${definition.name} must be at least ${definition.min}`);
      if (definition.max != null && number > definition.max)
        throw tagError(`Tag ${definition.name} must be at most ${definition.max}`);
      return number;
    }
    case 'number': {
      let number = Number(value);
      if (!Number.isFinite(number))
        throw tagError(`Tag ${definition.name} must be a number`);
      if (definition.min != null && number < definition.min)
        throw tagError(`Tag ${definition.name} must be at least ${definition.min}`);
      if (definition.max != null && number > definition.max)
        throw tagError(`Tag ${definition.name} must be at most ${definition.max}`);
      return number;
    }
    case 'boolean':
      if (typeof value !== 'boolean')
        throw tagError(`Tag ${definition.name} must be a boolean`);
      return value;
    case 'select': {
      let stringValue = String(value);
      if (definition.options?.length && !definition.options.some((option) => option.value === stringValue))
        throw tagError(`Tag ${definition.name} has an invalid value: ${stringValue}`);
      return stringValue;
    }
    default:
      if (typeof value !== 'string')
        throw tagError(`Tag ${definition.name} must be a string`);
      return value;
  }
}

export function normalizeTagInputList(values = [], options = {}) {
  let targetType = normalizeOptionalString(options.targetType) || 'agent';
  let targetID = normalizeOptionalString(options.targetID);
  let definitions = Array.isArray(options.definitions) ? options.definitions : [];
  let byName = new Map(definitions.map((definition) => [ definition.name, definition ]));
  let tags = [];
  let seen = new Set();

  for (let value of Array.isArray(values) ? values : []) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw tagError('tags must be an array of tag objects');

    let name = normalizeOptionalString(value.name);
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name))
      throw tagError('tag name must be a dotted identifier');

    let itemTargetType = normalizeOptionalString(value.target_type || value.targetType) || targetType;
    let itemTargetID = normalizeOptionalString(value.target_id || value.targetID) || targetID;
    if (itemTargetType !== targetType)
      throw tagError(`tag ${name} targets ${itemTargetType}, expected ${targetType}`);
    if (targetID && itemTargetID && itemTargetID !== targetID)
      throw tagError(`tag ${name} targets ${itemTargetID}, expected ${targetID}`);

    if (seen.has(name))
      continue;
    seen.add(name);

    tags.push({
      target_type: targetType,
      target_id: itemTargetID,
      name,
      value: value.value == null ? null : validateTagValue(byName.get(name), value.value),
    });
  }

  return tags;
}

export function tagNumber(value) {
  let number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeName(value) {
  let name = normalizeOptionalString(value);
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name))
    throw new TypeError('tag definition name must be a dotted identifier');
  return name;
}

function normalizeType(value) {
  let type = normalizeOptionalString(value).toLowerCase() || 'text';
  if (![ 'text', 'string', 'integer', 'number', 'boolean', 'select' ].includes(type))
    throw new TypeError(`Unsupported tag type: ${type}`);
  return type === 'string' ? 'text' : type;
}

function normalizeTargetTypes(value) {
  let list = Array.isArray(value) ? value : [ 'agent' ];
  let types = [];
  for (let item of list) {
    let type = normalizeOptionalString(item);
    if (type && !types.includes(type))
      types.push(type);
  }
  return types.length > 0 ? types : [ 'agent' ];
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function tagError(message) {
  let error = new Error(message);
  error.status = 400;
  return error;
}
