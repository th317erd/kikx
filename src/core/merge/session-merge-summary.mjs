'use strict';

import { AgentInterface } from '../plugins/index.mjs';
import {
  buildAgentCompactionPrompt,
  collectCompactionText,
  runChunkedCompaction,
  serializeFramesForCompaction,
} from '../compaction/index.mjs';

// Resolve the compactor, its provider, and the input budget once. The provider
// is re-created per summary call so parallel session summaries cannot share
// mutable request state.
export async function createMergeSummaryRunner({ compactionService, input = {}, compactionWindow = null } = {}) {
  if (!compactionService)
    throw new TypeError('createMergeSummaryRunner requires compactionService');

  let compactorAgent = await compactionService.resolveCompactionAgent(input);
  if (!compactorAgent?.id)
    throw new Error('No agent available for session merge compaction');

  let ProviderClass = compactionService.resolveProviderClass(compactorAgent);
  if (!ProviderClass)
    throw new Error(`No compaction provider found for agent plugin: ${compactorAgent.pluginID}`);

  let probe = new ProviderClass({
    ...(input.routerContext || {}),
    agent: compactorAgent,
    services: input.services || {},
  });
  if (probe.ask === AgentInterface.prototype.ask)
    throw new Error(`Agent provider ${ProviderClass.name} does not expose a one-shot ask() method for session merge`);

  let contextBudget = compactionService.resolveCompactionBudget({
    input,
    compactorAgent,
    provider: probe,
    ProviderClass,
    compactionWindow: compactionWindow || { frames: [], startFrameID: '', boundaryFrameID: '', tokens: 0 },
  });

  return {
    compactorAgent,
    ProviderClass,
    contextBudget,
    createProvider: () => new ProviderClass({
      ...(input.routerContext || {}),
      agent: compactorAgent,
      services: input.services || {},
    }),
  };
}

// Summarize one or more labeled context sections into a single summary. Each
// section is a synthetic frame so runChunkedCompaction can chunk/reduce a merge
// whose combined input is still too large after the planned per-session passes.
export async function summarizeMergeSections({
  runner,
  compactionService,
  session = null,
  sections = [],
  window = {},
  input = {},
  instructionMode = 'merge',
} = {}) {
  if (!runner || !compactionService)
    throw new TypeError('summarizeMergeSections requires a runner and compactionService');
  let list = (Array.isArray(sections) ? sections : [])
    .filter((section) => section && typeof section.text === 'string' && section.text.trim() !== '')
    .map((section, index) => ({
      id: section.id || `merge-section-${index + 1}`,
      type: 'MergeContextSection',
      content: { text: section.text },
    }));
  if (list.length === 0)
    return '';

  let estimate = (text) => compactionService.contextBuilder.estimateTokens(text);
  return await runChunkedCompaction({
    frames: list,
    budgetTokens: runner.contextBudget,
    estimateTokens: estimate,
    compactOnce: async (group) => {
      let contextText = group.map((frame) => frame.content?.text || '').filter(Boolean).join('\n\n---\n\n');
      let prompt = buildAgentCompactionPrompt({
        instructions: instructionMode === 'session'
          ? (compactionService.instructions || '')
          : mergeInstructions(compactionService, sections),
        contextText,
        sessionID: session?.id || window.sessionID || '',
        frameCount: group.length,
        startFrameID: window.startFrameID || '',
        boundaryFrameID: window.boundaryFrameID || '',
        contextTokenBudget: runner.contextBudget,
      });
      let provider = runner.createProvider();
      return await collectCompactionText(provider.ask(prompt, {
        compaction: true,
        oneShot: true,
        agent: runner.compactorAgent,
        session,
        frames: group,
        sessionFrames: group,
        config: runner.compactorAgent.config || {},
        secrets: runner.compactorAgent.secrets || {},
        tools: {},
        toolDefinitions: [],
        services: input.services || {},
        maxInputTokens: runner.contextBudget,
      }));
    },
  });
}

export function buildMergeSection({ session, frames = [], summary = null } = {}) {
  let id = session?.id || 'unknown';
  let title = session?.title || id;
  let body = summary != null
    ? `Compacted session memory:\n${summary}`
    : serializeFramesForCompaction(frames);
  return {
    id: `merge-session-${id}`,
    sessionID: id,
    text: `### Session ${title} (${id})${summary != null ? ' [compacted]' : ''}\n${body}`,
  };
}

function mergeInstructions(compactionService, sections = []) {
  let base = compactionService?.instructions || '';
  let sessionCount = new Set((sections || []).map((section) => section.sessionID).filter(Boolean)).size || sections.length;
  return [
    base,
    '',
    'This is a MERGE of multiple Kikx sessions into one context memory. Preserve the separate workstreams and their ownership, but produce ONE consolidated handoff. The target session is the destination; the other sessions are incoming workstreams. Newer material wins conflicts. Do not discard a source session merely because it is smaller.',
    `Merged session count: ${sessionCount}.`,
  ].join('\n');
}
