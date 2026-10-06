'use strict';

// Boundary error type for every database driver. Kept free of any AeorDB (or
// other driver) import so callers can catch 404s without pulling in a client.
export class DatabaseError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'DatabaseError';
    this.status = options.status ?? 0;
    this.code = options.code ?? null;
    this.cause = options.cause ?? undefined;
  }

  get notFound() {
    return this.status === 404;
  }

  static forStatus(status, message) {
    return new DatabaseError(message || defaultMessageForStatus(status), {
      status,
      code: codeForStatus(status),
    });
  }

  static notFound(path) {
    return new DatabaseError(`Database document not found: ${path}`, {
      status: 404,
      code: 'not_found',
    });
  }
}

function defaultMessageForStatus(status) {
  if (status === 404)
    return 'HTTP 404 Not Found';

  if (status === 401)
    return 'HTTP 401 Unauthorized';

  if (status === 403)
    return 'HTTP 403 Forbidden';

  if (status === 409)
    return 'HTTP 409 Conflict';

  if (status === 500)
    return 'HTTP 500 Internal Server Error';

  return `HTTP ${status} Error`;
}

function codeForStatus(status) {
  if (status === 404)
    return 'not_found';

  if (status === 401)
    return 'unauthorized';

  if (status === 403)
    return 'forbidden';

  if (status === 409)
    return 'conflict';

  return null;
}
