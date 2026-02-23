'use strict';

// ============================================================================
// Command Handlers
// ============================================================================
// Handles slash commands entered by the user, including:
// - /clear, /help, /session, /archive, /start, /compact
// - /stream, /update_usage, /ability
//
// Dependencies: state, showSystemMessage, fetchHelpTopics, clearMessages,
//               archiveSession, startAgentLoop, triggerCompaction, createUsageCorrection,
//               fetchAbilities, loadSessionUsage, showView, BASE_PATH

async function handleCommand(content) {
  console.log('[Commands] Handling command:', content);

  let parts   = content.slice(1).split(/\s+/);
  let command = parts[0].toLowerCase();
  let args    = parts.slice(1).join(' ');

  switch (command) {
    case 'clear':
      await handleClearMessages();
      break;

    case 'help':
      await handleHelpCommand(args);
      break;

    case 'session':
      showSystemMessage(`Current session: ${state.currentSession?.name || 'None'}\nSession ID: ${state.currentSession?.id || 'N/A'}`);
      break;

    case 'archive':
      await handleArchiveCommand();
      break;

    case 'ability':
      await handleAbilityCommand(args);
      break;

    case 'stream':
      handleStreamCommand(args);
      break;

    case 'update_usage':
    case 'update-usage':
      await handleUpdateUsageCommand(args);
      break;

    case 'start':
      await handleStartCommand();
      break;

    case 'compact':
      await handleCompactCommand();
      break;

    case 'reload':
      await handleReloadCommand();
      break;

    default:
      console.log('[Commands] Unknown command:', command);
      showSystemMessage(`Unknown command: /${command}\nType /help for available commands.`);
  }
}

async function handleClearMessages() {
  if (!state.currentSession)
    return;

  try {
    await clearMessages(state.currentSession.id);
    const session = getCurrentSessionMessages();
    if (session) {
      session.clear();
    }
    renderMessages();
  } catch (error) {
    console.error('Failed to clear messages:', error);
  }
}

async function handleHelpCommand(filterArg = '') {
  try {
    // Build URL with filter if provided
    let url = `${BASE_PATH}/api/help`;
    if (filterArg.trim()) {
      url += `?filter=${encodeURIComponent(filterArg.trim())}`;
    }

    let response = await fetch(url);
    let help     = await response.json();

    // Check for error response (e.g., invalid regex)
    if (help.error) {
      const session = getCurrentSessionMessages();
      if (session) {
        session.add({
          role:    'assistant',
          content: [{ type: 'text', text: `Error: ${help.error}` }],
        });
      }
      renderMessages();
      scrollToBottom();
      return;
    }

    let text = '# Hero Help\n\n';

    // Show filter if applied
    if (filterArg.trim()) {
      text += `*Filtering by: \`${filterArg.trim()}\`*\n\n`;
    }

    let hasResults = false;

    // Built-in commands
    if (help.commands && (help.commands.builtin.length > 0 || help.commands.user.length > 0)) {
      hasResults = true;
      text += '## Commands\n';
      for (let cmd of help.commands.builtin) {
        text += `  /${cmd.name} - ${cmd.description}\n`;
      }

      if (help.commands.user.length > 0) {
        text += '\n### User Commands\n';
        for (let cmd of help.commands.user) {
          text += `  /${cmd.name} - ${cmd.description || 'No description'}\n`;
        }
      }
    }

    // System functions
    if (help.systemMethods && help.systemMethods.length > 0) {
      hasResults = true;
      text += '\n## System Functions\n';
      for (let fn of help.systemMethods) {
        text += `  ${fn.name} - ${fn.description || 'No description'}\n`;
      }
    }

    // Assertion types
    if (help.assertions && help.assertions.length > 0) {
      hasResults = true;
      text += '\n## Assertion Types\n';
      for (let assertion of help.assertions) {
        text += `  ${assertion.type} - ${assertion.description}\n`;
      }
    }

    // Abilities
    if (help.processes) {
      let hasSystemAbilities = help.processes.system && help.processes.system.length > 0;
      let hasUserAbilities   = help.processes.user && help.processes.user.length > 0;

      if (hasSystemAbilities || hasUserAbilities) {
        hasResults = true;
        text += '\n## Abilities\n';

        if (hasSystemAbilities) {
          text += '### System\n';
          for (let ability of help.processes.system) {
            text += `  ${ability.name} - ${ability.description || 'No description'}\n`;
          }
        }

        if (hasUserAbilities) {
          text += '\n### User Abilities\n';
          for (let ability of help.processes.user) {
            text += `  ${ability.name} - ${ability.description || 'No description'}\n`;
          }
        }
      }
    }

    // Show message if no results found with filter
    if (!hasResults && filterArg.trim()) {
      text += `No results found matching \`${filterArg.trim()}\`.\n`;
      text += '\nTry a different filter pattern or run `/help` without arguments to see all available help.';
    }

    showSystemMessage(text);
  } catch (error) {
    console.error('Failed to fetch help:', error);
    showSystemMessage('Failed to load help information.');
  }
}

function handleStreamCommand(args) {
  args = args.toLowerCase().trim();

  const session = getCurrentSessionMessages();
  let message;

  if (args === 'on' || args === 'enable') {
    state.streamingMode = true;
    message = {
      role:    'assistant',
      content: [{ type: 'text', text: 'Streaming mode enabled. Responses will appear progressively.' }],
    };
  } else if (args === 'off' || args === 'disable') {
    state.streamingMode = false;
    message = {
      role:    'assistant',
      content: [{ type: 'text', text: 'Streaming mode disabled. Responses will appear after completion.' }],
    };
  } else {
    let modeText = (state.streamingMode) ? 'enabled' : 'disabled';
    message = {
      role:    'assistant',
      content: [{ type: 'text', text: `Streaming mode is currently ${modeText}.\n\nUsage:\n/stream on  - Enable streaming\n/stream off - Disable streaming` }],
    };
  }

  if (session && message) {
    session.add(message);
  }

  renderMessages();
  forceScrollToBottom();
}

async function handleArchiveCommand() {
  if (!state.currentSession) {
    showSystemMessage('No active session to archive.');
    return;
  }

  try {
    await fetch(`${BASE_PATH}/api/sessions/${state.currentSession.id}/archive`, {
      method: 'POST',
    });

    showSystemMessage(`Session "${state.currentSession.name}" has been archived.`);

    // Reload sessions
    state.sessions = await fetchSessions();
    renderSessionsList();
  } catch (error) {
    console.error('Failed to archive session:', error);
    showSystemMessage('Failed to archive session.');
  }
}

/**
 * Handle /start command.
 * Re-sends startup instructions to the AI agent.
 */
async function handleStartCommand() {
  if (!state.currentSession) {
    showSystemMessage('No active session. Please select or create a session first.');
    return;
  }

  try {
    // Fetch startup content from API
    let response = await fetch(`${BASE_PATH}/api/commands/start`);
    let result   = await response.json();

    if (!result.success) {
      showSystemMessage(`Failed to load startup instructions: ${result.error}`);
      return;
    }

    // Send the startup content to the AI as a system refresh message
    let systemContent = `[System Initialization - Refresh]\n\n${result.content}`;
    await processMessageStream(systemContent);
  } catch (error) {
    console.error('Failed to execute start command:', error);
    showSystemMessage(`Error: ${error.message}`);
  }
}

/**
 * Handle /compact command.
 * Forces conversation compaction into a summary snapshot.
 */
async function handleCompactCommand() {
  if (!state.currentSession) {
    showSystemMessage('No active session to compact.');
    return;
  }

  showSystemMessage('Compacting conversation history...');

  try {
    let response = await fetch(`${BASE_PATH}/api/commands/compact`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sessionId: state.currentSession.id }),
    });

    let result = await response.json();

    if (result.success) {
      showSystemMessage(`**Compaction complete**\n\n${result.message}\n\n- Snapshot ID: ${result.details?.snapshotId || 'N/A'}\n- Messages compacted: ${result.details?.messagesCount || 0}\n- Summary length: ${result.details?.summaryLength || 0} chars`);
    } else {
      showSystemMessage(`Compaction failed: ${result.error}`);
    }
  } catch (error) {
    console.error('Failed to compact conversation:', error);
    showSystemMessage(`Error during compaction: ${error.message}`);
  }
}

/**
 * Handle /reload command.
 * Reloads the agent's startup instructions without generating a response.
 */
async function handleReloadCommand() {
  if (!state.currentSession) {
    alert('No active session. Please select or create a session first.');
    return;
  }

  try {
    console.log('[Commands] /reload: Starting...');

    // Fetch startup content from API
    let response = await fetch(`${BASE_PATH}/api/commands/start`, {
      credentials: 'same-origin',
    });
    let result = await response.json();

    console.log('[Commands] /reload: Fetched startup content', { success: result.success, abilityCount: result.abilityCount });

    if (!result.success) {
      alert(`Failed to reload instructions: ${result.error}`);
      return;
    }

    // Send as a hidden system message (agent sees it but user doesn't need response)
    let reloadContent = `[System Reload]\n\nYour instructions have been refreshed:\n\n${result.content}`;

    // Store as hidden message with visible acknowledgment
    let postResponse = await fetch(`${BASE_PATH}/api/sessions/${state.currentSession.id}/messages`, {
      method:      'POST',
      headers:     { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body:        JSON.stringify({
        content:           reloadContent,
        hidden:            true,   // Hide instructions from chat display
        showAcknowledgment: true,  // Show visible confirmation message
      }),
    });

    console.log('[Commands] /reload: POST response status', postResponse.status);

    if (!postResponse.ok) {
      let errorData = await postResponse.json().catch(() => ({}));
      throw new Error(errorData.error || 'Failed to store reload message');
    }

    console.log('[Commands] /reload: Complete');
  } catch (error) {
    console.error('[Commands] /reload failed:', error);
    // Show error as alert since chat feedback may not work for errors
    alert(`Reload failed: ${error.message}`);
  }
}

/**
 * Handle /update_usage command.
 * Usage: /update_usage <cost>  - e.g., /update_usage 5.50
 * This updates the usage tracker to match the user's actual API cost.
 */
async function handleUpdateUsageCommand(args) {
  let input = args.trim();

  if (!input) {
    showSystemMessage(`Usage: /update_usage <cost>\n\nProvide your current actual API cost (in dollars).\n\nExample: /update_usage 5.50\n\nThis will adjust the usage tracker to match your actual spend.`);
    return;
  }

  // Parse cost - remove $ if present
  let actualCost = parseFloat(input.replace(/^\$/, ''));

  if (isNaN(actualCost) || actualCost < 0) {
    showSystemMessage(`Invalid cost: "${input}"\n\nPlease provide a number, e.g., /update_usage 5.50`);
    return;
  }

  try {
    let result = await createUsageCorrection({
      actualCost: actualCost,
      reason:     'User-reported actual cost',
    });

    let usageMessage = `Usage correction applied.\n\n`;
    usageMessage += `**Previous:** ${formatCost(result.previousCost)}\n`;
    usageMessage += `**New:** ${formatCost(result.newCost)}\n`;

    if (result.correctionAmount !== 0) {
      let sign = (result.correctionAmount >= 0) ? '+' : '';
      usageMessage += `**Adjustment:** ${sign}${formatCost(result.correctionAmount)}`;
    } else {
      usageMessage += `No adjustment needed - tracking is accurate.`;
    }

    showSystemMessage(usageMessage);

    // Reload usage to update the header display
    if (state.currentSession) {
      await loadSessionUsage(state.currentSession.id);
    } else {
      await loadGlobalUsage();
    }
  } catch (error) {
    console.error('Failed to update usage:', error);
    showSystemMessage(`Failed to update usage: ${error.message}`);
  }
}

async function handleAbilityCommand(args) {
  let parts      = args.trim().split(/\s+/);
  let subcommand = parts[0]?.toLowerCase() || 'list';
  let name       = parts.slice(1).join(' ');

  switch (subcommand) {
    case 'create':
    case 'new':
      showAbilityModal();
      break;

    case 'edit':
      if (!name) {
        showSystemMessage('Usage: /ability edit <name>');
        return;
      }
      await editAbilityByName(name);
      break;

    case 'delete':
      if (!name) {
        showSystemMessage('Usage: /ability delete <name>');
        return;
      }
      await deleteAbilityByName(name);
      break;

    case 'list':
    default:
      await listAbilities();
      break;
  }
}

async function listAbilities() {
  try {
    let response = await fetch(`${BASE_PATH}/api/abilities`);
    let data     = await response.json();

    let text = '# Abilities\n\n';

    // Group by type
    let processes = data.abilities.filter((a) => a.type === 'process');
    let functions = data.abilities.filter((a) => a.type === 'function');

    if (functions.length > 0) {
      text += '## Functions\n';
      for (let ability of functions) {
        let danger = (ability.dangerLevel !== 'safe') ? ` [${ability.dangerLevel}]` : '';
        text += `  **${ability.name}**${danger} - ${ability.description || 'No description'} (${ability.source})\n`;
      }
      text += '\n';
    }

    if (processes.length > 0) {
      text += '## Process Abilities\n';
      for (let ability of processes) {
        let danger = (ability.dangerLevel !== 'safe') ? ` [${ability.dangerLevel}]` : '';
        text += `  **${ability.name}**${danger} - ${ability.description || 'No description'} (${ability.source})\n`;
      }
    }

    if (data.abilities.length === 0)
      text += 'No abilities configured.\n';

    text += '\nCommands: /ability create, /ability edit <name>, /ability delete <name>';

    showSystemMessage(text);
  } catch (error) {
    console.error('Failed to list abilities:', error);
    showSystemMessage('Failed to load abilities.');
  }
}

async function editAbilityByName(name) {
  try {
    let response = await fetch(`${BASE_PATH}/api/abilities`);
    let data     = await response.json();

    let ability = data.abilities.find((a) => a.name === name && a.source === 'user');

    if (!ability) {
      showSystemMessage(`Ability "${name}" not found or cannot be edited (only user abilities can be edited).`);
      return;
    }

    showAbilityModal(ability);
  } catch (error) {
    console.error('Failed to edit ability:', error);
  }
}

async function deleteAbilityByName(name) {
  try {
    let response = await fetch(`${BASE_PATH}/api/abilities`);
    let data     = await response.json();

    let ability = data.abilities.find((a) => a.name === name && a.source === 'user');

    if (!ability) {
      showSystemMessage(`Ability "${name}" not found or cannot be deleted (only user abilities can be deleted).`);
      return;
    }

    if (!confirm(`Delete ability "${name}"?`))
      return;

    await fetch(`${BASE_PATH}/api/abilities/${ability.id}`, { method: 'DELETE' });

    showSystemMessage(`Ability "${name}" deleted.`);
  } catch (error) {
    console.error('Failed to delete ability:', error);
    showSystemMessage('Failed to delete ability.');
  }
}
