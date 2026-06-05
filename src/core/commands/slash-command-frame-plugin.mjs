'use strict';

import { BaseFramePlugin } from '../routing/index.mjs';

export class SlashCommandFramePlugin extends BaseFramePlugin {
  static pluginID = 'internal:slash-command-router';

  async process(next, done) {
    let parsed = parseSlashCommand(this.context.newFrame?.content?.text);
    if (!parsed) {
      await next(this.context);
      return;
    }

    let commandRegistry = this.context.services?.commandRegistry
      || this.context.services?.context?.require?.('commandRegistry');
    let descriptor = commandRegistry?.getCommand?.(parsed.name);

    if (!descriptor) {
      this.appendCommandResult({
        command: parsed.name,
        status: 'error',
        text: `Unknown command: /${parsed.name}`,
      });
      done();
      return;
    }

    try {
      let command = new descriptor.CommandClass(this.context);
      let result = await command.execute({
        command: descriptor.name,
        args: parsed.args,
        raw: parsed.raw,
        frame: this.context.newFrame,
        session: this.context.session,
        services: this.context.services,
      });

      this.appendCommandResult({
        command: descriptor.name,
        status: result?.status || 'ok',
        text: result?.message || `/${descriptor.name} handled`,
        data: result?.data || null,
      });
    } catch (error) {
      this.appendCommandResult({
        command: descriptor.name,
        status: 'error',
        text: error.message || `/${descriptor.name} failed`,
      });
    }

    done();
  }

  appendCommandResult({ command, status, text, data = null }) {
    let frame = this.context.newFrame;
    let now = this.context.services?.clock?.() || Date.now();

    this.context.engine.merge([{
      id: this.context.engine.idGenerator(),
      type: 'CommandResult',
      sessionID: frame.sessionID,
      interactionID: frame.interactionID,
      parentID: frame.id,
      authorType: 'system',
      authorID: 'internal:slash-command-router',
      timestamp: now,
      createdAt: now,
      updatedAt: now,
      hidden: false,
      deleted: false,
      content: {
        command,
        status,
        text,
        data,
      },
    }], {
      authorType: 'system',
      authorID: 'internal:slash-command-router',
    });
  }
}

export function parseSlashCommand(text) {
  if (typeof text !== 'string')
    return null;

  let trimmed = text.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//'))
    return null;

  let match = trimmed.match(/^\/([A-Za-z][A-Za-z0-9:_-]*)(?:\s+([\s\S]*))?$/);
  if (!match)
    return null;

  return {
    name: match[1].toLowerCase(),
    args: (match[2] || '').trim(),
    raw: trimmed,
  };
}
