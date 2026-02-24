/* eslint-disable max-classes-per-file */

// These error classes are designed to be thrown
// from anywhere in the application. These are
// needed because code might not always have
// access to controller error methods.
// The controllers are designed (controller-base.js)
// to catch these errors, and convert them to
// controller error calls.

export class ErrorBase extends Error {
  constructor(message, code) {
    super(message);

    Object.defineProperties(this, {
      'code': {
        writable:     true,
        enumberable:  false,
        configurable: true,
        value:        code,
      },
    });
  }
}

export class ForbiddenError extends ErrorBase {
  constructor(message, code) {
    super(message || 'Forbidden', code || 'operation-not-permitted');
  }
}

export class UnauthorizedError extends ErrorBase {
  constructor(message, code) {
    super(message || 'Unauthorized', code || 'unauthorized');
  }
}

export class NotFoundError extends ErrorBase {
  constructor(message, code) {
    super(message || 'Not Found', code || 'not-found');
  }
}

export class ValidationError extends ErrorBase {
  constructor(message, code) {
    super(message || 'Validation Error', code || 'validation-error');
  }
}
