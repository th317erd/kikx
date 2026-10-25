'use strict';

import { randomUUID } from 'node:crypto';

import { normalizeOcrImages } from './ocr-request.mjs';
import { OCR_PRIORITY_TAG } from '../tags/tag-definitions.mjs';
import {
  createRegisteredToolDefinitions,
  createRegisteredToolHandlers,
} from '../plugins/agent-loop-tools.mjs';

export class OcrService {
  constructor(options = {}) {
    this.agentManager = options.agentManager || null;
    this.tagsStore = options.tagsStore || null;
    this.pluginRegistry = options.pluginRegistry || null;
    this.toolExecutor = options.toolExecutor || null;
    this.context = options.context || null;
    this.logger = options.logger || console;
  }

  async listOcrAgents(options = {}) {
    if (!this.agentManager?.listAgents)
      return [];

    let excluded = new Set(Array.isArray(options.excludeAgentIDs) ? options.excludeAgentIDs : []);
    let agents = await this.agentManager.listAgents({ limit: options.limit || 500 });
    return agents
      .filter((agent) => (
        agent?.enabled !== false
        && !excluded.has(agent.id)
        && agentTagValue(agent, 'ocr_score') > 0
        && providerSupportsOcr(this.pluginRegistry?.getAgentProvider?.(agent.pluginID))
      ))
      .sort((a, b) => (
        agentTagValue(b, OCR_PRIORITY_TAG) - agentTagValue(a, OCR_PRIORITY_TAG)
        || agentTagValue(b, 'ocr_score') - agentTagValue(a, 'ocr_score')
        || String(a.name || a.id).localeCompare(String(b.name || b.id))
      ));
  }

  builtinOcrAgent() {
    let ProviderClass = this.pluginRegistry?.getAgentProvider?.('host-ocr-command');
    if (!ProviderClass || ProviderClass.supportsOcr !== true)
      return null;

    return {
      id: 'builtin-host-ocr',
      name: 'Built-in Host OCR',
      pluginID: 'host-ocr-command',
      enabled: true,
      config: {},
      tags: [],
    };
  }

  buildOcrTools(request = {}, agent = {}) {
    let allowed = new Set([
      'exec',
      'exec-script',
      'exec-status',
      'exec-read',
      'exec-grep',
      'exec-kill',
      'read-file',
      'output-read',
      'output-grep',
      'web-fetch',
    ]);
    let frame = {
      id: `ocr-tool-${randomUUID()}`,
      type: 'OcrToolFrame',
      sessionID: request.session?.id || null,
      authorType: 'agent',
      authorID: agent.id || null,
      content: { text: request.prompt || 'OCR request' },
    };
    let baseProcessManager = request.services?.processManager
      || this.context?.require?.('processManager')
      || null;
    let nestedProcessManager = createNestedProcessManager(baseProcessManager);
    let services = {
      ...(request.services || {}),
      ...(nestedProcessManager ? { processManager: nestedProcessManager } : {}),
    };
    let toolContext = {
      frame,
      session: request.session || null,
      agent,
      pluginRegistry: this.pluginRegistry,
      toolExecutor: this.toolExecutor
        || request.services?.toolExecutor
        || this.context?.require?.('toolExecutor'),
      processManager: nestedProcessManager,
      services,
      allowWriteFile: false,
      isCoordinator: false,
      // Nested OCR tool calls are implementation detail; suppress recording as
      // visible session tool frames and run commands to completion without a
      // separate wake frame.
      frameEngine: {
        idGenerator: () => randomUUID(),
        merge: (frames) => frames,
        get: () => null,
      },
    };
    let toolDefinitions = createRegisteredToolDefinitions(toolContext)
      .filter((definition) => allowed.has(definition.name));
    let allHandlers = createRegisteredToolHandlers(toolContext);
    let tools = Object.fromEntries(Object.entries(allHandlers)
      .filter(([ name ]) => allowed.has(name)));
    return { tools, toolDefinitions, context: toolContext };
  }

  async run(request = {}) {
    let images = normalizeOcrImages(request.images);
    if (images.length === 0)
      throw new Error('ocr requires at least one image path');

    let candidates = await this.listOcrAgents();
    if (candidates.length === 0) {
      let fallback = this.builtinOcrAgent();
      if (fallback)
        candidates = [ fallback ];
    }
    if (candidates.length === 0)
      throw new Error('No OCR-capable enabled agents have a positive ocr_score tag');

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

        let ocrTools = this.buildOcrTools(request, agent);
        let result = await provider.runOcr({
          ...request,
          images,
          prompt: request.prompt || '',
          agent,
          session: request.session || null,
          services: request.services || {},
          tools: ocrTools.tools,
          toolDefinitions: ocrTools.toolDefinitions,
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



function createNestedProcessManager(base) {
  if (!base?.start)
    return base;

  let wrapper = Object.create(base);
  wrapper.start = (params = {}, context = {}, options = {}) => base.start(params, context, {
    ...options,
    autoWake: false,
    returnCompletionIfReady: true,
    graceMs: Math.max(Number(options.graceMs) || 0, 120000),
  });
  return wrapper;
}

function providerSupportsOcr(ProviderClass) {
  return Boolean(ProviderClass && ProviderClass.supportsOcr === true);
}

function agentTagValue(agent, name) {
  let tag = (Array.isArray(agent?.tags) ? agent.tags : [])
    .find((item) => item?.name === name && (!item.target_type || item.target_type === 'agent'));
  let value = Number(tag?.value);
  return Number.isFinite(value) ? value : 0;
}
