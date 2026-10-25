'use strict';

export function pathsFromItems(items = []) {
  let paths = [];
  for (let item of items) {
    if (item?.path)
      paths.push(item.path);
    else if (item?.['@path'])
      paths.push(item['@path']);
  }

  return paths;
}

export async function readJSONFiles(aeordb, paths, options = {}) {
  if (paths.length === 0)
    return [];

  if (typeof aeordb.fetchFiles === 'function') {
    try {
      let batch = await aeordb.fetchFiles(paths, options.fetchOptions);
      let reads = [];
      for (let path of paths) {
        // `continueOnError` also covers a single document that will not parse.
        // One malformed frame must not fail the whole page: the filtered window
        // hydrates a page of bodies at once, so a bad frame used to turn an
        // entire session's thread into an HTTP 500 while every other frame in
        // that page was perfectly readable. Recording it per path lets the
        // caller surface a visible load-error instead of losing the page.
        if (options.continueOnError) {
          try {
            reads.push({ path, value: parseFetchedJSON(path, batch?.[path]) });
          } catch (error) {
            reads.push({ path, error });
          }
          continue;
        }

        reads.push({ path, value: parseFetchedJSON(path, batch?.[path]) });
      }

      return reads;
    } catch (error) {
      if (!options.fallbackOnBatchError)
        throw error;
    }
  }

  let reads = [];
  for (let path of paths) {
    try {
      reads.push({ path, value: await aeordb.getFile(path) });
    } catch (error) {
      if (!options.continueOnError)
        throw error;

      reads.push({ path, error });
    }
  }

  return reads;
}

function parseFetchedJSON(path, entry) {
  if (entry == null) {
    let error = new Error(`AeorDB multi-fetch omitted ${path}`);
    error.status = 404;
    throw error;
  }

  let content = hasOwn(entry, 'content') ? entry.content : entry;
  if (content == null)
    return null;

  if (typeof content !== 'string')
    return content;

  try {
    return JSON.parse(content);
  } catch (error) {
    // The realistic corruption is a JSON escape that does not exist, most often
    // `\$` — shells and regexes hand that spelling to whatever wrote the body,
    // but JSON has no `\$` escape and `JSON.parse` rejects the whole document.
    //
    // The repair is deliberately narrow: drop the stray backslash only where the
    // escape is genuinely invalid, so a body holding `\\$` (an escaped backslash,
    // which is valid JSON) is left byte-for-byte alone. If the repaired text
    // still does not parse, the original error is what the caller sees — a guess
    // that half-parses is worse than an honest, visible failure.
    let repaired = repairInvalidEscapes(content);
    if (repaired !== content) {
      try {
        return JSON.parse(repaired);
      } catch {}
    }

    throw new Error(`AeorDB multi-fetch returned non-JSON content for ${path}: ${error.message}`);
  }
}

// JSON's only valid escapes are " \ / b f n r t and uXXXX. A backslash that
// introduces anything else is unambiguously not an escape — but only when it is
// not itself escaped, which is why the run of preceding backslashes decides:
// `\\$` is a literal backslash followed by `$` and stays untouched, while `\$`
// has exactly one reading, a literal `$`, so the backslash goes.
const INVALID_ESCAPE = /(^|[^\\])((?:\\\\)*)\\(?!["\\/bfnrtu])/g;

function repairInvalidEscapes(text) {
  return text.replace(INVALID_ESCAPE, '$1$2');
}

function hasOwn(value, key) {
  return value != null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}
