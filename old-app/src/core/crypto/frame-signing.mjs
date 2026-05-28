'use strict';

// =============================================================================
// Frame Authorship Signing
// =============================================================================
// Signs frame content with the author's Ed25519 private key before commit.
//
// Author types:
//   - 'agent'  → agent's decrypted private key (cached per interaction)
//   - 'user'   → user's decrypted private key (if available from UMK context)
//   - 'system' → system signing key (loaded on Keystore)
//
// Best-effort: returns null when signing is not possible (no keystore, no key,
// etc.). Never throws — the interaction loop must not crash because signing
// failed.
// =============================================================================

/**
 * Sign frame content for a given author.
 *
 * @param {import('../types').Keystore|null} keystore
 * @param {Record<string, any>|string|null} content
 * @param {'agent'|'user'|'system'|null} authorType
 * @param {string|null} privateKey - Pre-decrypted PEM private key for agent/user (null for system)
 * @returns {string|null} Hex signature string, or null if signing is not possible
 */
export function signFrameContent(keystore, content, authorType, privateKey) {
  if (!keystore)
    return null;

  if (content == null)
    return null;

  try {
    if (authorType === 'system')
      return keystore.systemSign(content);

    if (privateKey)
      return keystore.signWithPrivateKey(content, privateKey);

    return null;
  } catch (_error) {
    // Best-effort: signing failure must not crash the interaction loop
    return null;
  }
}

/**
 * Decrypt an agent's private key from its encrypted envelope.
 *
 * @param {import('../types').Keystore|null} keystore
 * @param {string|import('../types').EncryptedEnvelope|null} encryptedPrivateKey - JSON string or parsed envelope
 * @param {string|null} agentID - Agent ID used as SMK derivation context
 * @returns {string|null} PEM string, or null if decryption fails
 */
export function decryptAgentPrivateKey(keystore, encryptedPrivateKey, agentID) {
  if (!keystore || !encryptedPrivateKey || !agentID)
    return null;

  try {
    let envelope = (typeof encryptedPrivateKey === 'string')
      ? JSON.parse(encryptedPrivateKey)
      : encryptedPrivateKey;

    return keystore.decryptActorPrivateKey(envelope, agentID);
  } catch (_error) {
    return null;
  }
}
