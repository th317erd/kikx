'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';

export class FeedbackReportTool extends PluginInterface {
  static pluginID = 'internal:feedback';
  static featureName = 'feedback-report';
  static displayName = 'Report Kikx feedback';
  static description = 'Write a Kikx bug, regression, limitation, or product feedback report into the global AeorDB feedback folder.';
  static frameType = 'FeedbackReportToolFrame';
  static clientComponent = builtInToolComponent('kikx-feedback-tool-use');
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short, searchable title for the feedback report.',
      },
      severity: {
        type: 'string',
        enum: [ 'low', 'medium', 'high', 'critical' ],
        description: 'Severity of the bug or feedback. Defaults to medium.',
      },
      category: {
        type: 'string',
        description: 'Feedback area, such as bug, UX, agent-runtime, tools, routing, or docs.',
      },
      report: {
        type: 'string',
        description: 'Markdown report body. Include what happened, why it matters, and any useful diagnostic details.',
      },
      steps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional reproduction steps.',
      },
      expected: {
        type: 'string',
        description: 'Optional expected behavior.',
      },
      actual: {
        type: 'string',
        description: 'Optional actual behavior.',
      },
      impact: {
        type: 'string',
        description: 'Optional user or engineering impact.',
      },
      recommendation: {
        type: 'string',
        description: 'Optional suggested fix or next investigation step.',
      },
    },
    required: [ 'title', 'report' ],
    additionalProperties: false,
  };
  static help = [
    'Use feedback-report when you discover a Kikx bug, confusing behavior, missing capability, regression, or important product feedback.',
    'Write a concise but complete Markdown report. Include reproduction steps, expected behavior, actual behavior, and impact when known.',
    'This stores a global Markdown report in AeorDB under /feedback/ for AEOR Development to search later.',
  ].join(' ');

  async _execute(params = {}) {
    return await resolveFeedbackStore(this.context).createFeedback(params, this.context);
  }
}

function resolveFeedbackStore(context = {}) {
  let store = context.feedbackStore || context.services?.feedbackStore || resolveContextService(context, 'feedbackStore');
  if (!store?.createFeedback)
    throw new Error('feedback-report requires feedbackStore');

  return store;
}

function resolveContextService(context, name) {
  let appContext = context.services?.context || context.context;
  if (appContext?.has?.(name) && typeof appContext.require === 'function')
    return appContext.require(name);

  if (typeof appContext?.require === 'function') {
    try {
      return appContext.require(name);
    } catch (_error) {
      return null;
    }
  }

  return null;
}
