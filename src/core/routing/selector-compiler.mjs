'use strict';

export class SelectorCompiler {
  static compile(selector) {
    if (typeof selector === 'function')
      return selector;

    if (!selector || typeof selector !== 'string')
      throw new TypeError('Selector must be a non-empty string or function');

    let trimmed = selector.trim();

    if (trimmed === '*' || trimmed === 'type:*' || trimmed === 'Type:*')
      return () => true;

    let matchers = [];
    let remaining = trimmed;

    let typeMatch = remaining.match(/^(?:type|Type):([A-Za-z0-9_*:-]+)/);
    if (typeMatch) {
      let type = typeMatch[1];
      matchers.push((frame) => type === '*' || frame.type === type);
      remaining = remaining.slice(typeMatch[0].length);
    }

    let authorMatch = remaining.match(/^(?:author|Author):([A-Za-z0-9_*:-]+)/);
    if (authorMatch) {
      let author = authorMatch[1];
      matchers.push((frame) => author === '*' || frame.authorType === author);
      remaining = remaining.slice(authorMatch[0].length);
    }

    let propertyMatches = Array.from(remaining.matchAll(/\[([^=\]]+)=([^\]]*)\]/g));
    for (let propertyMatch of propertyMatches) {
      let path = propertyMatch[1].trim();
      let expected = stripQuotes(propertyMatch[2].trim());
      matchers.push((frame) => String(readPath(frame, path)) === expected);
    }

    let consumedProperties = remaining.replace(/\[[^\]]+\]/g, '');
    if (consumedProperties.trim() !== '')
      throw new Error(`Invalid selector: ${selector}`);

    if (matchers.length === 0)
      throw new Error(`Invalid selector: ${selector}`);

    return (frame) => matchers.every((matcher) => matcher(frame));
  }
}

function readPath(object, path) {
  let current = object;
  for (let part of path.split('.')) {
    if (current == null)
      return undefined;

    current = current[part];
  }

  return current;
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    return value.slice(1, -1);

  return value;
}

