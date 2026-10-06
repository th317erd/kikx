'use strict';

// Boundary error for the auth core. Mirrors the httpError convention in
// src/server/http-helpers.mjs: an Error carrying a numeric .status and a
// machine-readable .code so routes can map it to an HTTP response without
// depending on this module.
export function authError(status, code, message) {
  let error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
