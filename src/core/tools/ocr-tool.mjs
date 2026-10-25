'use strict';

import { PluginInterface } from '../plugins/index.mjs';

export class OcrTool extends PluginInterface {
  static pluginID = 'internal:ocr';
  static featureName = 'ocr';
  static displayName = 'OCR';
  static description = 'Run OCR through the highest-priority OCR agents, falling back on failure.';
  static frameType = 'OcrFrame';
  static clientComponent = {
    tagName: 'kikx-ocr-frame',
    moduleURL: '/client/components/kikx-ocr-frame.mjs',
  };
  static riskLevel = 'none';
  static inputSchema = {
    type: 'object',
    properties: {
      images: {
        type: 'array',
        items: { type: 'string' },
        description: 'Image or PDF paths to OCR. The same text paths are also passed to the selected OCR agent.',
      },
      prompt: {
        type: 'string',
        description: 'Optional OCR instruction, for example a description style or extraction question.',
      },
    },
    required: [ 'images' ],
    additionalProperties: false,
  };
  static help = [
    'Use ocr to send one or more local image/PDF paths to the configured OCR agents.',
    'Agents are selected by the ocr_score tag, highest first; a failed agent falls through to the next one.',
    'OCR agents may be regular agents or plugin-driven host commands. The result includes the text and which agent handled it.',
    'The expanded OcrFrame shows the question, image(s), and OCR response. Images load through the authenticated image proxy; sessions can disable that proxy with the ocr.image_proxy preference.',
  ].join(' ');

  async _execute(params = {}) {
    return await resolveOcrService(this.context).run(params);
  }
}

function resolveOcrService(context = {}) {
  let service = context.ocrService || context.services?.ocrService || resolveContextService(context, 'ocrService');
  if (!service?.run)
    throw new Error('ocr requires an ocrService');
  return service;
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
