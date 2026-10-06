'use strict';

// Shared document-store helpers used by every driver (and by the in-memory
// reference driver exercised in spec). Keeping one implementation is what makes
// the driver contract reproducible: path normalization, `list` ordering, glob
// matching and RFC-7386 merge-patch must behave identically across drivers.

// Normalize a document path to exactly one leading slash and no trailing slash.
export function normalizePath(path) {
  if (!path || typeof path !== 'string')
    throw new TypeError('Database path must be a non-empty string');

  let trimmed = path.replace(/^\/+/g, '').replace(/\/+$/g, '');
  return `/${trimmed}`;
}

export function basename(key) {
  return key.slice(key.lastIndexOf('/') + 1);
}

// Select the descendant paths of `prefix` that survive the recursive/glob
// filters, sorted by basename (then full path) so zero-padded frame filenames
// keep chronological order. Accepts any iterable of stored keys.
export function selectDocumentPaths(paths, prefix, options = {}) {
  let base = normalizePath(prefix);
  let recursive = options.recursive === true;
  let glob = options.glob || '**';
  let matches = [];

  for (let key of paths) {
    if (key === base || !key.startsWith(`${base}/`))
      continue;

    let relative = key.slice(base.length + 1);
    if (!recursive && relative.includes('/'))
      continue;

    if (!matchGlob(relative, glob))
      continue;

    matches.push(key);
  }

  matches.sort(compareByBasenameThenPath);
  return matches;
}

// Pagination is applied after selection so `total` is always the unconditional
// match count, not the page size.
export function paginate(matches, options = {}) {
  let offset = Number.isInteger(options.offset) && options.offset > 0 ? options.offset : 0;
  let limit = Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : null;
  return limit == null ? matches.slice(offset) : matches.slice(offset, offset + limit);
}

function compareByBasenameThenPath(left, right) {
  let leftBase = basename(left);
  let rightBase = basename(right);
  if (leftBase < rightBase)
    return -1;
  if (leftBase > rightBase)
    return 1;

  return left < right ? -1 : left > right ? 1 : 0;
}

// Minimal glob supporting `*` (within a segment) and `**` (across segments).
export function matchGlob(relativePath, pattern) {
  let pathSegments = relativePath.split('/');
  let patternSegments = pattern.split('/');
  return matchSegments(pathSegments, 0, patternSegments, 0);
}

function matchSegments(pathSegments, pathIndex, patternSegments, patternIndex) {
  while (patternIndex < patternSegments.length) {
    let patternSegment = patternSegments[patternIndex];

    if (patternSegment === '**') {
      // `**` matches zero or more path segments.
      if (patternIndex === patternSegments.length - 1)
        return true;

      for (let skip = pathIndex; skip <= pathSegments.length; skip++) {
        if (matchSegments(pathSegments, skip, patternSegments, patternIndex + 1))
          return true;
      }

      return false;
    }

    if (pathIndex >= pathSegments.length)
      return false;

    if (!matchSegment(pathSegments[pathIndex], patternSegment))
      return false;

    pathIndex++;
    patternIndex++;
  }

  return pathIndex === pathSegments.length;
}

function matchSegment(value, pattern) {
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}

// RFC 7386 JSON merge-patch (recursive object merge; null deletes).
export function applyMergePatch(target, patch) {
  if (!isPlainObject(patch))
    return patch;

  let output = isPlainObject(target) ? { ...target } : {};
  for (let [ key, value ] of Object.entries(patch)) {
    if (value === null)
      delete output[key];
    else
      output[key] = applyMergePatch(output[key], value);
  }

  return output;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
