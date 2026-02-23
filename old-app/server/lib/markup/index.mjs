'use strict';

// ============================================================================
// Hero Markup Language (HML) - Module Exports
// ============================================================================

export {
  extractExecutableElements,
  replaceWithResult,
  injectResults,
  hasExecutableElements,
  elementToAssertion,
} from './parser.mjs';

export {
  processMarkup,
  processMarkupWithBroadcast,
} from './executor.mjs';

export {
  StreamingHMLParser,
  createStreamParser,
  EXECUTABLE_ELEMENTS,
  ALL_ELEMENTS,
} from './stream-parser.mjs';
