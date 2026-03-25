'use strict';

// =============================================================================
// DmSummarizer
// =============================================================================
// Service that summarizes DM session conversation history into concise
// instructions. The summary is stored on the Agent record and injected
// into the system prompt for non-DM sessions.
//
// Flow:
//   1. Load all frames from the DM session
//   2. Convert to conversation text (user/agent turns)
//   3. Build a summarization prompt
//   4. Call the agent plugin's execute() with the summary prompt
//   5. Collect yielded message blocks into summary text
//   6. Save to Agent.dmSummary
// =============================================================================

export class DmSummarizer {
  constructor(context) {
    if (!context)
      throw new Error('DmSummarizer requires a CascadingContext');

    this._context = context;
  }

  // ---------------------------------------------------------------------------
  // framesToConversation — convert frames to readable conversation text
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // buildSummaryPrompt — construct the summarization instruction
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // summarize — run full summarization pipeline
  // ---------------------------------------------------------------------------

  async summarize(agentPlugin, agent, sessionID) {
    let framePersistence = this._context.getProperty('framePersistence');
    if (!framePersistence)
      throw new Error('framePersistence not available on context');

    // 1. Load frames from DM session
    let frames = await framePersistence.loadFrames(sessionID);

    if (!frames || frames.length === 0)
      return null;

    // 2. Convert to conversation text
    let conversationText = this.framesToConversation(frames);

    if (!conversationText.trim())
      return null;

    // 3. Build summarization prompt
    let summaryPrompt = this.buildSummaryPrompt(conversationText);

    // 4. Call agent plugin to generate summary
    let generator = await agentPlugin.execute({
      messages: [{ role: 'user', content: summaryPrompt }],
      agent,
      context: this._context,
    });

    // 5. Collect yielded message blocks
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

    // 6. Save to Agent.dmSummary
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
