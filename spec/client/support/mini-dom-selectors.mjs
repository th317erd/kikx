'use strict';

// CSS-ish selector matching for the mini DOM. Supports tag, `.class`, `#id`,
// `*`, and descendant combinator only — enough for the client-component specs.

function parseCompound(compound) {
  // `[attr^=]`, `[attr$=]`, `[attr*=]`, `[attr~=]` and `[attr|=]` are not
  // implemented. Silently ignoring them would make a query match everything or
  // nothing while the spec still "passes"; fail loud instead.
  if (/\[[^\]]*[~|^$*]=[^\]]*\]/.test(compound))
    throw new Error(`mini-dom-selectors: unsupported attribute operator in "${compound}"`);

  let result = { tag: null, classes: [], id: null, attributes: [] };
  if (!compound || compound === '*')
    return result;

  let tagMatch = /^([a-zA-Z][\w-]*|\*)/.exec(compound);
  if (tagMatch && tagMatch[1] !== '*')
    result.tag = tagMatch[1].toLowerCase();

  let remainder = tagMatch ? compound.slice(tagMatch[0].length) : compound;
  for (let className of remainder.match(/\.[\w-]+/g) || [])
    result.classes.push(className.slice(1));
  let idMatch = firstMatch(/#[\w-]+/, remainder);
  if (idMatch)
    result.id = idMatch.slice(1);
  for (let match of remainder.matchAll(/\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g))
    result.attributes.push({ name: match[1], value: match[2] ?? null });

  return result;
}

function firstMatch(pattern, value) {
  let match = pattern.exec(value);
  return match ? match[0] : null;
}

function elementMatches(element, compound) {
  if (element.nodeType !== 1)
    return false;

  let spec = parseCompound(compound);
  let localName = element.localName || String(element.tagName || '').toLowerCase();
  if (spec.tag && localName !== spec.tag)
    return false;
  if (spec.id && element.getAttribute('id') !== spec.id)
    return false;
  for (let attribute of spec.attributes) {
    let value = element.getAttribute(attribute.name);
    if (value === null || value === undefined)
      return false;
    if (attribute.value !== null && String(value) !== attribute.value)
      return false;
  }
  for (let className of spec.classes) {
    if (!element.classList.contains(className))
      return false;
  }
  return true;
}

export function matchesSelector(element, compounds) {
  let index = compounds.length - 1;
  if (!elementMatches(element, compounds[index]))
    return false;

  index--;
  let current = element.parentNode;
  while (index >= 0 && current && current.nodeType === 1) {
    if (elementMatches(current, compounds[index]))
      index--;
    current = current.parentNode;
  }
  return index < 0;
}

export function collectDescendants(node, out) {
  for (let child of node.childNodes) {
    if (child.nodeType === 1) {
      out.push(child);
      collectDescendants(child, out);
    }
  }
  return out;
}

export function matchesAnySelector(element, selector) {
  for (let group of splitSelectorGroups(selector)) {
    let compounds = group.split(/\s+/).filter(Boolean);
    if (compounds.length > 0 && matchesSelector(element, compounds))
      return true;
  }
  return false;
}

export function queryAll(root, selector) {
  let groups = splitSelectorGroups(selector);
  if (groups.length === 0)
    return [];
  let seen = new Set();
  let out = [];
  for (let element of collectDescendants(root, [])) {
    if (seen.has(element))
      continue;
    if (!matchesAnySelector(element, selector))
      continue;
    seen.add(element);
    out.push(element);
  }
  return out;
}

// Split a comma-separated selector list without splitting commas inside an
// attribute value or quoted string. The mini DOM previously treated the whole
// list as one compound, so a production selector such as
// ".title, .active, h2" silently matched nothing in the specs.
function splitSelectorGroups(selector) {
  let groups = [];
  let current = '';
  let quote = '';
  let depth = 0;
  for (let char of String(selector || '')) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '[') depth++;
    if (char === ']') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      if (current.trim()) groups.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) groups.push(current.trim());
  return groups;
}
