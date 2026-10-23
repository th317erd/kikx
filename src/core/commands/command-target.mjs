'use strict';

// Shared shallow target parsing for slash commands. It is intentionally not a
// shell parser: one quoted name, or an optional agent:/team: prefix.
export function parseCommandTarget(args, options = {}) {
  let usage = options.usage || 'A target is required.';
  if (typeof args !== 'string' || args.trim() === '')
    throw new Error(usage);

  let reference = unquoteReference(args.trim(), options.quoteUsage || usage);
  let match = reference.match(/^(agent|team):([\s\S]*)$/i);
  if (!match)
    return { type: '', reference };

  let type = match[1].toLowerCase();
  let allowed = Array.isArray(options.allowedTypes) ? options.allowedTypes : null;
  if (allowed && !allowed.includes(type))
    throw new Error(options.disallowedMessage || `${options.command || 'This command'} can only target an agent.`);

  let value = unquoteReference(match[2].trim(), options.prefixUsage || `Usage: ${options.command || 'command'} ${type}:name`);
  if (!value)
    throw new Error(options.prefixUsage || `Usage: ${options.command || 'command'} ${type}:name`);

  return { type, reference: value };
}

function unquoteReference(reference, usage) {
  let quote = reference[0];
  if ((quote === '"' || quote === "'") && reference.at(-1) === quote)
    return unescapeQuotedReference(reference.slice(1, -1), quote);

  if (quote === '"' || quote === "'")
    throw new Error(usage);

  return reference;
}

function unescapeQuotedReference(value, quote) {
  return value.replaceAll(`\\${quote}`, quote).replaceAll('\\\\', '\\').trim();
}
