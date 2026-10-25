'use strict';

export {
  CORE_TAG_DEFINITIONS,
  OCR_PRIORITY_TAG,
  normalizeTagDefinition,
  normalizeTagDefinitions,
  normalizeTagInputList,
  registerBuiltInTagDefinitions,
  tagNumber,
  validateTagValue,
} from './tag-definitions.mjs';
export {
  DEFAULT_TAG_LIMIT,
  DEFAULT_TAG_ROOT,
  MAX_TAG_LIMIT,
  TagsStore,
  sanitizeTag,
} from './tag-store.mjs';
