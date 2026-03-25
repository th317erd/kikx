'use strict';

// =============================================================================
// SelectorCompiler — CSS-selector-inspired frame matcher compiler
// =============================================================================
// Parses selector strings into matcher functions at registration time.
//
// Supported selectors:
//   type:UserMessage         → frame.type === 'UserMessage'
//   type:*                   → catch-all (matches any frame)
//   author:agent             → frame.authorType === 'agent'
//   type:ToolCall[toolName=shell:execute]
//                            → frame.type === 'ToolCall' AND
//                              frame.content.toolName === 'shell:execute'
//   (function)               → pass through as-is
// =============================================================================

// Regex: selector like  type:value   or   author:value
//   optionally followed by [prop=value]
let SELECTOR_RE = /^(type|author):([^\[]+)(?:\[([^\]=]+)=([^\]]+)\])?$/;

export class SelectorCompiler {
  // Compile a selector (string or function) into a matcher function.
  // The returned function takes a frame and returns true/false.
  static compile(selector) {
    if (typeof selector === 'function')
      return selector;

    if (typeof selector !== 'string' || selector.length === 0)
      throw new Error(`Invalid selector: expected a non-empty string or function, got ${typeof selector}`);

    let match = SELECTOR_RE.exec(selector);

    if (!match)
      throw new Error(`Invalid selector syntax: "${selector}"`);

    let dimension = match[1];  // 'type' or 'author'
    let value     = match[2];  // e.g. 'UserMessage', '*', 'agent'
    let propName  = match[3];  // e.g. 'toolName' (optional)
    let propValue = match[4];  // e.g. 'shell:execute' (optional)

    // Wildcard: type:*
    if (dimension === 'type' && value === '*') {
      if (propName)
        throw new Error(`Invalid selector: wildcard type:* cannot have property matchers`);

      return () => true;
    }

    // Author matcher: author:agent
    if (dimension === 'author') {
      if (propName)
        throw new Error(`Invalid selector: author selectors do not support property matchers`);

      return (frame) => frame.authorType === value;
    }

    // Type matcher without property: type:user-message
    if (!propName)
      return (frame) => frame.type === value;

    // Type matcher with property: type:tool-call[toolName=shell:execute]
    return (frame) => {
      if (frame.type !== value)
        return false;

      let content = frame.content;
      if (!content || typeof content !== 'object')
        return false;

      return content[propName] === propValue;
    };
  }
}
