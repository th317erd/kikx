'use strict';

// Settings → Email resolution (owner, 2026-11-13; reference UI: the
// Xenocept Email tab). P5 CLEAN CUT (plan §6): the durable home is the
// properties store — ONE global SECRET property
// (/core/kikx/email/configuration, envelope-sealed password). The
// .kikx/mailer.json reader/writer is GONE: nothing reads or writes that
// file anymore (a leftover file is ignored by design — single configured-DB
// location, owner ruling). STORED VALUES WIN FIELD-BY-FIELD over env (env
// stays the boot default; .env remains owner-owned). The password stays
// write-only end to end: sanitize strips it, GET reports passwordSet.
// Storage IO lives in mailer-properties.mjs; this module is pure mapping.

import { authError } from './auth-error.mjs';

const TLS_MODES = [ 'STARTTLS', 'SSL', 'none' ];

const DEFAULTS = Object.freeze({
  provider: 'log',
  host: '',
  port: 587,
  username: '',
  password: '',
  fromAddress: '',
  fromName: '',
  tls: 'STARTTLS',
});

function splitFromHeader(value) {
  const text = String(value ?? '').trim();
  const match = /^(.*?)\s*<([^>]+)>\s*$/.exec(text);
  if (match)
    return { fromName: (match[1] || '').trim(), fromAddress: match[2].trim() };
  return { fromAddress: text, fromName: '' };
}

function settingsFromLegacyEnv(env) {
  const out = {};
  const smtpUrl = typeof env.smtpUrl === 'string' ? env.smtpUrl.trim() : '';
  if (env.mode === 'smtp' || smtpUrl)
    out.provider = 'smtp';
  if (smtpUrl) {
    try {
      const url = new URL(smtpUrl);
      out.host = url.hostname;
      out.port = url.port ? Number(url.port) : (url.protocol === 'smtps:' ? 465 : 587);
      out.tls = url.protocol === 'smtps:' ? 'SSL' : 'STARTTLS';
      if (url.username) {
        out.username = decodeURIComponent(url.username);
        out.password = url.password ? decodeURIComponent(url.password) : '';
      }
    } catch (_error) { /* an unparseable URL just contributes nothing */ }
  }
  if (env.from) {
    Object.assign(out, splitFromHeader(env.from));
  }
  return out;
}

// The resolved view the form, the mailer factory and the endpoints all read:
// defaults <- env-derived <- STORED (field-by-field, non-empty stored values
// win — the same overlay rule the legacy file had, now over the property).
export function resolveMailerSettings({ env = {}, stored = null } = {}) {
  const merged = { ...DEFAULTS, ...settingsFromLegacyEnv(env) };
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const key of Object.keys(DEFAULTS)) {
      const value = stored[key];
      const present = key === 'port'
        ? Number.isInteger(value) && value > 0
        : typeof value === 'string' && value !== '';
      if (present)
        merged[key] = key === 'port' ? Number(value) : String(value);
    }
  }
  return merged;
}

// The form's POST: strict validation, authError(400) — never a 500 for
// operator typos.
export function validateMailerSettings(input = {}) {
  const s = input && typeof input === 'object' ? input : {};
  const bad = (message) => { throw authError(400, 'invalid_mailer_settings', message); };

  if (s.provider !== 'smtp')
    bad('provider must be smtp');
  if (typeof s.host !== 'string' || !s.host.trim() || /\s/.test(s.host))
    bad('host is required and cannot contain spaces');
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535)
    bad('port must be an integer between 1 and 65535');
  if (typeof s.fromAddress !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.fromAddress.trim()))
    bad('fromAddress must be an email address');
  if (!TLS_MODES.includes(s.tls))
    bad(`tls must be one of ${TLS_MODES.join(', ')}`);
  if (typeof s.username !== 'string' || s.username.length > 256)
    bad('username is too long');
  if (typeof s.password !== 'string' || s.password.length > 512)
    bad('password is too long');
  if (typeof s.fromName !== 'string' || s.fromName.length > 64)
    bad('fromName is too long');

  return {
    provider: 'smtp',
    host: String(s.host).trim(),
    port: Number(s.port),
    username: String(s.username ?? ''),
    password: String(s.password ?? ''),
    fromAddress: String(s.fromAddress).trim(),
    fromName: String(s.fromName ?? ''),
    tls: s.tls,
  };
}

// GET responses: the password NEVER leaves the server; passwordSet tells the
// form whether a stored one exists (the reference UI's "(stored on save)").
export function sanitizeMailerSettings(settings = {}) {
  const { password, ...rest } = settings;
  return { ...rest, passwordSet: typeof password === 'string' && password !== '' };
}

export function composeFrom({ fromAddress = '', fromName = '' } = {}) {
  const address = String(fromAddress || '').trim();
  const name = String(fromName || '').trim();
  if (name && address)
    return `${name} <${address}>`;
  return address;
}

// The three TLS choices map onto nodemailer's transport flags:
//   STARTTLS -> plain connection, upgrade REQUIRED
//   SSL      -> implicit TLS (smtps, typically 465)
//   none     -> plain, no upgrade required
export function nodemailerOptionsFrom(settings = {}) {
  const options = { host: settings.host, port: Number(settings.port) || 587 };
  options.secure = settings.tls === 'SSL';
  options.requireTLS = settings.tls === 'STARTTLS';
  if (settings.username) {
    options.auth = { user: settings.username, pass: settings.password || '' };
  }
  return options;
}

// createMailer's factory options from a resolved settings object — the one
// mapping used by boot AND the hot-swap on save (they can never drift).
export function mailerFactoryOptions(settings, { log, logPath } = {}) {
  if (!settings || settings.provider !== 'smtp')
    return { mode: 'log', log, logPath };
  return {
    mode: 'smtp',
    smtp: nodemailerOptionsFrom(settings),
    from: composeFrom(settings),
    log,
    logPath,
  };
}
