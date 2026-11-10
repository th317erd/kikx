'use strict';

// The install surface — POST /api/v1/plugins/install accepting {path} OR
// {npm} (campaign S3, plan 5-S3) — extracted from plugin-routes.mjs so each
// admin endpoint stays reviewable under the source line limits. Everything
// else about the branch is unchanged: identity first, config gate second,
// strict spec validation before any fetch, sha512 verification before any
// extraction, staging + atomic swap, the shared load/migrations/rollback
// pipeline (the S4 signature gate rides along), durable runtime-path append,
// and provenance tags on success.

import fs from 'node:fs';
import path from 'node:path';

import { readBoundedJsonBody } from './bounded-json-body.mjs';
import { PLUGIN_ADMIN_ACTIONS, requireOperator } from './plugin-admin-policy.mjs';

export async function handlePluginInstall({ request, response, context }) {
  // Identity first, config gate second. The config flag answers "is this deployment
  // willing to install at runtime"; it never answered "is this caller allowed to", and
  // anyone who can reach the port inherits it.
  const gate = await requireOperator(context, request, PLUGIN_ADMIN_ACTIONS.INSTALL);

  let registry = context.has?.('pluginRegistry') ? context.require('pluginRegistry') : null;
  if (!registry) {
    response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: { message: 'plugin registry unavailable' } }));
    return true;
  }

  // Installing loads code from an arbitrary path into this process. Denied unless the
  // operator has explicitly turned it on - an open install endpoint is remote code
  // execution with a JSON body.
  let enabled = false;
  let config = context.has?.('config') ? context.require('config') : null;
  try {
    if (config && typeof config.get === 'function') {
      const { KIKX_PLUGIN_INSTALL_ENABLED_PATH } = await import('../../core/config/config-paths.mjs');
      let value = await config.get(KIKX_PLUGIN_INSTALL_ENABLED_PATH);
      enabled = value === true || value === 'true' || value === '1';
    }
  } catch (_e) { enabled = false; }
  if (!enabled) {
    response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      error: {
        message: 'plugin install is disabled',
        hint: 'set KIKX_PLUGIN_INSTALL_ENABLED=true to allow installing code at runtime',
      },
    }));
    return true;
  }

  // Bounded: an install payload is {path} or {npm} — never both.
  let body = await readBoundedJsonBody(request);
  let pathInput = typeof body?.path === 'string' ? body.path.trim() : '';
  let npmInput = typeof body?.npm === 'string' ? body.npm : '';
  let target = '';
  // Provenance (plan 10.4): recorded for BOTH shapes on success.
  let source = null;
  const answerError = (status, message, hint) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: { message, ...(hint ? { hint } : {}) } }));
    return true;
  };
  if (pathInput && npmInput)
    return answerError(400, 'install takes either a path or an npm spec, not both');
  if (!pathInput && !npmInput)
    return answerError(400, 'install requires a path', 'send {path:"/abs/dir"} or {npm:"pkg[@version]"}');

  if (pathInput) {
    if (!pathInput.startsWith('/'))
      return answerError(400, 'install path must be absolute');
    target = pathInput;
    source = { type: 'path', ref: target, registry: null };
  } else {
    // --- npm branch (campaign S3, plan 5-S3): resolve against configured
    // registries, verify dist.integrity sha512, extract with tarbomb
    // guards into staging, swap atomically. The injected fetch seam
    // (pluginNpmRegistryFetch) exists for tests; production rides fetch.
    const { parseNpmPackageSpec } = await import('../../core/plugins/npm-package.mjs');
    const parsed = parseNpmPackageSpec(npmInput);
    if (!parsed)
      return answerError(400, 'invalid npm package spec — registry names and spaceless versions/ranges only',
        'expected <name>[@version] or <name>[@range], e.g. kikx-plugin-echo@^1.2.0');
    const { resolvePackage, downloadTarball } = await import('../../core/plugins/npm-registry.mjs');
    const { extractTarball } = await import('../../core/plugins/npm-tar.mjs');
    const { resolveNpmPluginBase, npmPluginDirFor } = await import('../../core/plugins/plugin-paths.mjs');
    const { runtimeRootForConfig } = await import('../../core/config/runtime-plugin-paths.mjs');
    const { KIKX_PLUGIN_REGISTRY_URLS_PATH, KIKX_PLUGIN_NPM_DIR_PATH } = await import('../../core/config/config-paths.mjs');
    const registryUrls = config && typeof config.get === 'function' ? await config.get(KIKX_PLUGIN_REGISTRY_URLS_PATH) : undefined;
    const npmDirConfig = config && typeof config.get === 'function' ? await config.get(KIKX_PLUGIN_NPM_DIR_PATH) : undefined;
    const fetchImpl = context.has?.('pluginNpmRegistryFetch') ? context.require('pluginNpmRegistryFetch') : globalThis.fetch;
    const npmBase = resolveNpmPluginBase({ npmDir: npmDirConfig, cwd: await runtimeRootForConfig(config) });

    let meta;
    try {
      meta = await resolvePackage(parsed.name, parsed.version, { registryUrls, fetchImpl });
    } catch (error) {
      return answerError(502, `registry resolution failed: ${String(error?.error || error?.message || error)}`);
    }
    if (meta?.error)
      return answerError(meta.error === 'version-not-found' ? 404 : 502, `registry resolution failed: ${meta.error}`);
    let tarballBytes;
    try {
      tarballBytes = await downloadTarball(meta, { fetchImpl });
    } catch (error) {
      return answerError(502, `tarball download rejected: ${String(error?.error || error?.message || error)}`);
    }
    // Stage, extract (guards run against the staging tree only), then swap
    // atomically — a failed extract leaves no target and no staging dir.
    const dest = npmPluginDirFor(npmBase, meta.name);
    const staging = path.join(npmBase,
      `.staging-${meta.name.replace(/[^a-z0-9._-]/gi, '_')}-${process.pid}-${Date.now().toString(36)}`);
    try {
      fs.mkdirSync(npmBase, { recursive: true });
      extractTarball(tarballBytes, staging);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(staging, dest);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      return answerError(502, `tarball rejected: ${String(error?.error || error?.message || error)}`);
    }
    target = dest;
    source = { type: 'npm', ref: `${meta.name}@${meta.version}`, registry: meta.registry };
  }

  let before = new Set((registry._pluginRegistrations || new Map()).keys());
  let failuresBefore = (registry._pluginLoadErrors || []).length;
  // Plugins this install brought in - not plugins that were already loaded. The
  // distinction is the whole safety property here: migrations.run() applies every
  // registered directory, so a migration failure is not attributable to one plugin, and
  // unloading "everything that declared migrations" would tear down plugins that were
  // installed and healthy before this request arrived.
  let added = [];
  try {
    const { loadPlugins } = await import('../../core/plugins/plugin-loader.mjs');
    // Disable flag honoured here too (plan 9.1.2): installing a path whose
    // BASENAME is disabled must not sneak it past the flag — Enable is the
    // only action that clears it. cwd comes from the same runtime-root
    // resolution every other runtime-file reader uses.
    const { disabledSkipKeys } = await import('../../core/config/runtime-disabled-plugins.mjs');
    const { runtimeRootForConfig } = await import('../../core/config/runtime-plugin-paths.mjs');
    await loadPlugins({
      pluginPaths: target,
      registry,
      commandRegistry: context.require('commandRegistry'),
      context,
      disabledNames: disabledSkipKeys({ cwd: await runtimeRootForConfig(config) }),
    });

    // Computed before migrations run, for the reason above: if the migration step
    // throws, this is the only accurate record of what this request added.
    added = [...(registry._pluginRegistrations || new Map()).keys()].filter((k) => !before.has(k));

    // Migrations run at startup, so a plugin installed afterwards has registered its
    // SQL and never had it applied - it would load and then fail on its first query.
    // Run them here for exactly this install.
    if (context.has?.('pluginMigrations')) {
      let outcome = await context.require('pluginMigrations').run({ logger: console });
      // run() returns { skipped, reason } when it does nothing. Discarding that made a
      // silent skip indistinguishable from a silent success.
      if (outcome?.skipped)
        console.warn('[plugin-install] migrations skipped:', outcome.reason);
      else
        console.warn('[plugin-install] migrations applied:', JSON.stringify(context.require('pluginMigrations').applied || []));
    }
  } catch (error) {
    // An install that reports failure must not leave the plugin running. The load above
    // succeeded, so the registry now holds a plugin whose SQL was never applied: its
    // mount is reachable and its first query fails at the caller's expense. Answering
    // 500 while keeping it loaded also makes a retry install it a second time.
    //
    // Only `added` is undone. Plugins that predate this request keep working even
    // though the failing directory may be shared with them.
    let unloaded = [];
    for (let name of added) {
      try {
        const { unloadPlugin } = await import('../../core/plugins/plugin-loader.mjs');
        await unloadPlugin(registry, name, { logger: console });
        unloaded.push(name);
      } catch (unloadError) {
        // A rollback failure must not replace the migration failure the caller needs to
        // see. It is reported alongside instead of masking it.
        console.warn(`[plugin-install] failed to unload "${name}" after a failed install:`, unloadError?.message);
      }
    }
    response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      error: { message: String(error?.message || error) },
      data: { path: target, added, unloaded },
    }));
    return true;
  }

  // Bookkeeping that must not survive a failed install, and must survive a
  // successful one: the durable runtime path list (ConfigStore is
  // read-only — reload reads this file) and provenance tags (inventory).
  // Runs after the rollback window: a bookkeeping hiccup warns loudly
  // rather than pretending a loaded plugin failed to install.
  if (added.length && source) {
    try {
      if (source.type === 'npm') {
        const { appendRuntimePluginPath, runtimeRootForConfig } = await import('../../core/config/runtime-plugin-paths.mjs');
        appendRuntimePluginPath(target, { cwd: await runtimeRootForConfig(config) });
      }
      if (context.has?.('tagsStore')) {
        const tags = context.require('tagsStore');
        const value = JSON.stringify(source);
        for (const name of added)
          await tags.upsertTag({ target_type: 'plugin', target_id: name, name: 'source', value });
      }
    } catch (error) {
      console.warn('[plugin-install] provenance/runtime-path bookkeeping failed:', error?.message);
    }
  }

  let after = new Set((registry._pluginRegistrations || new Map()).keys());
  // `added` was computed before migrations ran; nothing loads during the migration step.
  let newFailures = (registry._pluginLoadErrors || []).slice(failuresBefore);

  // S5: ONE announce per successful action — every failure above returned
  // early, so whatever reaches here actually loaded (or cleanly no-op'd).
  const { publishPluginChanged, actorFromGate } = await import('../plugin-changed.mjs');
  publishPluginChanged(context, { pluginID: added[0] ?? null, action: 'install', actor: actorFromGate(gate) });

  response.writeHead(added.length ? 201 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({
    data: { path: target, source, added, total: after.size, failures: newFailures },
  }));
  return true;
}
