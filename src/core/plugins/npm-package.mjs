'use strict';

// Campaign S3 (plan 5-S3): the plugin install endpoint accepts
// {npm:"<pkg[@version|range]>"} and then fetches and EXECUTES code from a
// registry. Validation is deliberately a strict regex — registry names and
// spaceless versions/ranges only — so git+ specs, file: references, URLs,
// argv flags and any whitespace never reach the network, let alone the
// tarball extractor. Every hostile shape returns null; the route answers 400.

const NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION_PATTERN = /^[0-9A-Za-z.^~<>=*|v-]+$/;
const MAX_INPUT = 512;
const MAX_VERSION = 64;

// Parses "<name>[@<version|spaceless range>]" into {name, version|null}.
// Scoped names ("@scope/name[@version]") work because the version separator
// is the LAST '@' — a leading '@' belongs to the scope. Returns null for
// anything that is not a plain registry package reference.
export function parseNpmPackageSpec(input) {
  if (typeof input !== 'string') return null;
  const spec = input.trim();
  if (!spec || spec.length > MAX_INPUT) return null;
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  const version = at > 0 ? spec.slice(at + 1) : null;
  if (name.endsWith('.tgz')) return null; // a tarball file, never a package spec
  if (!NAME_PATTERN.test(name)) return null;
  if (version !== null) {
    if (!version || version.length > MAX_VERSION) return null;
    if (!VERSION_PATTERN.test(version)) return null;
  }
  return { name, version };
}
