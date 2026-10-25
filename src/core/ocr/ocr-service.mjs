'use strict';

import { normalizeOcrImages } from './ocr-request.mjs';
import { OCR_PRIORITY_TAG } from '../tags/tag-definitions.mjs';

export class OcrService {
  constructor(options = {}) {
    this.agentManager = options.agentManager || null;
    this.tagsStore = options.tagsStore || null;
    this.pluginRegistry = options.pluginRegistry || null;
    this.logger = options.logger || console;
  }

  async listOcrAgents(options = {}) {
    if (!this.agentManager?.listAgents)
      return [];

    let excluded = new Set(Array.isArray(options.excludeAgentIDs) ? options.excludeAgentIDs : []);
    let agents = await this.agentManager.listAgents({ limit: options.limit || 500 });
    return agents
      .filter((agent) => agent?.enabled !== false && !excluded.has(agent.id) && agentTagValue(agent, 'ocr_score') > 0)
      .sort((a, b) => (
        agentTagValue(b, OCR_PRIORITY_TAG) - agentTagValue(a, OCR_PRIORITY_TAG)
        || agentTagValue(b, 'ocr_score') - agentTagValue(a, 'ocr_score')
        || String(a.name || a.id).localeCompare(String(b.name || b.id))
      ));
  }

  async run(request = {}) {
    let images = normalizeOcrImages(request.images);
    if (images.length === 0)
      throw new Error('ocr requires at least one image path');

    let candidates = await this.listOcrAgents();
    if (candidates.length === 0)
      throw new Error('No enabled OCR agents have a positive ocr_score tag');

    let attempts = [];
    for (let agent of candidates) {
      let ProviderClass = this.pluginRegistry?.getAgentProvider?.(agent.pluginID);
      if (!ProviderClass) {
        attempts.push({ agentID: agent.id, agentName: agent.name, error: `Unknown provider: ${agent.pluginID}` });
        continue;
      }

      try {
        let provider = new ProviderClass({
          agent,
          services: request.services || {},
        });
        if (typeof provider.runOcr !== 'function')
          throw new Error(`Provider ${agent.pluginID} does not implement runOcr`);

        let result = await provider.runOcr({
          ...request,
          images,
          prompt: request.prompt || '',
          agent,
          session: request.session || null,
          services: request.services || {},
        });
        let text = typeof result?.text === 'string' ? result.text.trim() : '';
        if (text === '')
          throw new Error('OCR agent returned no text');

        return {
          ...result,
          text,
          agentID: agent.id,
          agentName: agent.name,
          providerID: agent.pluginID,
          images,
          attempts,
        };
      } catch (error) {
        attempts.push({
          agentID: agent.id,
          agentName: agent.name,
          providerID: agent.pluginID,
          error: error?.message || String(error),
        });
      }
    }

    let error = new Error(`All OCR agents failed: ${attempts.map((attempt) => `${attempt.agentName || attempt.agentID}: ${attempt.error}`).join('; ')}`);
    error.attempts = attempts;
    throw error;
  }
}



function agentTagValue(agent, name) {
  let tag = (Array.isArray(agent?.tags) ? agent.tags : [])
    .find((item) => item?.name === name && (!item.target_type || item.target_type === 'agent'));
  let value = Number(tag?.value);
  return Number.isFinite(value) ? value : 0;
}
