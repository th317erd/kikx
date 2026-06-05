'use strict';

export function pathsFromItems(items = []) {
  let paths = [];
  for (let item of items) {
    if (item?.path)
      paths.push(item.path);
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
      for (let path of paths)
        reads.push({ path, value: parseFetchedJSON(path, batch?.[path]) });

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
    throw new Error(`AeorDB multi-fetch returned non-JSON content for ${path}: ${error.message}`);
  }
}

function hasOwn(value, key) {
  return value != null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}
