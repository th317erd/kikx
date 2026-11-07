'use strict';

// Routes /api/plugins/<id>/... to the plugin that owns that mount.
// Returns false when the path is not under a plugin mount, so the built-in chain continues.

import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ADMIN_ACTIONS, requireOperator } from './plugin-admin-policy.mjs';

// The admin branches below run before router.invoke(), which is what normally supplies a
// body reader, so they read the request themselves. Bounded because these payloads are a
// path or a name; a malformed or oversized body returns null rather than a partial parse,
// and the caller decides what a missing body means for its route.
async function readBoundedJsonBody(request, limit = 4096) {
  try {
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limit) throw new Error('payload too large');
      chunks.push(chunk);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
  } catch (_e) { return null; }
}

export async function handlePluginRoutes({ request, response, url, context, json, rawBody }) {
  let router = null;
  try {
    router = context.has?.('pluginRouter') ? context.require('pluginRouter') : null;
  } catch (_error) {
    router = null;
  }

  if (!router || typeof router.match !== 'function')
    return false;

  // Plugin inventory. Read-only, but NOT public: it discloses which plugins are loaded,
  // their directory names, and which ones failed to load. Gated before the body is read.
  if (url.pathname === '/api/v1/plugins' && request.method === 'GET') {
    await requireOperator(context, request, PLUGIN_ADMIN_ACTIONS.INVENTORY);

    let registry = context.has?.('pluginRegistry') ? context.require('pluginRegistry') : null;
    let map = registry?._pluginRegistrations;
    let records = map instanceof Map ? [...map.values()] : [];
    let bus = context.has?.('pluginEventBus') ? context.require('pluginEventBus') : null;
    let routerForList = context.has?.('pluginRouter') ? context.require('pluginRouter') : null;
    // Mount descriptors keyed once, so each plugin row can report the auth declaration
    // and the limits actually enforced on it. Campaign 4.3 says a public mount "must be
    // declared and reviewed"; that is only reviewable if the declaration is visible to
    // an operator without reading the plugin's source.
    let mountsById = new Map((routerForList?.listMounts?.() || []).map((m) => [ m.pluginId, m ]));
    // S2: every record says whether its location is MANAGED (operator-owned
    // configured path) — bundled platform code is not, and the card's
    // "Internal Plugin — cannot be uninstalled" notice plus the future
    // uninstall gate both read this. Classification fails CLOSED: an unknown
    // root is never managed.
    let configuredPaths = null;
    let config = context.has?.('config') ? context.require('config') : null;
    // Reported alongside the inventory so Settings → Plugins can show the
    // unsafe-mode banner from the same authoritative answer the gate uses.
    let signatureMode = null;
    try {
      if (config && typeof config.get === 'function') {
        const { KIKX_PLUGIN_PATHS_PATH, KIKX_PLUGIN_SIGNATURE_MODE_PATH } = await import('../../core/config/config-paths.mjs');
        configuredPaths = await config.get(KIKX_PLUGIN_PATHS_PATH);
        const mode = await config.get(KIKX_PLUGIN_SIGNATURE_MODE_PATH);
        if (typeof mode === 'string' && mode.trim() !== '')
          signatureMode = mode.trim();
      }
    } catch (_e) { configuredPaths = null; }
    if (signatureMode === null) {
      const { snapshotEnvironment } = await import('../../core/config/env-loader.mjs');
      const ambient = snapshotEnvironment();
      const fromEnv = typeof ambient.KIKX_PLUGIN_SIGNATURE_MODE === 'string'
        ? ambient.KIKX_PLUGIN_SIGNATURE_MODE.trim() : '';
      signatureMode = fromEnv || 'required';
    }
    const { isManagedPluginLocation } = await import('../../core/plugins/plugin-paths.mjs');
    // Managed ground (S3): configured paths + the durable runtime list +
    // the npm landing root — every place a location can legitimately come
    // from. Unknown roots still fail closed (never managed).
    let managedRoots = configuredPaths;
    try {
      const { mergePluginPaths, resolveNpmPluginBase } = await import('../../core/plugins/plugin-paths.mjs');
      const { runtimePathsForConfig, runtimeRootForConfig } = await import('../../core/config/runtime-plugin-paths.mjs');
      const { KIKX_PLUGIN_NPM_DIR_PATH } = await import('../../core/config/config-paths.mjs');
      const npmDir = config && typeof config.get === 'function' ? await config.get(KIKX_PLUGIN_NPM_DIR_PATH) : undefined;
      const cwd = await runtimeRootForConfig(config);
      managedRoots = mergePluginPaths(
        configuredPaths || [],
        await runtimePathsForConfig(config),
        resolveNpmPluginBase({ npmDir, cwd }),
      );
    } catch (_e) { managedRoots = configuredPaths; }
    // Provenance lookup (plan 10.4): install-time tag, absent = null.
    let tagsStore = context.has?.('tagsStore') ? context.require('tagsStore') : null;
    async function sourceFor(name) {
      if (!tagsStore || typeof tagsStore.getTag !== 'function') return null;
      try {
        const tag = await tagsStore.getTag({ target_type: 'plugin', target_id: name, name: 'source' });
        return JSON.parse(tag.value);
      } catch { return null; }
    }

    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      data: {
        plugins: await Promise.all(records.map(async (r) => ({
          name: r.pluginName,
          // Directories only, never absolute paths: an authenticated caller still does not
          // need the operator's filesystem layout.
          location: r.pluginLocation || null,
          // S3 (plan 10.4): provenance recorded at install time, plus whether
          // the load proves a signature: 'required' mode means the gate inside
          // loadPlugins admitted it (loaded = verified → true); 'unsafe' proves
          // nothing, reported honestly as unknown (null).
          source: await sourceFor(r.pluginName),
          signed: signatureMode === 'required' ? true : null,
          // Managed classification runs on the REAL directory (pluginPath),
          // never the display token: inventory location is deliberately
          // `basename#hash`, which resolves under no root and would fail
          // closed forever. pluginPath stays out of the response — the
          // operator's filesystem layout is not disclosed by listing.
          managed: isManagedPluginLocation(r.pluginPath, { configuredPaths: managedRoots ?? configuredPaths }),
          mounted: mountsById.has(r.pluginName),
          mount: mountsById.has(r.pluginName)
            ? {
              auth: mountsById.get(r.pluginName).auth ?? null,
              maxBodyBytes: mountsById.get(r.pluginName).maxBodyBytes ?? null,
              handlerTimeoutMS: mountsById.get(r.pluginName).handlerTimeoutMS ?? null,
            }
            : null,
          subscriptions: bus?.list?.().find((s) => s.pluginId === r.pluginName) || null,
          manifest: r.manifest || null,
        }))),
        failures: registry?._pluginLoadErrors || [],
        signatureMode,
        // A class override does not change a live instance (campaign §8.1.5). create-server
        // resolves FrameRouter before plugins load, so a plugin override of it changes the
        // registry row while the router that is serving requests keeps executing core. Listing
        // those keys here is the difference between "the platform says it is overridden" and
        // "the platform says this needs a restart to become true".
        restartRequired: typeof registry.listRestartRequired === 'function'
          ? registry.listRestartRequired()
          : [],
        // Keys a plugin overrode where nothing in the running system resolves through
        // the class registry (interface base classes imported and `extends`-ed,
        // frame-type keys no production caller passes a registry for). Distinct from
        // restartRequired on purpose: a restart cannot make these take effect, so
        // reporting them there would promise a fix the platform cannot deliver.
        inertOverrides: typeof registry.listInertOverrides === 'function'
          ? registry.listInertOverrides()
          : [],
      },
    }));
    return true;
  }

  // Install a plugin from a directory, without a restart. Takes the path directly rather
  // than re-reading configuration: KIKX_PLUGIN_PATHS is an environment variable a running
  // process cannot re-read, which is why reload alone could never find a new plugin.
  if (url.pathname === '/api/v1/plugins/install' && request.method === 'POST') {
    // Identity first, config gate second. The config flag answers "is this deployment
    // willing to install at runtime"; it never answered "is this caller allowed to", and
    // anyone who can reach the port inherits it.
    await requireOperator(context, request, PLUGIN_ADMIN_ACTIONS.INSTALL);

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
      await loadPlugins({
        pluginPaths: target,
        registry,
        commandRegistry: context.require('commandRegistry'),
        context,
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

    response.writeHead(added.length ? 201 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      data: { path: target, source, added, total: after.size, failures: newFailures },
    }));
    return true;
  }

  // Re-scan plugin paths without restarting. Installs a plugin by putting a directory
  // where the boot would find it, then asking for a reload. This previously had no gate
  // at all, unlike install, even though it also executes newly discovered plugin code.
  if (url.pathname === '/api/v1/plugins/reload' && request.method === 'POST') {
    await requireOperator(context, request, PLUGIN_ADMIN_ACTIONS.RELOAD);

    // Re-read the env file before anything loads. The launchers load it once, before
    // spawning this process, so a key added afterwards - a bot token, a channel
    // binding - is invisible to a config store that only ever sees `process.env`.
    // Without this a reload cannot apply the configuration it was performed for, and
    // the only remaining way to apply it is a restart - which is the guarantee this
    // platform rejects. Only keys the file owns are updated, so a deliberate shell
    // override such as KIKX_PORT stays pinned.
    let envRefresh = null;
    try {
      const { refreshEnvFromFile } = await import('../../core/config/env-refresh.mjs');
      envRefresh = await refreshEnvFromFile();
    } catch (error) {
      // A broken env file must not break the lifecycle: report it and continue with
      // whatever the process already holds.
      envRefresh = {
        skipped: 'error',
        error: String(error?.message || error),
        added: [], updated: [], pinned: [],
      };
    }

    let registry = context.has?.('pluginRegistry') ? context.require('pluginRegistry') : null;
    // Re-read the configured paths rather than using the boot snapshot: installing a
    // plugin means adding a directory to the configuration, and a reload that scans the
    // old list can never find it.
    let pluginPaths = null;
    try {
      let config = context.has?.('config') ? context.require('config') : null;
      if (config && typeof config.get === 'function') {
        const { KIKX_PLUGIN_PATHS_PATH } = await import('../../core/config/config-paths.mjs');
        pluginPaths = await config.get(KIKX_PLUGIN_PATHS_PATH);
      }
    } catch (_e) { pluginPaths = null; }
    if (!pluginPaths && context.has?.('pluginPaths'))
      pluginPaths = context.require('pluginPaths');
    // S3: runtime installs append to <cwd>/.kikx/plugin-paths.json (ConfigStore
    // is read-only) — a reload must scan them too, or an npm install would
    // live exactly until something else reloaded the configured list.
    try {
      const { mergePluginPaths } = await import('../../core/plugins/plugin-paths.mjs');
      const { runtimePathsForConfig } = await import('../../core/config/runtime-plugin-paths.mjs');
      const cfg = context.has?.('config') ? context.require('config') : null;
      const merged = mergePluginPaths(pluginPaths || [], await runtimePathsForConfig(cfg));
      if (merged.length) pluginPaths = merged;
    } catch (_e) { /* keep the configured list */ }
    if (!registry || !pluginPaths) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'plugin reload is unavailable' } }));
      return true;
    }
    let before = new Set((registry._pluginRegistrations || new Map()).keys());
    try {
      const { loadPlugins } = await import('../../core/plugins/plugin-loader.mjs');
      await loadPlugins({ pluginPaths, registry, commandRegistry: context.require('commandRegistry'), context });
      let after = new Set((registry._pluginRegistrations || new Map()).keys());
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        data: {
          added: [...after].filter((k) => !before.has(k)),
          total: after.size,
          failures: registry._pluginLoadErrors || [],
          // Reported rather than only logged: an operator reloading a plugin to pick
          // up new configuration needs to see whether that configuration was re-read.
          env: envRefresh,
        },
      }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: String(error?.message || error) } }));
    }
    return true;
  }

  // Remove a loaded plugin without restarting the process.
  //
  // unloadPlugin() has long had a complete contract - mount, event subscriptions,
  // migrations, scoped database handle, plugin authority, class overrides - and
  // spec/plugins/plugin-unload-spec.mjs pins each of those. But nothing in the HTTP
  // surface reached it, so the only way to stop a plugin was to restart the server, and
  // the P7 exit criterion (install/reload/unload demonstrated against a live server) was
  // not reachable at all. This route is the missing surface, not new machinery.
  //
  // It does not remove the plugin's DIRECTORY. Unloading is a runtime action; whether the
  // code is still on disk is a configuration question, and deleting files from an admin
  // endpoint would be a destructive act nobody asked this route to perform. So an unload
  // followed by a reload of the configured paths will find the directory again and bring
  // the plugin back - deliberately, and it is reported in the response for that reason.
  if (url.pathname === '/api/v1/plugins/unload' && request.method === 'POST') {
    await requireOperator(context, request, PLUGIN_ADMIN_ACTIONS.UNLOAD);

    let registry = context.has?.('pluginRegistry') ? context.require('pluginRegistry') : null;
    if (!registry) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'plugin registry unavailable' } }));
      return true;
    }

    let body = await readBoundedJsonBody(request);
    let name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'unload requires a plugin name' } }));
      return true;
    }

    let map = registry._pluginRegistrations;
    // An unknown name is a 404, never a 200 with unloaded:false. This request is the one
    // that would have stopped a plugin, so a caller who named the wrong plugin must not
    // be answered in a way that reads as "it is stopped now".
    if (!(map instanceof Map) || !map.has(name)) {
      response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        error: { message: 'plugin "' + name + '" is not loaded' },
        data: { name, loaded: map instanceof Map ? [ ...map.keys() ] : [] },
      }));
      return true;
    }

    let location = map.get(name)?.pluginLocation || null;
    try {
      const { unloadPlugin } = await import('../../core/plugins/plugin-loader.mjs');
      let removed = await unloadPlugin(registry, name, { logger: console });
      // unloadPlugin() answers false when the record vanished between the check above and
      // the call. Reporting success there would claim a teardown that never happened.
      if (removed === false) {
        response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          error: { message: 'plugin "' + name + '" could not be unloaded' },
        }));
        return true;
      }
      let remaining = registry._pluginRegistrations instanceof Map
        ? [ ...registry._pluginRegistrations.keys() ]
        : [];
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        data: {
          name,
          unloaded: true,
          location,
          total: remaining.length,
          loaded: remaining,
        },
      }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: String(error?.message || error) } }));
    }
    return true;
  }

  let match = router.match(url.pathname);
  if (!match)
    return false;

  await router.invoke({ match, request, response, context });
  return true;
}
