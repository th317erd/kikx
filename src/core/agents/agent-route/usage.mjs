'use strict';

import {
  normalizeNonNegativeInteger,
  normalizeOptionalString,
} from './normalize.mjs';

export function resolveTokenServiceKey({ usage, ProviderClass, agent }) {
  if (usage.serviceKey)
    return usage.serviceKey;

  let explicit = normalizeOptionalString(ProviderClass?.tokenServiceKey || ProviderClass?.serviceKey);
  if (explicit)
    return explicit;

  let serviceType = normalizeOptionalString(ProviderClass?.serviceType);
  let agentType = normalizeOptionalString(ProviderClass?.agentType);
  let pluginID = normalizeOptionalString(agent?.pluginID || ProviderClass?.pluginID || agent?.id);
  let parts = [];
  for (let part of [ serviceType, agentType, pluginID ]) {
    if (part)
      parts.push(part);
  }

  return parts.length > 0 ? parts.join('/') : 'unknown/agent';
}

export function mergeFrameUsage(existingUsage, serviceKey, delta, timestamp) {
  let existing = (existingUsage && typeof existingUsage === 'object' && !Array.isArray(existingUsage))
    ? existingUsage
    : {};
  let existingEntry = (existing[serviceKey] && typeof existing[serviceKey] === 'object' && !Array.isArray(existing[serviceKey]))
    ? existing[serviceKey]
    : {};
  let nextEntry = {
    ...existingEntry,
    createdAt: existingEntry.createdAt || timestamp,
    updatedAt: timestamp,
  };

  for (let [key, value] of Object.entries(delta || {})) {
    let amount = normalizeNonNegativeInteger(value);
    if (amount <= 0)
      continue;

    nextEntry[key] = normalizeNonNegativeInteger(existingEntry[key]) + amount;
  }

  return {
    ...existing,
    [serviceKey]: nextEntry,
  };
}

export function totalTokensUsed(snapshot) {
  let total = 0;
  for (let entry of Object.values(snapshot || {}))
    total += normalizeNonNegativeInteger(entry?.tokensUsed);

  return total;
}
