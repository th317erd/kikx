'use strict';

// Shared HTTP fakes for plugin route specs (search/updates/install family):
// minimal request/response/context doubles matching what handlePluginRoutes
// actually touches. Kept tiny on purpose — anything richer belongs in the
// real modules the specs are exercising.

export function fakeResponse() {
  return {
    statusCode: 0, headersSent: false, body: null,
    writeHead(code) { this.statusCode = code; this.headersSent = true; return this; },
    end(payload) { if (payload !== undefined) this.body = String(payload); },
    destroy() { this.headersSent = true; },
  };
}

export function fakeRequest({ method = 'GET', url = '/', body = '', headers = {} } = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  return {
    method, url, headers,
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
  };
}

export function fakeContext(services) {
  return {
    has: (key) => Object.prototype.hasOwnProperty.call(services, key),
    require: (key) => {
      if (!Object.prototype.hasOwnProperty.call(services, key)) throw new Error(`no service "${key}"`);
      return services[key];
    },
    get: (key) => services[key],
  };
}

// A router that exists (the handler refuses to run without one) but mounts nothing:
// CORE admin branches must answer without falling through to the mount matcher.
export const noMounts = { match: () => null, listMounts: () => [] };

export const operator = { resolveIdentity: async () => ({ id: 'operator-1' }) };
