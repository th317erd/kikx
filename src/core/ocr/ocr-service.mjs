'use strict';

import { normalizeOcrImages } from './ocr-request.mjs';

export class OcrService {
  constructor(options = {}) {
    this.agentManager = options.agentManager || null;
    this.tagsStore = options.tagsStore || null;
    this.pluginRegistry = options.pluginRegistry || null;
    this.logger = options.logger || console;
  }

  async listOcrAgents(options = {}) {
    if (!this.agentManager?.listTaggedAgents)
      return [];

    return await this.agentManager.listTaggedAgents('ocr_score', {
      limit: options.limit || 500,
      minValue: options.minValue ?? 1,
      excludeAgentIDs: options.excludeAgentIDs,
    });
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

