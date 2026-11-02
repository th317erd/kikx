'use strict';

// =============================================================================
// Plugin reload must actually reload the plugin, not just its entry file
// =============================================================================
// MEASURED PLATFORM DEFECT. plugin-loader.mjs imports a plugin with
//
//     await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
//
// which busts the cache for the ENTRY module only. Every module that entry
// imports statically -- `import { X } from './inbound-router.mjs'` -- is resolved
// to a URL with no query string, so Node caches it for the life of the process
// and returns the ORIGINAL parse on every later import.
//
// Proven with a minimal fixture, not inferred:
//
//     write sub.mjs  -> export const VALUE = 'OLD'
//     import entry?t=1            -> OLD
//     write sub.mjs  -> export const VALUE = 'NEW'
//     import entry?t=2            -> OLD     <-- the change never arrives
//
// CONSEQUENCE, measured live on 3003: a plugin reload returned HTTP 200,
// {"total":9,"failures":[]}, and the same pid kept serving -- everything looked
// correct -- while the new code in the plugin's own submodule was never entered.
// A real image-only Discord message was still dropped with
// 'empty_content_missing_intent' AFTER the fix that is supposed to deliver it
// had been reloaded. That is the exact class of defect this platform keeps
// producing: installed, reported successful, and never entered.
//
// WHY THIS MATTERS BEYOND ONE BUG. Plugin authors will put code in more than one
// file (this plugin already has gateway.mjs, inbound-router.mjs, message-split.mjs,
// sql/*). Without this, "plugins reload without a restart" is only true for
// single-file plugins, and a multi-file plugin silently runs stale code that no
// version string, log line, or health check will reveal.
//
// THE FIX. A plugin-scoped module cache namespace:
//
//   1. before a plugin (re)loads, bump a counter for that plugin root;
//   2. when any module UNDER that root is about to be resolved, append
//      `?kikx-plugin-reload=<counter>` to its URL, so the whole subtree is
//      re-parsed and re-evaluated from disk;
//   3. core modules and other plugins are untouched -- only URLs under a
//      registered plugin root are rewritten, so nothing global is invalidated.
//
// The hook is synchronous (module.registerHooks), so it runs in-process with no
// worker thread and cannot race a load. It is OFF unless a root is registered,
// which keeps ordinary server behaviour byte-identical.

import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// plugin root (resolved absolute path) -> generation counter
const generations = new Map();
// resolved absolute file paths currently governed by the hook
const roots = [];

let installed = false;
let hookError = null;

const QUERY_PARAM = 'kikx-plugin-reload';

function normalizeRoot(pluginRoot) {
  if (typeof pluginRoot !== 'string' || pluginRoot.trim() === '')
    throw new TypeError('plugin root must be a non-empty string');
  return path.resolve(pluginRoot).replace(/[/\\]+$/, '');
}

function isUnderRoot(filePath) {
  for (let root of roots) {
    if (filePath === root) return true;
    if (filePath.startsWith(root + path.sep)) return true;
  }
  return false;
}

function rootFor(filePath) {
  // Longest root wins, so a plugin nested inside another registered path still
  // resolves to its own generation counter rather than its parent's.
  let best = null;
  for (let root of roots) {
    if (filePath === root || filePath.startsWith(root + path.sep)) {
      if (!best || root.length > best.length) best = root;
    }
  }
  return best;
}

function installHook() {
  if (installed) return true;
  if (typeof registerHooks !== 'function') {
    hookError = 'module.registerHooks is unavailable in this Node version';
    return false;
  }
  try {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        let resolution = nextResolve(specifier, context);
        try {
          if (!resolution || typeof resolution.url !== 'string') return resolution;
          if (!resolution.url.startsWith('file:')) return resolution;

          let filePath = fileURLToPath(resolution.url);
          if (!isUnderRoot(filePath)) return resolution;

          let root = rootFor(filePath);
          let generation = generations.get(root) || 0;
          if (generation === 0) return resolution;

          let url = new URL(resolution.url);
          // A module may already carry the marker from an earlier load; replace it
          // rather than appending a second copy, so the URL stays canonical.
          url.searchParams.set(QUERY_PARAM, String(generation));
          return { ...resolution, url: url.href };
        } catch (_error) {
          // A hook that throws can take down an unrelated import. If anything about
          // this rewrite is unexpected, fall through to the unmodified resolution:
          // stale-but-working beats broken.
          return resolution;
        }
      },
    });
    installed = true;
    return true;
  } catch (error) {
    hookError = String(error?.message || error);
    return false;
  }
}

// Register a plugin root so its modules become reloadable. Idempotent.
export function registerReloadablePluginRoot(pluginRoot) {
  let root = normalizeRoot(pluginRoot);
  if (!roots.includes(root)) {
    roots.push(root);
    if (!generations.has(root)) generations.set(root, 0);
    // Sort so rootFor's longest-match scan is stable and predictable.
    roots.sort((left, right) => right.length - left.length);
  }
  return installHook();
}

// Invalidate everything under a plugin root. Call this BEFORE importing the
// plugin's entry module during a (re)load: it is what makes the entry's static
// imports come from disk rather than from the process cache.
export function invalidatePluginModules(pluginRoot) {
  let root = normalizeRoot(pluginRoot);
  let next = (generations.get(root) || 0) + 1;
  generations.set(root, next);
  return next;
}

// Introspection for the reload path and its spec. Deliberately small: this is a
// load-time mechanism, and anything more elaborate would be a second source of
// truth about what is loaded.
export function pluginModuleCacheState() {
  return {
    installed,
    hookError,
    roots: [ ...roots ],
    generations: Object.fromEntries(generations),
  };
}

// Test seam only: forget every registered root and the installed flag. The
// process-level hook itself cannot be removed, which is fine -- with no roots
// registered it has nothing to rewrite.
export function resetPluginModuleCacheForTests() {
  generations.clear();
  roots.length = 0;
}
