'use strict';

import { BaseFramePlugin } from '../routing/index.mjs';
import {
  mentionsEqual,
  mergeMentionMaps,
  parseMentionReferences,
  resolveMentionActors,
} from './mention-resolver.mjs';

export class MentionFramePlugin extends BaseFramePlugin {
  static pluginID = 'internal:mention-router';

  async process(next) {
    let frame = this.context.newFrame;
    if (!shouldInspectFrame(frame)) {
      await next(this.context);
      return;
    }

    let references = parseMentionReferences(frame.content.text);
    if (references.length === 0) {
      await next(this.context);
      return;
    }

    let resolvedMentions = await resolveMentionActors(references, this.context.services || {});
    let mentions = mergeMentionMaps(frame.mentions, resolvedMentions);
    if (Object.keys(mentions).length === 0 || mentionsEqual(frame.mentions, mentions)) {
      await next(this.context);
      return;
    }

    let updatedFrame = this.persistMentions(frame, mentions);
    await this.context.services?.frameRuntime?.frameStore?.flush?.();
    await next({
      ...this.context,
      newFrame: updatedFrame,
      changes: [
        ...(this.context.changes || []),
        {
          propName: 'mentions',
          previousValue: frame.mentions,
          newValue: updatedFrame.mentions,
        },
      ],
    });
  }

  persistMentions(frame, mentions) {
    let merged = this.context.engine.merge([{
      ...frame,
      mentions,
    }], {
      authorType: 'system',
      authorID: MentionFramePlugin.pluginID,
      silent: true,
    });

    return merged[0] || this.context.engine.get(frame.id) || {
      ...frame,
      mentions,
    };
  }
}

export function registerMentionRouting(registry) {
  if (!registry?.registerSelector)
    throw new TypeError('registerMentionRouting() requires a registry or FrameRouter');

  registry.registerSelector('Type:UserMessage', MentionFramePlugin, MentionFramePlugin.pluginID);
}

function shouldInspectFrame(frame) {
  return frame?.type === 'UserMessage'
    && frame.hidden !== true
    && typeof frame.content?.text === 'string'
    && frame.content.text.includes('@');
}
