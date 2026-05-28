'use strict';

// =============================================================================
// FilesystemPluginProvider
// =============================================================================
// Discovers plugins from filesystem directories.
// Each plugin is a folder containing an index.mjs with a setup export.
// Constructor takes an array of directory paths to scan.
// =============================================================================

import { PluginProvider } from './plugin-provider.mjs';
import { readdir }       from 'node:fs/promises';
import { join }          from 'node:path';
import { stat }          from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export class FilesystemPluginProvider extends PluginProvider {
  /**
   * @param {string[]} directories - Array of directory paths to scan for plugins
   */
  constructor(directories) {
    super();

    /** @type {string[]} */
    this._directories = Array.isArray(directories)
      ? directories.slice()
      : [];

    /** @type {Map<string, string>} Cache: pluginName -> absolute path to index.mjs */
    this._resolved = new Map();
  }

  /**
   * @returns {Promise<string[]>}
   */
  async discover() {
    let names = [];

    this._resolved.clear();

    for (let directory of this._directories) {
      let entries;

      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        // Directory doesn't exist or can't be read — skip silently
        if (error.code === 'ENOENT' || error.code === 'EACCES')
          continue;

        throw error;
      }

      for (let entry of entries) {
        if (!entry.isDirectory())
          continue;

        let indexPath = join(directory, entry.name, 'index.mjs');

        try {
          let info = await stat(indexPath);
          if (info.isFile()) {
            names.push(entry.name);
            this._resolved.set(entry.name, indexPath);
          }
        } catch (_error) {
          // No index.mjs — not a plugin folder, skip
        }
      }
    }

    return names;
  }

  /**
   * @param {string} name
   * @returns {Promise<{ setup: Function }>}
   */
  async load(name) {
    let filePath = this._resolved.get(name);

    if (!filePath)
      throw new Error(`Plugin "${name}" not found in FilesystemPluginProvider`);

    let fileURL = pathToFileURL(filePath).href;
    let module  = await import(fileURL);

    return module;
  }
}
