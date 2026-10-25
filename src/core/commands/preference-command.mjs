'use strict';

import {
  normalizePreferenceKey,
  normalizePreferences,
  normalizePreferenceValue,
  SESSION_PREFERENCE_DEFAULTS,
} from '../preferences/index.mjs';
import { resolveService } from '../runtime/frame-runtime-normalize.mjs';

export const PREFERENCE_COMMAND_USAGE = [
  'Usage: /pref <command>',
  '  /pref set <key> <value>   Set this session\'s own value',
  '  /pref unset <key>         Remove this session\'s own value',
  '  /pref get <key>           Show the effective value',
  '  /pref list                List effective preferences',
  '',
  'Values: true/false, numbers, or a string (quote strings containing spaces).',
  'Preferences cascade from parent sessions; the nearest ancestor wins.',
].join('\n');

// A generic, command-based preference editor with cascading inheritance.
//
//   /pref set ocr.image_proxy false
//   /pref unset ocr.image_proxy
//   /pref get ocr.image_proxy
//   /pref list
//
// The session manifest stores only the session's own values. Effective values
// are resolved by reading the ancestor chain, so a child automatically inherits
// a parent's later changes unless the child set the same key itself.
export class PreferenceCommand {
  static description = 'Get, set, unset, or list cascading session preferences.';
  static usage = PREFERENCE_COMMAND_USAGE;
  static aliases = [ 'prefs', 'preference', 'preferences' ];

  constructor(context = {}) {
    this.context = context;
  }

  async execute({ args, frame, session, services }) {
    let parsed;
    try {
      parsed = parsePreferenceCommand(args);
    } catch (error) {
      return { status: 'error', message: error.message };
    }

    if (parsed.action === 'help')
      return { status: 'ok', message: PREFERENCE_COMMAND_USAGE };

    let frameRuntime = resolveService(services, 'frameRuntime');
    if (!frameRuntime)
      throw new Error('/pref requires a frame runtime');

    let sessionID = frame?.sessionID || session?.id;
    if (!sessionID)
      throw new Error('/pref requires a session');

    let currentSession = frameRuntime.getSession?.(sessionID) || session;
    if (!currentSession?.id) {
      let error = new Error(`Unknown session: ${sessionID}`);
      error.status = 404;
      throw error;
    }

    let ownPreferences = normalizePreferences(currentSession.preferences);

    if (parsed.action === 'set') {
      let key = normalizePreferenceKey(parsed.key);
      let value = parsePreferenceLiteral(parsed.rawValue);
      ownPreferences = { ...ownPreferences, [key]: value };
      await frameRuntime.updateSession(sessionID, { preferences: ownPreferences });
      return await preferenceResult({
        action: 'set',
        message: `Set ${key} = ${formatPreferenceValue(value)} for this session.`,
        frameRuntime,
        sessionID,
        ownPreferences,
      });
    }

    if (parsed.action === 'unset') {
      let key = normalizePreferenceKey(parsed.key);
      let hadOwnValue = Object.hasOwn(ownPreferences, key);
      if (hadOwnValue) {
        let next = { ...ownPreferences };
        delete next[key];
        ownPreferences = next;
        await frameRuntime.updateSession(sessionID, { preferences: ownPreferences });
      }

      return await preferenceResult({
        action: 'unset',
        message: hadOwnValue
          ? `Unset ${key} on this session; it now inherits again.`
          : `${key} was not set on this session.`,
        frameRuntime,
        sessionID,
        ownPreferences,
        key,
      });
    }

    if (parsed.action === 'get') {
      let key = normalizePreferenceKey(parsed.key);
      let resolved = await resolvePreferences(frameRuntime, sessionID, ownPreferences);
      let found = Object.hasOwn(resolved.preferences, key);
      return {
        status: 'ok',
        message: found
          ? `${key} = ${formatPreferenceValue(resolved.preferences[key])}`
          : `${key} is not set.`,
        data: {
          action: 'get',
          sessionID,
          key,
          value: found ? resolved.preferences[key] : undefined,
          found,
          preferences: resolved.preferences,
          ownPreferences,
        },
      };
    }

    let resolved = await resolvePreferences(frameRuntime, sessionID, ownPreferences);
    let keys = Object.keys(resolved.preferences).sort();
    let lines = keys.map((key) => `${key} = ${formatPreferenceValue(resolved.preferences[key])}`);
    return {
      status: 'ok',
      message: lines.length > 0
        ? lines.join('\n')
        : 'No preferences are set.',
      data: {
        action: 'list',
        sessionID,
        preferences: resolved.preferences,
        ownPreferences,
        defaults: SESSION_PREFERENCE_DEFAULTS,
        keys,
      },
    };
  }
}

// Parse `/pref` arguments without touching session state. The value is kept as
// raw text until parsePreferenceLiteral() so quoting is handled in one place.
export function parsePreferenceCommand(args) {
  let text = typeof args === 'string' ? args.trim() : '';
  if (text === '' || text.toLowerCase() === 'help')
    return { action: 'help' };

  let match = text.match(/^([A-Za-z]+)(?:\s+([\s\S]*))?$/);
  if (!match)
    throw new Error(PREFERENCE_COMMAND_USAGE);

  let action = match[1].toLowerCase();
  let rest = (match[2] || '').trim();

  if (action === 'list') {
    if (rest !== '')
      throw new Error(`Usage: /pref list`);

    return { action };
  }

  if (action !== 'set' && action !== 'unset' && action !== 'get')
    throw new Error(`Unknown preference command: ${action}\n${PREFERENCE_COMMAND_USAGE}`);

  let split = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!split)
    throw new Error(`Usage: /pref ${action} <key>${action === 'set' ? ' <value>' : ''}`);

  let key = split[1];
  let remainder = (split[2] || '').trim();

  if (action === 'set') {
    if (remainder === '')
      throw new Error('Usage: /pref set <key> <value>');

    return { action, key, rawValue: remainder };
  }

  if (remainder !== '')
    throw new Error(`Usage: /pref ${action} <key>`);

  return { action, key };
}

export function parsePreferenceLiteral(rawValue) {
  let text = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (text === '')
    throw new Error('Preference value must not be empty');

  if ((text[0] === '"' || text[0] === "'")) {
    if (text.at(-1) !== text[0])
      throw new Error(`Malformed quoted preference value: ${text}`);

    let quote = text[0];
    let unescaped = text.slice(1, -1)
      .replaceAll(`\\${quote}`, quote)
      .replaceAll('\\\\', '\\');
    return normalizePreferenceValue(unescaped);
  }

  if (text === 'true')
    return true;

  if (text === 'false')
    return false;

  if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
    let number = Number(text);
    if (Number.isFinite(number))
      return number;
  }

  return normalizePreferenceValue(text);
}

export function formatPreferenceValue(value) {
  if (typeof value === 'string')
    return JSON.stringify(value);

  return String(value);
}

async function preferenceResult({ action, message, frameRuntime, sessionID, ownPreferences, key = null }) {
  let resolved = await resolvePreferences(frameRuntime, sessionID, ownPreferences);
  return {
    status: 'ok',
    message,
    data: {
      action,
      sessionID,
      ...(key ? { key } : {}),
      preferences: resolved.preferences,
      ownPreferences,
    },
  };
}

async function resolvePreferences(frameRuntime, sessionID, fallbackOwnPreferences) {
  if (typeof frameRuntime.getEffectivePreferences === 'function')
    return await frameRuntime.getEffectivePreferences(sessionID);

  // Older/embedded runtimes may lack the helper; return this session's own
  // values over the built-in defaults so the command remains usable.
  return {
    preferences: {
      ...SESSION_PREFERENCE_DEFAULTS,
      ...normalizePreferences(fallbackOwnPreferences),
    },
    ownPreferences: normalizePreferences(fallbackOwnPreferences),
  };
}
