'use strict';

import XID           from 'xid-js';
import { signValue } from '../crypto/value-signing.mjs';

// =============================================================================
// ToolLogService — Stores tool execution outputs in ValueStore
// =============================================================================
// Called by InteractionLoop after every tool execution.
// Failures are best-effort: if storage fails, tool output is still delivered.
//
// ValueStore fields used:
//   - ownerType:  'agent'
//   - ownerID:    agentID
//   - namespace:  'tool_log'
//   - scopeID:    sessionID
//   - key:        'tl_<xid>'  (unique per execution)
//   - value:      JSON.stringify({ args: toolCallArgs, output })
//   - note:       human-readable summary (first arg value, query, or toolName)
//   - type:       'tool_log:<pluginID>:<toolName>'
// =============================================================================

function generateKey() {
  return `tl_${XID.next()}`;
}

// Derive a short human-readable note from the tool call arguments.
// - Shell tools (execute, run, bash, sh): use first argument value (the command)
// - Web search tools: use the query argument
// - Fallback: use the toolName
function deriveNote(toolName, pluginID, toolCallArgs) {
  if (!toolCallArgs || typeof toolCallArgs !== 'object')
    return toolName;

  let lowerTool   = (toolName   || '').toLowerCase();
  let lowerPlugin = (pluginID   || '').toLowerCase();

  // Shell-like tools: first string argument is the command
  if (
    lowerPlugin === 'shell'          ||
    lowerTool === 'execute'          ||
    lowerTool === 'run'              ||
    lowerTool === 'bash'             ||
    lowerTool === 'sh'
  ) {
    let vals = Object.values(toolCallArgs);
    let firstStr = vals.find((v) => typeof v === 'string');
    if (firstStr)
      return firstStr.slice(0, 256);
  }

  // Web search tools: use the query argument
  if (
    lowerPlugin === 'websearch'      ||
    lowerTool === 'websearch'        ||
    lowerTool === 'web_search'       ||
    lowerTool === 'search'
  ) {
    let query = toolCallArgs.query || toolCallArgs.q || toolCallArgs.search;
    if (typeof query === 'string')
      return query.slice(0, 256);
  }

  // Fallback: use toolName
  return toolName;
}

export class ToolLogService {

  // ---------------------------------------------------------------------------
  // storeToolOutput
  // ---------------------------------------------------------------------------
  // Best-effort: NEVER throws. Returns { id, key } on success, null on failure.
  //
  // params:
  //   sessionID       - current session ID (used as scopeID)
  //   interactionID   - current interaction ID (informational; not stored yet)
  //   agentID         - agent that called the tool (ownerID)
  //   organizationID  - required for ValueStore foreign key
  //   toolName        - name portion of the tool (e.g. "execute")
  //   pluginID        - plugin that owns the tool (e.g. "shell")
  //   toolCallArgs    - arguments the agent passed to the tool (object or null)
  //   output          - raw tool output (any type)
  //   models          - { ValueStore } from core.getModels()
  //   keystore        - keystore instance (for signing; optional)
  //   privateKeyPEM   - agent private key PEM (for signing; optional)
  //   publicKeyPEM    - agent public key PEM (for signing; optional)
  // ---------------------------------------------------------------------------

  async storeToolOutput({
    sessionID,
    interactionID,    // eslint-disable-line no-unused-vars
    agentID,
    organizationID,
    toolName,
    pluginID,
    toolCallArgs,
    output,
    models,
    keystore,
    privateKeyPEM,
    publicKeyPEM,
  }) {
    try {
      let { ValueStore } = models;

      let generatedKey = generateKey();
      let jsonValue    = JSON.stringify({ args: toolCallArgs ?? null, output: output ?? null });
      let note         = deriveNote(toolName, pluginID, toolCallArgs);
      let type         = `tool_log:${pluginID}:${toolName}`;
      let scopeID      = sessionID || '';

      // Best-effort signing — null if keys are unavailable
      let signature             = null;
      let signingKeyFingerprint = null;

      if (keystore && privateKeyPEM && publicKeyPEM) {
        let signed = signValue(
          keystore, privateKeyPEM, publicKeyPEM,
          'agent', agentID, 'tool_log', scopeID, generatedKey, jsonValue,
        );
        if (signed) {
          signature             = signed.signature;
          signingKeyFingerprint = signed.fingerprint;
        }
      }

      let entry = await ValueStore.create({
        organizationID,
        ownerType:            'agent',
        ownerID:              agentID,
        namespace:            'tool_log',
        scopeID,
        key:                  generatedKey,
        value:                jsonValue,
        note,
        type,
        signature,
        signingKeyFingerprint,
      });

      return { id: entry.id, key: generatedKey };
    } catch (error) {
      console.error('[ToolLogService] Failed to store tool output:', error.message || error);
      return null;
    }
  }
}
