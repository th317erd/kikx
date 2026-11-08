'use strict';

// The admin branches in this route family run before router.invoke(), which is what
// normally supplies a body reader, so they read the request themselves. Bounded because
// these payloads are a path, a name, or an npm spec; a malformed or oversized body
// returns null rather than a partial parse, and the caller decides what a missing body
// means for its route.
export async function readBoundedJsonBody(request, limit = 4096) {
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
