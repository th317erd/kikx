'use strict';

// =============================================================================
// DmSummarizer
// =============================================================================

export class DmSummarizer {
  /**
   * @param {import('../types').CascadingContext} context
   */
  constructor(context) {
    if (!context)
      throw new Error('DmSummarizer requires a CascadingContext');

    /** @type {import('../types').CascadingContext} */
    this._context = context;
  }

  /**
   * Convert frames to readable conversation text.
   * @param {import('../types').FrameData[]} frames
   * @returns {string}
   */
  framesToConversation(frames) {
    let lines = [];

    for (let frame of frames) {
      if (!frame || !frame.type)
        continue;

      if (frame.type === 'UserMessage') {
        let text = (frame.content && frame.content.text) || '';
        lines.push(`User: ${text}`);
      } else if (frame.type === 'Message') {
        let html = (frame.content && frame.content.html) || '';
        lines.push(`Agent: ${html}`);
      }
    }

    return lines.join('\n\n');
  }

  /**
   * Construct the summarization instruction.
   * @param {string} conversationText
   * @returns {string}
   */
  buildSummaryPrompt(conversationText) {
    return [
      'The following is a DM conversation where a user configured an agent\'s behavior.',
      'Extract the key instructions, preferences, and behavioral rules from this conversation.',
      'Output ONLY the extracted instructions as a concise, actionable list.',
      'Do not include greetings, small talk, or meta-discussion.',
      '',
      '--- Conversation ---',
      conversationText,
      '--- End Conversation ---',
      '',
      'Extract the instructions:',
    ].join('\n');
  }

  /**
   * Run full summarization pipeline.
   * @param {import('../types').BasePluginClass} agentPlugin
   * @param {import('../types').Agent} agent
   * @param {string} sessionID
   * @returns {Promise<string|null>}
   */
  async summarize(agentPlugin, agent, sessionID) {
    let framePersistence = this._context.getProperty('framePersistence');
    if (!framePersistence)
      throw new Error('framePersistence not available on context');

    let frames = await framePersistence.loadFrames(sessionID);

    if (!frames || frames.length === 0)
      return null;

    let conversationText = this.framesToConversation(frames);

    if (!conversationText.trim())
      return null;

    let summaryPrompt = this.buildSummaryPrompt(conversationText);

    let generator = await agentPlugin.execute({
      messages: [{ role: 'user', content: summaryPrompt }],
      agent,
      context: this._context,
    });

    let summaryParts = [];

    for await (let block of generator) {
      if (!block || block.type === 'Done')
        break;

      if (block.type === 'Message' && block.content && block.content.html)
        summaryParts.push(block.content.html);
    }

    let summary = summaryParts.join('\n').trim();

    if (!summary)
      return null;

    let models = this._context.getProperty('models');
    if (models && models.Agent) {
      let agentRecord = await models.Agent.where.id.EQ(agent.id).first();
      if (agentRecord) {
        agentRecord.dmSummary = summary;
        await agentRecord.save();
      }
    }

    return summary;
  }
}
