'use strict';

// ============================================================================
// Streaming Message Processing
// ============================================================================
// Handles real-time streaming of agent responses, including:
// - Progressive text display
// - HML element rendering
// - Interaction banners (websearch, etc.)
// - Tool use display
//
// Dependencies: state, elements, debug, renderMessages, forceScrollToBottom,
//               scrollToBottom, sendMessageStream, renderMarkup, escapeHtml,
//               stripInteractionTags, calculateCost, updateCostDisplay,
//               formatRelativeDate, formatTokenCount, processMessageQueue

/**
 * Process a message with streaming response.
 * Shows progressive text and HML element updates in real-time.
 */
async function processMessageStream(content) {
  debug('App', 'processMessageStream called', { contentLength: content.length });

  state.isLoading = true;

  let now = new Date().toISOString();

  // Add user message as an optimistic frame via session-frames-provider
  // (SINGLE SOURCE OF TRUTH for rendering — replaced dual SessionStore + provider writes)
  // Strip interaction tags to match what server stores (for proper reconciliation)
  let displayContent = stripInteractionTags(content);
  let provider = getFramesProvider();
  if (provider && typeof provider.addOptimisticFrame === 'function') {
    provider.addOptimisticFrame({
      id: 'optimistic-user-' + Date.now(),
      type: 'message',
      authorType: 'user',
      timestamp: now,
      payload: {
        role: 'user',
        content: displayContent,
      },
    });
  }

  forceScrollToBottom(); // User just sent a message, always scroll to show it

  // Initialize streaming message state
  state.streamingMessage = {
    id:       null,
    content:  '',
    elements: {},  // Map of elementId -> element state
  };
  debug('App', 'Initialized streaming message state');

  // Create streaming message placeholder
  createStreamingMessagePlaceholder();
  debug('App', 'Created streaming placeholder');

  try {
    debug('App', 'Calling sendMessageStream', { sessionId: state.currentSession.id });
    let streamResult = await sendMessageStream(state.currentSession.id, content, {
      // Handle command responses (server-side command execution)
      onCommand: (data) => {
        debug('App', 'Command response received', data);
        // Commands create frames via WebSocket, so we just clean up streaming state
        removeStreamingMessagePlaceholder();
        state.streamingMessage = null;

        // Handle special command flags
        if (data.streamingMode !== undefined) {
          state.streamingMode = data.streamingMode;
          debug('App', 'Streaming mode set to:', data.streamingMode);
        }

        // The frames are already created by the server and will arrive via WebSocket
        // Nothing more to do here - hero-chat will render them automatically
      },

      onStart: (data) => {
        debug('App', 'onStart callback', data);
        state.streamingMessage.id = data.messageId;
        updateStreamingHeader(data.agentName || 'Assistant');

        // Set data-message-id on streaming element so hml-prompt can find it
        let streamingEl = document.getElementById('streaming-message');
        if (streamingEl && data.messageId) {
          streamingEl.setAttribute('data-message-id', data.messageId);
        }

        // Note: data.estimatedTokens is the total context size (history + system prompt),
        // not the response size, so we don't display it to avoid confusion with the
        // final response token count shown after completion.
      },

      onText: (data) => {
        debug('App', 'onText callback', { textLength: data.text.length, totalContent: state.streamingMessage.content.length });
        state.streamingMessage.content += data.text;
        updateStreamingContent(state.streamingMessage.content);
        scrollToBottom();
      },

      onElementStart: (data) => {
        debug('App', 'onElementStart callback', data);
        // Skip elements that shouldn't render as streaming elements:
        // - hml-prompt/response: They're Web Components that render themselves
        // - interaction: System communication between agent and server, not for display
        if (data.type === 'hml-prompt' || data.type === 'response' || data.type === 'interaction') {
          return;
        }
        state.streamingMessage.elements[data.id] = {
          id:         data.id,
          type:       data.type,
          attributes: data.attributes,
          content:    '',
          status:     'streaming',
          executable: data.executable,
        };
        renderStreamingElement(data.id);
        scrollToBottom();
      },

      onElementUpdate: (data) => {
        if (state.streamingMessage.elements[data.id]) {
          state.streamingMessage.elements[data.id].content = data.content;
          renderStreamingElement(data.id);
        }
      },

      onElementComplete: (data) => {
        if (state.streamingMessage.elements[data.id]) {
          state.streamingMessage.elements[data.id].content = data.content;
          state.streamingMessage.elements[data.id].status  = (data.executable) ? 'pending' : 'complete';
          renderStreamingElement(data.id);
        }
      },

      onElementExecuting: (data) => {
        if (state.streamingMessage.elements[data.id]) {
          state.streamingMessage.elements[data.id].status = 'executing';
          renderStreamingElement(data.id);
        }
      },

      onElementResult: (data) => {
        if (state.streamingMessage.elements[data.id]) {
          state.streamingMessage.elements[data.id].status = 'complete';
          state.streamingMessage.elements[data.id].result = data.result;
          renderStreamingElement(data.id);
        }
      },

      onElementError: (data) => {
        if (state.streamingMessage.elements[data.id]) {
          state.streamingMessage.elements[data.id].status = 'error';
          state.streamingMessage.elements[data.id].error  = data.error;
          renderStreamingElement(data.id);
        }
      },

      onToolUseStart: (data) => {
        // Show tool use in streaming UI
        appendStreamingToolUse(data);
      },

      onToolResult: (data) => {
        // Update tool result in streaming UI
        updateStreamingToolResult(data);
      },

      // Interaction events (for <interaction> tag handling)
      onInteractionDetected: (data) => {
        debug('App', 'Interaction detected', { count: data.count, iteration: data.iteration });
        // Strip interaction tags from displayed content
        if (state.streamingMessage) {
          let cleanContent = stripInteractionTags(state.streamingMessage.content);
          state.streamingMessage.content = cleanContent;
          updateStreamingContent(cleanContent);
        }
        // Show indicator that interaction is being processed
        showStreamingStatus('Processing interaction...');
      },

      onInteractionStarted: (data) => {
        debug('Streaming',' onInteractionStarted called:', data);
        debug('Streaming',' state.streamingMessage:', !!state.streamingMessage);
        debug('Streaming',' hasBanner:', !!data.banner);
        debug('App', 'Interaction started', data);

        // Only show banners for functions that opt-in via banner config
        // Functions without a banner config in their register() method are silent
        if (!data.banner) {
          debug('Streaming',' No banner config, skipping banner for:', data.targetProperty);
          return;
        }

        // Use banner config for label and icon
        let label = data.banner.label || data.targetProperty || 'interaction';
        let icon = data.banner.icon || '⚡';
        let content = '';

        // Get content from payload using banner.contentKey
        if (data.banner.contentKey && data.payload?.[data.banner.contentKey]) {
          content = data.payload[data.banner.contentKey];
        } else if (data.payload) {
          content = (typeof data.payload === 'string') ? data.payload : JSON.stringify(data.payload);
        }

        // Track pending interaction
        if (!state.streamingMessage.pendingInteractions) {
          state.streamingMessage.pendingInteractions = {};
        }
        state.streamingMessage.pendingInteractions[data.interactionId] = {
          label,
          icon,
          content,
          status:    'pending',
          startTime: Date.now(),
        };

        // Update the streaming content to show pending banner
        appendInteractionBanner(data.interactionId, label, content, 'pending', icon);
      },

      onInteractionUpdate: (data) => {
        debug('Streaming',' onInteractionUpdate:', data);
        debug('App', 'Interaction update', data);
        // Update the pending banner with new content (e.g., actual query after "...")
        if (state.streamingMessage?.pendingInteractions?.[data.interactionId]) {
          let pending = state.streamingMessage.pendingInteractions[data.interactionId];
          if (data.payload?.query) {
            pending.content = data.payload.query;
            // Update the banner content in DOM
            updateInteractionBannerContent(data.interactionId, data.payload.query);
          }
        }
      },

      onInteractionResult: (data) => {
        debug('Streaming',' onInteractionResult:', {
          interactionId:       data.interactionId,
          status:              data.status,
          hasStreamingMessage: !!state.streamingMessage,
          hasPendingInteractions: !!state.streamingMessage?.pendingInteractions,
          pendingKeys:         state.streamingMessage?.pendingInteractions ? Object.keys(state.streamingMessage.pendingInteractions) : [],
        });
        debug('App', 'Interaction result', data);
        // Update the pending banner to show complete status
        let elapsedMs = null;
        if (state.streamingMessage?.pendingInteractions?.[data.interactionId]) {
          let pending = state.streamingMessage.pendingInteractions[data.interactionId];
          pending.status = data.status;
          elapsedMs = Date.now() - pending.startTime;
        } else {
          debug('Streaming',' onInteractionResult: pending interaction not in state (may be finalized), updating banner directly');
        }
        // Always try to update the banner - it may still be in the DOM even after finalization
        updateInteractionBanner(data.interactionId, data.status, data.result, elapsedMs);
      },

      onInteractionContinuing: (data) => {
        debug('App', 'Interaction continuing, getting final response');
        showStreamingStatus('Getting response...');
      },

      onInteractionComplete: (data) => {
        debug('Streaming',' onInteractionComplete called:', {
          hasContent:            !!data.content,
          contentLength:         data.content?.length,
          hasStreamingMessage:   !!state.streamingMessage,
          contentPreview:        data.content?.slice(0, 100),
        });
        debug('App', 'Interaction complete', { contentLength: data.content?.length });
        // Update the streaming content with the final clean content
        if (data.content && state.streamingMessage) {
          state.streamingMessage.content = data.content;
          updateStreamingContent(data.content);
          debug('Streaming',' Updated streaming content');
        } else {
          debug('Streaming',' Did NOT update streaming content');
        }
        hideStreamingStatus();
      },

      onInteractionError: (data) => {
        debug('App', 'Interaction error', data);
        hideStreamingStatus();
      },

      onRateLimitWait: (data) => {
        debug('App', 'Rate limit wait', data);
        showStreamingStatus(`Rate limit reached. Waiting ${data.waitSeconds}s before retrying (attempt ${data.retryCount}/3)...`);
      },

      onUsage: (data) => {
        debug('App', 'Token usage', data);
        // Calculate cost from tokens
        let inputTokens  = data.input_tokens || 0;
        let outputTokens = data.output_tokens || 0;
        let cost = calculateCost(inputTokens, outputTokens);

        // Update spend tracking via replacement (Proxy detects top-level writes)
        state.sessionSpend = { cost: state.sessionSpend.cost + cost };
        state.serviceSpend = { cost: state.serviceSpend.cost + cost };
        state.globalSpend  = { cost: state.globalSpend.cost + cost };

        // Update cost display
        updateCostDisplay();
      },

      onComplete: (data) => {
        debug('Streaming',' onComplete called:', {
          hasContent:      !!data.content,
          contentLength:   data.content?.length,
          warning:         data.warning,
          contentPreview:  data.content?.slice(0, 100),
        });
        debug('App', 'onComplete callback', data);
        // Check for warning (empty response)
        if (data.warning && !data.content) {
          debug('App', 'Warning received:', data.warning);
          showStreamingError('Agent returned no response. This may indicate an API issue.');
          return;
        }
        // Finalize the streaming message
        finalizeStreamingMessage(data);
        debug('Streaming',' Finalization complete');
      },

      onError: (data) => {
        debug('App', 'onError callback', data);
        showStreamingError(data.error);
      },
    });

    debug('App', 'sendMessageStream resolved', { isCommand: streamResult?.isCommand });

    // If this was a command response, we're already done (handled by onCommand callback)
    if (streamResult?.isCommand) {
      debug('App', 'Command response handled, skipping finalization');
    } else if (state.streamingMessage) {
      // Ensure streaming message is finalized even if onComplete wasn't called
      debug('App', 'Finalizing streaming message (fallback)', {
        contentLength: state.streamingMessage.content.length,
        messageId: state.streamingMessage.id,
      });
      finalizeStreamingMessage({
        content: state.streamingMessage.content,
        messageId: state.streamingMessage.id,
      });
    }
  } catch (error) {
    debug('App', 'processMessageStream caught error', error.message);
    console.error('Stream error:', error);
    showStreamingError(error.message);
  }

  debug('App', 'processMessageStream complete');
  state.isLoading = false;

  // Focus input via hero-input component
  let heroInputEl = document.querySelector('hero-input');
  if (heroInputEl && typeof heroInputEl.focus === 'function')
    heroInputEl.focus();

  // Process any queued messages
  await processMessageQueue();
}

/**
 * Get the session-frames-provider element.
 * @returns {Element|null}
 */
function getFramesProvider() {
  return document.getElementById('session-frames');
}

/**
 * Create the streaming message placeholder in the chat.
 * Uses session-frames-provider's phantom frame system for proper shadow DOM rendering.
 */
function createStreamingMessagePlaceholder() {
  // Use session-frames-provider for phantom frame (preferred)
  let provider = getFramesProvider();
  if (provider && typeof provider.setPhantomFrame === 'function') {
    provider.setPhantomFrame({
      id: 'streaming-' + Date.now(),
      type: 'message',
      authorType: 'agent',
      timestamp: new Date().toISOString(),
      payload: {
        role: 'assistant',
        content: '',
      },
      complete: false,
    });
  }
}

/**
 * Remove the streaming message placeholder.
 * Used when a command is executed (no streaming response needed).
 */
function removeStreamingMessagePlaceholder() {
  // Clear phantom frame in provider (single source of truth)
  let provider = getFramesProvider();
  if (provider && typeof provider.clearPhantomFrame === 'function') {
    provider.clearPhantomFrame();
  }

  // Clear streaming state in hero-chat
  let heroChat = elements.heroChat;
  if (heroChat && typeof heroChat.setStreaming === 'function') {
    heroChat.setStreaming(null);
  }
}

/**
 * Update the streaming message header (e.g., with agent name).
 */
function updateStreamingHeader(agentName) {
  let el = document.querySelector('#streaming-message .message-header');
  if (el)
    el.textContent = agentName;
}

/**
 * Update the streaming content with new text.
 */
function updateStreamingContent(content) {
  // Update phantom frame in session-frames-provider (single source of truth)
  let provider = getFramesProvider();
  if (provider && provider.phantomFrame) {
    provider.setPhantomFrame({
      ...provider.phantomFrame,
      payload: {
        ...provider.phantomFrame.payload,
        content: content,
      },
    });
  }
}

/**
 * Render a streaming HML element.
 */
function renderStreamingElement(elementId) {
  let element   = state.streamingMessage.elements[elementId];
  let container = document.querySelector('#streaming-message .streaming-elements');

  if (!element || !container) return;

  let existingEl = container.querySelector(`[data-element-id="${elementId}"]`);
  let html       = renderStreamingElementHtml(element);

  if (existingEl) {
    existingEl.outerHTML = html;
  } else {
    container.insertAdjacentHTML('beforeend', html);
  }
}

/**
 * Generate HTML for a streaming HML element.
 */
function renderStreamingElementHtml(element) {
  let statusClass = `streaming-element-${element.status}`;
  let statusIcon  = getStreamingStatusIcon(element.status);
  let typeIcon    = getElementTypeIcon(element.type);

  let contentHtml = '';
  if (element.content) {
    contentHtml = `<div class="streaming-element-content">${escapeHtml(element.content)}</div>`;
  }

  let resultHtml = '';
  if (element.result) {
    let resultText = (typeof element.result === 'string') ? element.result : JSON.stringify(element.result, null, 2);
    resultHtml = `<div class="streaming-element-result"><pre>${escapeHtml(resultText)}</pre></div>`;
  }

  let errorHtml = '';
  if (element.error) {
    errorHtml = `<div class="streaming-element-error">${escapeHtml(element.error)}</div>`;
  }

  return `
    <div class="streaming-element ${statusClass}" data-element-id="${element.id}">
      <div class="streaming-element-header">
        <span class="streaming-element-icon">${typeIcon}</span>
        <span class="streaming-element-type">${escapeHtml(element.type)}</span>
        <span class="streaming-element-status">${statusIcon}</span>
      </div>
      ${contentHtml}
      ${resultHtml}
      ${errorHtml}
    </div>
  `;
}

/**
 * Get status icon for streaming element.
 */
function getStreamingStatusIcon(status) {
  switch (status) {
    case 'streaming':  return '<span class="status-streaming">...</span>';
    case 'pending':    return '<span class="status-pending">⏳</span>';
    case 'executing':  return '<span class="status-executing"><span class="spinner"></span></span>';
    case 'complete':   return '<span class="status-complete">✓</span>';
    case 'error':      return '<span class="status-error">✗</span>';
    default:           return '';
  }
}

/**
 * Get icon for element type.
 */
function getElementTypeIcon(type) {
  switch (type) {
    case 'websearch': return '🔍';
    case 'bash':      return '$';
    case 'ask':       return '❓';
    case 'thinking':  return '💭';
    case 'todo':      return '📋';
    case 'progress':  return '📊';
    case 'link':      return '🔗';
    case 'copy':      return '📋';
    case 'result':    return '📄';
    default:          return '▪';
  }
}

/**
 * Append tool use to streaming message.
 */
function appendStreamingToolUse(data) {
  let container = document.querySelector('#streaming-message .streaming-elements');
  if (!container) return;

  let html = `
    <div class="streaming-tool-use" data-tool-id="${escapeHtml(data.toolId || '')}">
      <div class="streaming-tool-header">
        <span class="streaming-tool-icon">⚙</span>
        <span class="streaming-tool-name">${escapeHtml(data.name || 'Tool')}</span>
        <span class="streaming-tool-status"><span class="spinner"></span></span>
      </div>
    </div>
  `;

  container.insertAdjacentHTML('beforeend', html);
}

/**
 * Update tool result in streaming message.
 */
function updateStreamingToolResult(data) {
  let el = document.querySelector(`#streaming-message .streaming-tool-use[data-tool-id="${data.toolId}"]`);
  if (!el) return;

  let statusEl = el.querySelector('.streaming-tool-status');
  if (statusEl)
    statusEl.innerHTML = '<span class="status-complete">✓</span>';

  let resultHtml = `<div class="streaming-tool-result"><pre>${escapeHtml(data.content || '')}</pre></div>`;
  el.insertAdjacentHTML('beforeend', resultHtml);
}

/**
 * Finalize the streaming message and add to state.
 * Idempotent - safe to call multiple times.
 */
function finalizeStreamingMessage(data) {
  debug('Streaming',' finalizeStreamingMessage called:', {
    hasData:               !!data,
    hasDataContent:        !!data?.content,
    dataContentLength:     data?.content?.length,
    hasStreamingMessage:   !!state.streamingMessage,
    streamingContentLen:   state.streamingMessage?.content?.length,
  });
  debug('App', 'finalizeStreamingMessage called', data);

  // Skip if already finalized
  if (!state.streamingMessage) {
    debug('Streaming',' Already finalized, skipping');
    debug('App', 'Already finalized, skipping');
    return;
  }

  // Mark phantom frame as complete (immutable frame pattern — don't clear, update state)
  // The typing indicator will be hidden when complete: true
  // The real frame will arrive via WebSocket and replace the phantom
  let provider = getFramesProvider();
  if (provider && typeof provider.finalizePhantomFrame === 'function') {
    debug('App', 'Finalizing phantom frame in session-frames-provider');
    provider.finalizePhantomFrame();
  }

  // Clear streaming state in hero-chat and re-render
  let heroChat = elements.heroChat;
  if (heroChat) {
    if (typeof heroChat.setStreaming === 'function')
      heroChat.setStreaming(null);

    if (typeof heroChat.renderDebounced === 'function')
      heroChat.renderDebounced();
  }

  // Keep interaction banners visible (they show what actions were taken)
  // Just update their status to reflect completion
  let banners = document.querySelectorAll('#streaming-message .interaction-banner');
  debug('Streaming',' Found interaction banners to preserve:', banners.length);

  // Determine final content
  let finalContent = data.content || state.streamingMessage.content;
  debug('App', 'Final content', { length: finalContent.length, preview: finalContent.slice(0, 100) });

  // Update the displayed content (may differ from streamed content due to interaction handling)
  let streamingEl = document.getElementById('streaming-message');
  debug('Streaming',' finalizeStreamingMessage update:', {
    streamingElFound:  !!streamingEl,
    finalContentLen:   finalContent?.length,
    finalContentPrev:  finalContent?.slice(0, 100),
  });
  if (streamingEl) {
    let contentEl = streamingEl.querySelector('.streaming-content');
    if (contentEl) {
      debug('Streaming',' Setting innerHTML on streaming-content element');
      contentEl.innerHTML = renderMarkup(finalContent);
    }

    // Add timestamp and token count
    let now = new Date().toISOString();
    let tokenEstimate = Math.ceil(finalContent.length / 4);
    let timeStr  = formatRelativeDate(now);
    let tokenStr = formatTokenCount(tokenEstimate);
    let timestampEl = document.createElement('div');
    timestampEl.className = 'message-timestamp';
    timestampEl.textContent = `${timeStr} · ~${tokenStr} tokens`;
    streamingEl.appendChild(timestampEl);

    debug('App', 'Removing streaming class from element');
    streamingEl.classList.remove('message-streaming');

    // Update data-message-id with the persisted database ID if available
    if (data.persistedMessageID) {
      streamingEl.setAttribute('data-message-id', data.persistedMessageID);
      debug('App', 'Updated data-message-id to persisted ID:', data.persistedMessageID);
    }

    streamingEl.removeAttribute('id');
  }

  // Assistant message arrives as a frame via WebSocket broadcast.
  // session-frames-provider handles it — no need to add to SessionStore.

  // Clear streaming state
  state.streamingMessage = null;
  debug('App', 'Streaming state cleared');
}

/**
 * Show error in streaming message.
 */
function showStreamingError(errorMessage) {
  let streamingEl = document.getElementById('streaming-message');
  if (!streamingEl) return;

  // Remove streaming indicator
  let indicator = streamingEl.querySelector('.streaming-indicator');
  if (indicator)
    indicator.remove();

  // Add error message
  let bubble = streamingEl.querySelector('.message-bubble');
  if (bubble) {
    bubble.insertAdjacentHTML('beforeend', `
      <div class="streaming-error">
        <span class="error-icon">⚠</span>
        <span class="error-text">${escapeHtml(errorMessage)}</span>
      </div>
    `);
  }

  // Remove streaming class and id
  streamingEl.classList.remove('message-streaming');
  streamingEl.classList.add('message-error');
  streamingEl.removeAttribute('id');

  // Clear streaming state
  state.streamingMessage = null;

  // Clear phantom frame in session-frames-provider
  let provider = getFramesProvider();
  if (provider && typeof provider.clearPhantomFrame === 'function') {
    provider.clearPhantomFrame();
  }

  // Sync streaming state to hero-chat
  let heroChat = elements.heroChat;
  if (heroChat && typeof heroChat.setStreaming === 'function') {
    heroChat.setStreaming(null);
  }
  if (heroChat && typeof heroChat.renderDebounced === 'function') {
    heroChat.renderDebounced();
  }
}

/**
 * Show a status message in the streaming message (for interactions).
 * Uses the <hero-interaction> WebComponent with jiggling brain emoji.
 */
function showStreamingStatus(message) {
  let streamingEl = document.getElementById('streaming-message');
  if (!streamingEl) return;

  // Find or create status element
  let statusEl = streamingEl.querySelector('.streaming-status');
  if (!statusEl) {
    let bubble = streamingEl.querySelector('.message-bubble');
    if (bubble) {
      bubble.insertAdjacentHTML('beforeend', `
        <div class="streaming-status">
          <hero-interaction status="processing" message="${escapeHtml(message)}"></hero-interaction>
        </div>
      `);
    }
  } else {
    let interactionEl = statusEl.querySelector('hero-interaction');
    if (interactionEl) {
      interactionEl.setAttribute('message', message);
    }
  }
}

/**
 * Hide the streaming status message.
 */
function hideStreamingStatus() {
  let statusEl = document.querySelector('#streaming-message .streaming-status');
  if (statusEl)
    statusEl.remove();
}

/**
 * Append an interaction banner to the streaming message.
 * Shows "Web Search: [query] - Pending" style banners.
 * Only called for functions that opt-in via banner config.
 *
 * @param {string} interactionId - Unique ID for this interaction
 * @param {string} label - Display label from banner config
 * @param {string} content - Content to display (from payload via contentKey)
 * @param {string} status - Status: 'pending', 'completed', 'failed'
 * @param {string} icon - Icon emoji from banner config (default: '⚡')
 */
function appendInteractionBanner(interactionId, label, content, status, icon = '⚡') {
  debug('Streaming',' appendInteractionBanner called:', { interactionId, label, content, status, icon });
  let streamingEl = document.getElementById('streaming-message');
  debug('Streaming',' streamingEl found:', !!streamingEl);
  if (!streamingEl) {
    debug('Streaming',' No streaming element found, cannot append banner');
    return;
  }

  let bubble = streamingEl.querySelector('.message-bubble');
  debug('Streaming',' bubble found:', !!bubble);
  if (!bubble) return;

  // Create the banner element
  let statusText = (status === 'pending') ? 'Pending' : status;

  let bannerHtml = `
    <div class="interaction-banner interaction-banner-${status}" data-interaction-id="${escapeHtml(interactionId)}">
      <span class="interaction-banner-icon">${icon}</span>
      <span class="interaction-banner-label">${escapeHtml(label)}:</span>
      <span class="interaction-banner-content">${escapeHtml(content.substring(0, 100))}${(content.length > 100) ? '...' : ''}</span>
      <span class="interaction-banner-status">${statusText}</span>
    </div>
  `;

  // Insert before streaming-content if it exists, otherwise append
  let contentEl = bubble.querySelector('.streaming-content');
  if (contentEl) {
    contentEl.insertAdjacentHTML('beforebegin', bannerHtml);
  } else {
    bubble.insertAdjacentHTML('afterbegin', bannerHtml);
  }
}

/**
 * Format milliseconds as human-readable time.
 */
function formatElapsedTime(ms) {
  if (ms < 1000) {
    return `${ms}ms`;
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  } else {
    let minutes = Math.floor(ms / 60000);
    let seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}m ${seconds}s`;
  }
}

/**
 * Update an interaction banner status.
 */
function updateInteractionBanner(interactionId, status, result, elapsedMs) {
  debug('Streaming',' updateInteractionBanner:', { interactionId, status, elapsedMs });

  // Debug: list all banners in DOM
  let allBanners = document.querySelectorAll('.interaction-banner');
  debug('Streaming',' All banners in DOM:', allBanners.length);
  allBanners.forEach((b, i) => {
    debug('Streaming', `Banner ${i}: data-interaction-id="${b.getAttribute('data-interaction-id')}"`);
  });

  let banner = document.querySelector(`.interaction-banner[data-interaction-id="${interactionId}"]`);
  debug('Streaming',' Banner found for interactionId:', !!banner, 'looking for:', interactionId);
  if (!banner) {
    debug('Streaming',' BANNER NOT FOUND - cannot update');
    return;
  }

  // Update status
  let statusEl = banner.querySelector('.interaction-banner-status');
  if (statusEl) {
    let statusText;
    if (status === 'completed' && elapsedMs) {
      statusText = `Completed in ${formatElapsedTime(elapsedMs)}`;
    } else if (status === 'completed') {
      statusText = 'Complete';
    } else if (status === 'failed') {
      statusText = 'Failed';
    } else {
      statusText = status;
    }
    statusEl.textContent = statusText;
    debug('Streaming',' Updated status text to:', statusText);
  } else {
    debug('Streaming',' No statusEl found in banner!');
  }

  // Update class for styling
  banner.className = `interaction-banner interaction-banner-${status}`;
  debug('Streaming',' Updated banner class to:', banner.className);
}

/**
 * Update an interaction banner content (e.g., when query becomes available).
 */
function updateInteractionBannerContent(interactionId, content) {
  debug('Streaming',' updateInteractionBannerContent:', { interactionId, content });
  let banner = document.querySelector(`.interaction-banner[data-interaction-id="${interactionId}"]`);
  if (!banner) return;

  let contentEl = banner.querySelector('.interaction-banner-content');
  if (contentEl) {
    contentEl.textContent = content.substring(0, 100) + ((content.length > 100) ? '...' : '');
  }
}
