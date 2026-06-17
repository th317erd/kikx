'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';

const DEFAULT_MAX_MATCHES = 50;

export class OutputGrepTool extends PluginInterface {
  static pluginID = 'internal:tool-output';
  static featureName = 'grep';
  static displayName = 'Search stored output';
  static description = 'Search a stored tool output by ID using a JavaScript regular expression.';
  static frameType = 'StoredOutputSearchToolFrame';
  static clientComponent = builtInToolComponent('kikx-output-grep-use');
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Tool output ID returned by a previous tool call.',
      },
      pattern: {
        type: 'string',
        description: 'Regular expression pattern to search for.',
      },
      flags: {
        type: 'string',
        description: 'Optional JavaScript RegExp flags such as i or m.',
      },
      maxMatches: {
        type: 'integer',
        minimum: 1,
        description: 'Maximum matching lines to return. Defaults to 50.',
      },
    },
    required: [ 'id', 'pattern' ],
    additionalProperties: false,
  };
  static help = 'Use output-grep to search a stored AeorDB tool output by regexp without manually reading the whole output.';

  async _execute(params = {}) {
    let store = resolveToolOutputStore(this.context);
    let output = await store.getToolOutput({
      id: params.id,
      full: true,
    });
    let pattern = normalizeRequiredString(params.pattern || params.regexp || params.regex, 'pattern');
    let flags = normalizeRegexFlags(params.flags);
    let maxMatches = clampInteger(params.maxMatches ?? params.limit, DEFAULT_MAX_MATCHES, 1, 500);
    let matches = grepText(output.content, pattern, flags, maxMatches);

    return {
      id: output.id,
      toolName: output.toolName,
      sizeBytes: output.sizeBytes,
      pattern,
      flags,
      matches,
      matchCount: matches.length,
      truncated: matches.length >= maxMatches,
    };
  }
}

function grepText(content, pattern, flags, maxMatches) {
  let regex = new RegExp(pattern, normalizeSearchFlags(flags));
  let matches = [];
  let byteOffset = 0;
  let lines = String(content ?? '').split(/\n/g);

  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    regex.lastIndex = 0;
    let match = regex.exec(line);
    if (match) {
      matches.push({
        lineNumber: index + 1,
        byteOffset,
        match: match[0],
        line,
      });
      if (matches.length >= maxMatches)
        break;
    }
    byteOffset += Buffer.byteLength(line) + 1;
  }

  return matches;
}

function normalizeSearchFlags(flags) {
  return normalizeRegexFlags(flags);
}

function normalizeRegexFlags(value) {
  let flags = typeof value === 'string' ? value.trim() : '';
  if (!/^[dgimsuvy]*$/.test(flags))
    throw new TypeError('flags contains unsupported regular expression flags');

  return Array.from(new Set(flags.replace(/g/g, '').split(''))).join('');
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

function clampInteger(value, defaultValue, min, max) {
  let number = Number(value);
  if (!Number.isFinite(number))
    number = defaultValue;

  number = Math.trunc(number);
  return Math.min(max, Math.max(min, number));
}

function resolveToolOutputStore(context = {}) {
  let service = context.toolOutputStore || context.services?.toolOutputStore || resolveContextService(context, 'toolOutputStore');
  if (!service?.getToolOutput)
    throw new Error('output-grep requires a toolOutputStore service');

  return service;
}

function resolveContextService(context, name) {
  let appContext = context.services?.context || context.context;
  if (appContext?.has?.(name) && typeof appContext.require === 'function')
    return appContext.require(name);

  if (typeof appContext?.require === 'function') {
    try {
      return appContext.require(name);
    } catch (_error) {
      return null;
    }
  }

  return null;
}
