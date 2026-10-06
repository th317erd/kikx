'use strict';

import fs from 'node:fs/promises';
import { dirname } from 'node:path';

import { authError } from './auth-error.mjs';

const MAGIC_LINK_PATH = '/api/v1/auth/magic-link/verify';

// Dev mailer: writes the magic-link URL so a developer can click it from the
// server log. Mirrors AeorDB's AEORDB_LOG_MAGIC_LINKS behaviour. `log` may be a
// function, a logger with .info()/.error(), or omitted (console). When
// `logPath` is a non-empty string the same line is also appended to that file;
// a file write failure is reported as a warning and never fails the login.
export function createLogMailer({ log, logPath } = {}) {
  let write = resolveLog(log);
  let filePath = typeof logPath === 'string' && logPath.trim() !== '' ? logPath : '';

  async function appendToFile(message) {
    if (!filePath)
      return;

    try {
      await fs.mkdir(dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, `${message}\n`);
    } catch (error) {
      write(`[kikx-auth] unable to write magic-link log ${filePath}: ${error.message}`);
    }
  }

  return {
    async sendMagicLink({ to, url, code, expiresAt }) {
      let message = `[kikx-auth] magic link for ${to}: ${url} (code=${code} expires=${formatExpiry(expiresAt)})`;
      write(message);
      await appendToFile(message);
      return { to, url, code, expiresAt };
    },
  };
}

// Pluggable mailer factory. `log` mode is the default; `smtp` mode loads
// nodemailer lazily on first send so the package stays optional and a missing
// package surfaces as a clear authError instead of a boot failure.
export function createMailer(options = {}) {
  let { mode = 'log', log, logPath, smtpUrl, from = '' } = options;

  if (mode === 'log')
    return createLogMailer({ log, logPath });

  if (mode !== 'smtp')
    throw authError(400, 'invalid_mailer_mode', `Unknown mailer mode: ${mode}`);

  if (!smtpUrl)
    throw authError(500, 'smtp_unavailable', 'SMTP mailer requires smtpUrl');

  let transportPromise = null;
  let loadTransport = async () => {
    if (!transportPromise) {
      transportPromise = import('nodemailer').then((module) => {
        let nodemailer = module.default || module;
        return nodemailer.createTransport(smtpUrl);
      }).catch(() => {
        throw authError(500, 'smtp_unavailable', 'nodemailer is not installed');
      });
    }

    return await transportPromise;
  };

  return {
    async sendMagicLink({ to, url, code, expiresAt }) {
      let transport = await loadTransport();
      await transport.sendMail({
        from,
        to,
        subject: 'Sign in to Kikx',
        text: `Sign in to Kikx: ${url}\n\nThis link expires ${formatExpiry(expiresAt)}.`,
        html: `<p><a href="${escapeHtml(url)}">Sign in to Kikx</a></p>`,
      });

      return { to, url, code, expiresAt };
    },
  };
}

// Absolute URL when publicURL is configured, otherwise a root-relative path.
// `redirect` is only added when a redirectTo value is supplied.
export function buildMagicLinkURL({ publicURL = '', code, redirectTo } = {}) {
  let params = new URLSearchParams();
  params.set('code', String(code ?? ''));
  if (redirectTo)
    params.set('redirect', String(redirectTo));

  let query = params.toString();
  if (!publicURL)
    return `${MAGIC_LINK_PATH}?${query}`;

  let base = String(publicURL).replace(/\/+$/, '');
  let url = new URL(`${base}${MAGIC_LINK_PATH}`);
  url.search = query;
  return url.toString();
}

function resolveLog(log) {
  if (typeof log === 'function')
    return log;

  if (log && typeof log.info === 'function')
    return (message) => log.info(message);

  if (log && typeof log.log === 'function')
    return (message) => log.log(message);

  return (message) => console.log(message);
}

function formatExpiry(expiresAt) {
  let date = new Date(Number(expiresAt));
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'unknown';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
