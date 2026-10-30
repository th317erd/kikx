'use strict';

// Authorization for the plugin ADMIN surface.
//
// Two different things are protected here, and they are not the same thing:
//
//   /api/v1/plugins           inventory: which plugins are loaded, where they live on
//                             disk, and which ones FAILED to load.
//   /api/v1/plugins/install   install: loads code from an arbitrary path into this
//   /api/v1/plugins/reload    process. Reload picks up newly added directories too.
//
// Install already refused to run unless the operator set KIKX_PLUGIN_INSTALL_ENABLED.
// That is a config gate, not an authorization check: it answers "is this deployment
// willing to install at runtime", not "is this caller allowed to". A config flag is read
// from the environment, so anyone who can reach the port inherits the operator's
// decision. Both are now required.
//
// Reload had no gate at all. Inventory had none either, and it discloses the load-failure
// list and plugin directory names.
//
// PLUGIN ROUTE MOUNTS ARE DELIBERATELY NOT COVERED HERE. A mount handler
// (/api/plugins/<id>/...) is the plugin's own surface, and the plugin decides what a
// request means. Miri's mount serves /health to an unauthenticated deploy verifier
// (kikx-docker/verify-miri-plugin.sh), so forcing an identity onto mounts at this layer
// would break that verifier AND would be the wrong layer: per-route descriptors
// (auth: 'required' | 'public', capabilities) are the designed contract for mounts, and
// they are section 4.3 / P3 work. This module covers the CORE-owned admin endpoints only.

import { httpError } from '../http-helpers.mjs';

export const PLUGIN_ADMIN_ACTIONS = Object.freeze({
  // Read the plugin inventory, including load failures and plugin directory names.
  INVENTORY: 'plugins:inventory',
  // Load plugin code from a path, or re-scan the configured plugin paths.
  INSTALL: 'plugins:install',
  RELOAD: 'plugins:reload',
});

// ONE message for every unauthenticated rejection. The account store distinguishes
// "no token", "expired token" and "disabled user" in its own messages; forwarding those
// would turn this endpoint into an oracle for which of the three happened.
const UNAUTHENTICATED_MESSAGE = 'Sign in required to manage plugins';

// Resolve the caller's Kikx identity, or refuse.
//
// Returns `{ identity, unauthenticated }`. `unauthenticated: true` means this deployment
// has no account store wired at all, which is a deployment-capability fact rather than a
// credential failure; the caller decides what to do about it.
export async function resolveCaller(context, request) {
  let accountStore = null;
  try {
    accountStore = context?.has?.('accountStore') ? context.require('accountStore') : null;
  } catch (_error) {
    accountStore = null;
  }

  if (!accountStore || typeof accountStore.resolveIdentity !== 'function')
    return { identity: null, unauthenticated: true };

  try {
    return { identity: await accountStore.resolveIdentity(request), unauthenticated: false };
  } catch (error) {
    if (error?.status === 401)
      throw httpError(401, UNAUTHENTICATED_MESSAGE);

    // Anything else is a genuine fault (database down, store bug) and must not be
    // disguised as a credential problem, or a broken deployment looks like a bad token.
    throw error;
  }
}

// Refuse any caller that is not an authenticated Kikx identity.
//
// This fails closed, including in development. The campaign lists "whether plugin admin
// routes may ever be public by default in a development profile" as an OPEN question
// (section 5), so the conservative side of that question is the correct default: no
// bypass is invented here. A dev server that wants the admin surface sends a real token.
//
// There is no role or operator concept in Kikx today: `verifyAccessToken` yields a user
// identity and nothing carries an admin bit. So the strongest honest statement is "a valid
// Kikx identity is required". The capability half of the campaign requirement ("an
// explicit operator capability") needs a role model that does not exist yet; it is
// reported as missing rather than faked with a hardcoded user or role name.
export async function requireOperator(context, request, action) {
  let caller = await resolveCaller(context, request);

  if (caller.unauthenticated) {
    // Distinguishable from a wrong credential: nothing in this deployment can authenticate
    // anyone. Still a refusal, never an implicit allow.
    throw httpError(503, 'Plugin administration requires an account store in this deployment');
  }

  if (!caller.identity)
    throw httpError(401, UNAUTHENTICATED_MESSAGE);

  return { identity: caller.identity, action };
}
