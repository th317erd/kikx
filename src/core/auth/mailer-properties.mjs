'use strict';

// P5 (plan: docs/plans/properties-store.md §6): the mailer configuration is
// ONE global, SECRET property in the properties store — the clean cut from
// <root>/.kikx/mailer.json. Nothing reads or writes that file anymore; a
// leftover is ignored by design (single configured-DB location, owner
// ruling). Boot and the settings endpoints share this reader.
//
// An UNDECRYPTABLE row (key absent, key_ref mismatch, tampered ciphertext)
// is NEVER a boot crash and NEVER a silent plaintext fallback: loud warn +
// { stored: null, error: 'undecryptable' } so the caller falls back to
// env/log defaults and GET can surface the flag (plan P5).

export const MAILER_PROPERTY_KEY = '/core/kikx/email/configuration';

const UNREADABLE_CODES = new Set([
  'property_envelope_key',
  'property_envelope_mismatch',
  'property_envelope_open',
  'property_encryption_key_format',
]);

export async function readStoredMailerSettings(facade, { logger = console } = {}) {
  if (!facade)
    return { stored: null, error: null };
  try {
    const row = await facade.read('core', { type: 'global', id: '' }, MAILER_PROPERTY_KEY);
    if (!row || row.deletedAt || row.value === null || row.value === undefined
      || typeof row.value !== 'object')
      return { stored: null, error: null };
    return { stored: row.value, error: null };
  } catch (error) {
    if (UNREADABLE_CODES.has(error?.code)) {
      logger.warn?.(`[kikx-mailer] stored configuration is UNREADABLE (${error.code}: ${error.message})`
        + ' — treating as unconfigured; check KIKX_PROPERTIES_ENCRYPTION_KEY');
      return { stored: null, error: 'undecryptable' };
    }
    throw error; // a real store failure must not be papered over as "unconfigured"
  }
}

export async function writeStoredMailerSettings(facade, stored, { updatedBy = 'core' } = {}) {
  if (!facade) {
    throw Object.assign(new Error('properties store unavailable'),
      { code: 'property_facade_unavailable', status: 503 });
  }
  // The WHOLE config is sealed — the password lives under the envelope
  // columns (plan §6); the settings route strips it before any response.
  await facade.write('core', { type: 'global', id: '' }, MAILER_PROPERTY_KEY, stored, {
    secret: true,
    updatedBy,
  });
  return stored;
}
