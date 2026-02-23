'use strict';

// ============================================================================
// SessionStore Helpers
// ============================================================================

/**
 * Get the SessionMessages instance for the current session.
 * Returns null if no session is active.
 * @returns {SessionMessages|null}
 */
function getCurrentSessionMessages() {
  if (!state.currentSession?.id) return null;
  return sessionStore.getSession(state.currentSession.id);
}

// ============================================================================
// System Message Helper
// ============================================================================

/**
 * Display a system message to the user (shown as assistant message).
 * Consolidates the common pattern of push + render + scroll.
 * @param {string} text - Message text to display
 */
function showSystemMessage(text) {
  const session = getCurrentSessionMessages();
  if (session) {
    session.add({
      role:    'assistant',
      content: [{ type: 'text', text }],
    });
  }
  renderMessages();
  forceScrollToBottom();
}

// ============================================================================
// Cost Display Functions
// ============================================================================
// Note: formatTokenCount, calculateCost, formatCost are in utils.js

/**
 * Update the header cost displays (global, service, and session).
 */
function updateCostDisplay() {
  // Update global cost in sessions view
  let globalCostSessions = document.getElementById('global-cost-sessions');
  if (globalCostSessions) {
    globalCostSessions.textContent = formatCost(state.globalSpend.cost);
  }

  // Update all costs in chat view
  let globalCostChat = document.getElementById('global-cost-chat');
  if (globalCostChat) {
    globalCostChat.textContent = formatCost(state.globalSpend.cost);
  }

  let serviceCostChat = document.getElementById('service-cost-chat');
  if (serviceCostChat) {
    serviceCostChat.textContent = formatCost(state.serviceSpend.cost);
  }

  let sessionCostChat = document.getElementById('session-cost-chat');
  if (sessionCostChat) {
    sessionCostChat.textContent = formatCost(state.sessionSpend.cost);
  }
}

/**
 * Fetch and update global usage (for sessions list view).
 */
async function loadGlobalUsage() {
  try {
    let usage = await fetchUsage();
    state.globalSpend = { cost: usage.global?.cost || 0 };
    updateCostDisplay();
  } catch (error) {
    console.error('Failed to fetch global usage:', error);
  }
}

/**
 * Fetch and update session usage (for chat view).
 */
async function loadSessionUsage(sessionId) {
  try {
    let usage = await fetchSessionUsage(sessionId);
    state.globalSpend = { cost: usage.global?.cost || 0 };
    state.serviceSpend = { cost: usage.service?.cost || 0 };
    state.sessionSpend = { cost: usage.session?.cost || 0 };

    updateCostDisplay();
  } catch (error) {
    console.error('Failed to fetch session usage:', error);
  }
}

/**
 * Reset session cost tracking.
 */
function resetSessionCost() {
  state.sessionSpend = { cost: 0 };
  updateCostDisplay();
}

// ============================================================================
// Chat
// ============================================================================

async function loadSession(sessionId) {
  try {
    let session    = await fetchSession(sessionId);
    state.currentSession = session;

    // Initialize session messages in SessionStore
    const sessionMessages = sessionStore.getSession(session.id);
    sessionMessages.init(session.messages || []);

    // Load session usage (global, service, and session spend)
    await loadSessionUsage(sessionId);

    renderMessages();
    scrollToBottom();

    // Update participant sidebar
    let participantList = document.getElementById('participant-list');
    if (participantList && typeof participantList.setParticipants === 'function')
      participantList.setParticipants(session.participants, session.id);

    // Focus input via hero-input component
    let heroInputEl = document.querySelector('hero-input');
    if (heroInputEl && typeof heroInputEl.focus === 'function')
      heroInputEl.focus();
  } catch (error) {
    console.error('Failed to load session:', error);
    navigate('/');
  }
}

// ============================================================================
// Debounced Render System
// ============================================================================
// Prevents infinite render loops by debouncing rapid render calls.
// Uses both a debounce delay AND a max wait time to ensure responsiveness.

let renderDebounceTimer = null;
let renderMaxWaitTimer = null;
let renderPending = false;
const RENDER_DEBOUNCE_MS = 16;   // ~1 frame at 60fps
const RENDER_MAX_WAIT_MS = 100;  // Max time before forced render

/**
 * The actual render implementation.
 * Session-frames-provider is the SINGLE SOURCE OF TRUTH for rendering.
 * This function only syncs ancillary state (streaming, show-hidden) and
 * triggers a re-render on hero-chat. It does NOT push messages to hero-chat.
 * @private
 */
function renderMessagesImpl() {
  renderPending = false;

  // Clear timers
  if (renderDebounceTimer) {
    clearTimeout(renderDebounceTimer);
    renderDebounceTimer = null;
  }
  if (renderMaxWaitTimer) {
    clearTimeout(renderMaxWaitTimer);
    renderMaxWaitTimer = null;
  }

  if (!elements.heroChat)
    return;

  // Sync show-hidden state
  if (typeof elements.heroChat.setShowHiddenMessages === 'function')
    elements.heroChat.setShowHiddenMessages(state.showHiddenMessages);

  // Sync streaming state
  if (typeof elements.heroChat.setStreaming === 'function')
    elements.heroChat.setStreaming(state.streamingMessage);

  // Trigger a re-render (hero-chat reads from session-frames-provider)
  if (typeof elements.heroChat.renderDebounced === 'function')
    elements.heroChat.renderDebounced();
}

/**
 * Debounced render function.
 * Batches rapid render calls to prevent infinite loops.
 * Guarantees render within RENDER_MAX_WAIT_MS even if calls keep coming.
 */
function renderMessages() {
  // Clear existing debounce timer
  if (renderDebounceTimer) {
    clearTimeout(renderDebounceTimer);
  }

  // Set up max wait timer if this is the first pending render
  if (!renderPending) {
    renderPending = true;
    renderMaxWaitTimer = setTimeout(() => {
      console.log('[Render] Max wait reached, forcing render');
      renderMessagesImpl();
    }, RENDER_MAX_WAIT_MS);
  }

  // Set up debounce timer
  renderDebounceTimer = setTimeout(() => {
    renderMessagesImpl();
  }, RENDER_DEBOUNCE_MS);
}

function renderAssertionBlock(assertion) {
  let { id, assertion: type, name, status, preview, result } = assertion;
  status = status || 'pending';

  if (type === 'thinking')
    return renderThinkingAssertion(assertion);

  if (type === 'question')
    return renderQuestionAssertion(assertion);

  if (type === 'response')
    return renderResponseAssertion(assertion);

  if (type === 'link')
    return renderLinkElement(assertion);

  if (type === 'todo')
    return renderTodoElement(assertion);

  if (type === 'progress')
    return renderProgressElement(assertion);

  // Default: command assertion
  return `
    <div class="assertion-block assertion-${type}" data-assertion-id="${id}">
      <div class="assertion-header">
        <span class="assertion-type">${escapeHtml(type)}</span>
        <span class="assertion-name">${escapeHtml(name)}</span>
        <span class="assertion-status ${status}">${status}</span>
      </div>
      ${(preview) ? `<div class="assertion-preview"><pre>${escapeHtml(preview)}</pre></div>` : ''}
      ${(result) ? `<div class="assertion-result"><pre>${escapeHtml((typeof result === 'string') ? result : JSON.stringify(result, null, 2))}</pre></div>` : ''}
    </div>
  `;
}

function renderThinkingAssertion(assertion) {
  let { id, name, message, status } = assertion;
  let isRunning = (status === 'running' || status === 'pending' || !status);

  return `
    <div class="assertion-block thinking" data-assertion-id="${id}">
      ${(isRunning) ? `
        <div class="thinking-indicator">
          <span></span><span></span><span></span>
        </div>
      ` : ''}
      <span class="thinking-text">${escapeHtml(message || name || 'Processing...')}</span>
    </div>
  `;
}

function renderQuestionAssertion(assertion) {
  let { id, name, message, options, status, answer, mode, timeout } = assertion;
  mode = mode || 'demand';

  if (status === 'completed' && answer !== undefined) {
    return `
      <div class="assertion-block question answered" data-assertion-id="${id}">
        <div class="question-text">${escapeHtml(message)}</div>
        <div class="question-answer">Answer: ${escapeHtml(String(answer))}</div>
      </div>
    `;
  }

  let optionsHtml = '';
  if (Array.isArray(options) && options.length > 0) {
    optionsHtml = options.map((opt) =>
      `<button class="button button-secondary question-option" data-assertion-id="${id}" data-answer="${escapeHtml(String(opt))}">${escapeHtml(String(opt))}</button>`
    ).join('');
  }

  let modeClass   = (mode === 'demand') ? 'question-demand' : 'question-timeout';
  let modeLabel   = (mode === 'demand') ? 'Required' : `Optional (${Math.round(timeout / 1000)}s)`;
  let placeholder = (mode === 'demand') ? 'Your response is required...' : 'Type your answer (optional)...';

  return `
    <div class="assertion-block question ${modeClass}" data-assertion-id="${id}" data-mode="${mode}" tabindex="0">
      <div class="question-header">
        <span class="question-mode-label ${mode}">${modeLabel}</span>
      </div>
      <div class="question-text">${escapeHtml(message)}</div>
      <div class="question-actions">
        ${optionsHtml}
        <input type="text" class="question-input" placeholder="${placeholder}" data-assertion-id="${id}" data-mode="${mode}" tabindex="0">
        <button class="button button-primary question-submit" data-assertion-id="${id}">Submit</button>
      </div>
    </div>
  `;
}

function renderResponseAssertion(assertion) {
  let { id, message } = assertion;

  return `
    <div class="assertion-block response" data-assertion-id="${id}">
      <div class="response-text">${escapeHtml(message)}</div>
    </div>
  `;
}

// Ability approval UI moved to approvals.js

// Streaming message processing moved to streaming.js

// Command handlers moved to commands.js

// ============================================================================
// Auth
// ============================================================================

// Login is handled by the hero-login component.
// It dispatches hero:authenticated on success, which triggers navigation.

async function handleLogout() {
  try {
    await logout();
    document.dispatchEvent(new CustomEvent('hero:logout'));
    disconnectWebSocket();
    state.user     = null;
    state.sessions = [];
    state.agents   = [];
    navigate('/login');
  } catch (error) {
    console.error('Logout failed:', error);
  }
}

// ============================================================================
// WebSocket
// ============================================================================

function connectWebSocket() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN)
    return;

  // Get auth token from cookie
  let token = document.cookie.split('; ')
    .find((c) => c.startsWith('token='))
    ?.split('=')[1];

  if (!token)
    return;

  let protocol = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
  let wsUrl    = `${protocol}//${window.location.host}${BASE_PATH}/ws?token=${token}`;

  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    console.log('WebSocket connected');
  };

  state.ws.onmessage = (event) => {
    try {
      let message = JSON.parse(event.data);
      handleWebSocketMessage(message);
    } catch (e) {
      console.error('WebSocket message parse error:', e);
    }
  };

  state.ws.onclose = () => {
    console.log('WebSocket disconnected');
    state.ws = null;

    // Attempt reconnect after delay (if still authenticated)
    if (state.user)
      setTimeout(connectWebSocket, 5000);
  };

  state.ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
}

function disconnectWebSocket() {
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
}

function handleWebSocketMessage(message) {
  switch (message.type) {
    case 'running_commands':
      state.runningOperations = message.commands;
      renderOperationsPanel();
      break;

    case 'command_update':
      updateOperationState(message.command);
      break;

    case 'abort_result':
      // Handled by UI update from command_update
      break;

    case 'assertion_new':
      handleAssertionNew(message);
      break;

    case 'assertion_update':
      handleAssertionUpdate(message);
      break;

    case 'question_prompt':
      handleQuestionPrompt(message);
      break;

    case 'message_append':
      handleMessageAppend(message);
      break;

    // Element message types
    case 'element_new':
      handleElementNew(message);
      break;

    case 'element_update':
      handleElementUpdate(message);
      break;

    case 'todo_item_update':
      handleTodoItemUpdate(message);
      break;

    // Ability approval requests
    case 'ability_approval_request':
      handleAbilityApprovalRequest(message);
      break;

    case 'ability_approval_timeout':
      handleAbilityApprovalTimeout(message);
      break;

    // Ability questions
    case 'ability_question':
      handleAbilityQuestionRequest(message);
      break;

    case 'ability_question_timeout':
      handleAbilityQuestionTimeout(message);
      break;

    // New message from server (used for onstart flow and real-time sync)
    case 'new_message':
      handleNewMessage(message);
      break;
  }
}

/**
 * Handle a new message broadcast from the server.
 * This is used for the onstart flow and real-time message sync.
 */
function handleNewMessage(wsMessage) {
  let { sessionId, message } = wsMessage;

  debug('App', 'handleNewMessage', { sessionId, messageId: message.id, role: message.role, hidden: message.hidden });

  // Only handle if for current session
  if (!state.currentSession || state.currentSession.id !== parseInt(sessionId, 10))
    return;

  const session = getCurrentSessionMessages();
  if (!session) return;

  // Check if message already exists by ID
  const existing = session.findById(message.id);
  if (existing) {
    debug('App', 'Message already exists by ID, updating', { id: message.id });
    session.update(message.id, message);
    renderMessages();
    scrollToBottom();
    return;
  }

  // For user messages, check if we have an optimistic version (no ID, same content)
  if (message.role === 'user') {
    const optimistic = session.find(
      (m) => m.optimistic && m.role === 'user' && m.content === message.content
    );
    if (optimistic) {
      debug('App', 'Found optimistic user message, replacing', { content: message.content.slice(0, 50) });
      session.confirmOptimistic(optimistic.id, message);
      renderMessages();
      scrollToBottom();
      return;
    }
  }

  // For assistant messages, check if we're currently streaming and this is the finalized version
  if (message.role === 'assistant' && state.streamingMessage) {
    debug('App', 'Assistant message received while streaming, will be handled by finalize');
    // Don't add here - the streaming finalization will handle it
    return;
  }

  debug('App', 'Adding new message to state', { id: message.id, role: message.role });
  session.add(message);

  // Re-render messages
  renderMessages();
  scrollToBottom();
}

function handleAbilityApprovalRequest(message) {
  let { executionId, sessionId, abilityName, description, params, dangerLevel, messageId } = message;

  // Only handle if for current session
  if (state.currentSession?.id !== sessionId)
    return;

  // Store in pending approvals
  state.pendingApprovals[executionId] = {
    executionId,
    abilityName,
    description,
    params,
    dangerLevel,
    messageId,
    status: 'pending',
  };

  // Append approval UI to the message or to the messages container
  let approvalHtml = renderAbilityApproval(state.pendingApprovals[executionId]);

  if (messageId) {
    let messageEl = document.querySelector(`[data-message-id="${messageId}"] .message-bubble`);
    if (messageEl)
      messageEl.insertAdjacentHTML('beforeend', approvalHtml);
    else
      elements.messagesContainer.insertAdjacentHTML('beforeend', approvalHtml);
  } else {
    elements.messagesContainer.insertAdjacentHTML('beforeend', approvalHtml);
  }

  scrollToBottom();
}

function handleAbilityApprovalTimeout(message) {
  let { executionId } = message;

  if (state.pendingApprovals[executionId]) {
    state.pendingApprovals[executionId].status = 'denied';
    updateAbilityApprovalUI(executionId);
  }
}

function handleAbilityQuestionRequest(message) {
  let { questionId, sessionId, prompt, type, options, defaultValue, timeout, messageId } = message;

  // Only handle if for current session
  if (state.currentSession?.id !== sessionId)
    return;

  // Store in pending questions
  state.pendingAbilityQs[questionId] = {
    questionId,
    prompt,
    type,
    options,
    defaultValue,
    timeout,
    messageId,
    status: 'pending',
  };

  // Append question UI
  let questionHtml = renderAbilityQuestion(state.pendingAbilityQs[questionId]);

  if (messageId) {
    let messageEl = document.querySelector(`[data-message-id="${messageId}"] .message-bubble`);
    if (messageEl)
      messageEl.insertAdjacentHTML('beforeend', questionHtml);
    else
      elements.messagesContainer.insertAdjacentHTML('beforeend', questionHtml);
  } else {
    elements.messagesContainer.insertAdjacentHTML('beforeend', questionHtml);
  }

  scrollToBottom();
}

function handleAbilityQuestionTimeout(message) {
  let { questionId, defaultValue } = message;

  if (state.pendingAbilityQs[questionId]) {
    state.pendingAbilityQs[questionId].status = 'answered';
    state.pendingAbilityQs[questionId].answer = defaultValue;
    updateAbilityQuestionUI(questionId);
  }
}

function handleAssertionNew(message) {
  let { messageId, assertion } = message;

  if (!state.assertions[messageId])
    state.assertions[messageId] = [];

  state.assertions[messageId].push(assertion);
  updateAssertionUI(messageId, assertion.id);
}

function handleAssertionUpdate(message) {
  let { messageId, assertionId, status, preview, result } = message;

  if (!state.assertions[messageId])
    return;

  let assertion = state.assertions[messageId].find((a) => a.id === assertionId);
  if (!assertion)
    return;

  if (status !== undefined)
    assertion.status = status;

  if (preview !== undefined)
    assertion.preview = preview;

  if (result !== undefined)
    assertion.result = result;

  updateAssertionUI(messageId, assertionId);
}

function handleQuestionPrompt(message) {
  let { messageId, assertionId, question, options, mode, timeout } = message;
  mode = mode || 'demand';

  if (!state.assertions[messageId])
    state.assertions[messageId] = [];

  // Find or create the question assertion
  let assertion = state.assertions[messageId].find((a) => a.id === assertionId);
  if (!assertion) {
    assertion = {
      id:        assertionId,
      assertion: 'question',
      name:      'ask_user',
      message:   question,
      options:   options || [],
      mode:      mode,
      timeout:   timeout || 0,
      default:   message.default,
      status:    'waiting',
    };
    state.assertions[messageId].push(assertion);
  } else {
    assertion.message = question;
    assertion.options = options || [];
    assertion.mode    = mode;
    assertion.timeout = timeout || 0;
    assertion.default = message.default;
    assertion.status  = 'waiting';
  }

  // Track demand questions for main input targeting
  if (mode === 'demand') {
    state.activeDemandQuestion = { messageId, assertionId };
  }

  updateAssertionUI(messageId, assertionId);
  scrollToBottom();

  // Focus the question input for demand questions
  if (mode === 'demand') {
    setTimeout(() => {
      let input = document.querySelector(`.question-input[data-assertion-id="${assertionId}"]`);
      if (input)
        input.focus();
    }, 100);
  }
}

function handleMessageAppend(message) {
  let { messageId, content } = message;

  const session = getCurrentSessionMessages();
  if (!session) return;

  // Find the message in SessionStore
  let foundMessage = session.findById(messageId);
  if (!foundMessage) return;

  // Append content using updateContent
  session.updateContent(messageId, (existingContent) => existingContent + content);

  // Re-fetch the updated message for DOM update
  foundMessage = session.findById(messageId);

  // Update the message in the DOM
  let messageElement = document.querySelector(`[data-message-id="${messageId}"] .message-content`);
  if (messageElement) {
    const textContent = (typeof foundMessage.content === 'string')
      ? foundMessage.content
      : foundMessage.content.find((b) => b.type === 'text')?.text || '';
    messageElement.textContent = textContent;
  }
}

function handleElementNew(message) {
  let { messageId, element } = message;

  if (!state.assertions[messageId])
    state.assertions[messageId] = [];

  // Elements are stored as assertions
  state.assertions[messageId].push(element);
  updateAssertionUI(messageId, element.id);
}

function handleElementUpdate(message) {
  let { messageId, elementId, updates } = message;

  if (!state.assertions[messageId])
    return;

  let element = state.assertions[messageId].find((a) => a.id === elementId);
  if (!element)
    return;

  // Apply updates
  Object.assign(element, updates);
  updateAssertionUI(messageId, elementId);
}

function handleTodoItemUpdate(message) {
  let { messageId, elementId, itemId, status } = message;

  if (!state.assertions[messageId])
    return;

  let todoElement = state.assertions[messageId].find((a) => a.id === elementId);
  if (!todoElement || !todoElement.items)
    return;

  let item = todoElement.items.find((i) => i.id === itemId);
  if (item) {
    item.status = status;
    updateAssertionUI(messageId, elementId);
  }
}

function updateAssertionUI(messageId, assertionId) {
  // Find the message element
  let msgEl = document.querySelector(`[data-message-id="${messageId}"]`);
  if (!msgEl)
    return;

  let bubble = msgEl.querySelector('.message-bubble');
  if (!bubble)
    return;

  // Find or create the assertion element
  let assertionEl = bubble.querySelector(`[data-assertion-id="${assertionId}"]`);
  let assertion   = state.assertions[messageId]?.find((a) => a.id === assertionId);

  if (!assertion)
    return;

  let newHtml = renderAssertionBlock(assertion);

  if (assertionEl) {
    assertionEl.outerHTML = newHtml;
  } else {
    bubble.insertAdjacentHTML('beforeend', newHtml);
  }

  // Re-attach event listeners for questions
  attachQuestionListeners(messageId, assertionId);
}

function attachQuestionListeners(messageId, assertionId) {
  // Option buttons
  document.querySelectorAll(`.question-option[data-assertion-id="${assertionId}"]`).forEach((button) => {
    button.onclick = () => submitQuestionAnswer(assertionId, button.dataset.answer);
  });

  // Submit button
  let submitButton = document.querySelector(`.question-submit[data-assertion-id="${assertionId}"]`);
  if (submitButton) {
    submitButton.onclick = () => {
      let input = document.querySelector(`.question-input[data-assertion-id="${assertionId}"]`);
      if (input && input.value.trim())
        submitQuestionAnswer(assertionId, input.value.trim());
    };
  }

  // Enter key on input
  let input = document.querySelector(`.question-input[data-assertion-id="${assertionId}"]`);
  if (input) {
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        e.preventDefault();
        submitQuestionAnswer(assertionId, input.value.trim());
      }
    };
  }
}

function submitQuestionAnswer(assertionId, answer) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type:        'question_answer',
      assertionId: assertionId,
      answer:      answer,
    }));
  }

  // Update the local assertion state
  for (let msgId in state.assertions) {
    let assertion = state.assertions[msgId].find((a) => a.id === assertionId);
    if (assertion) {
      assertion.status = 'completed';
      assertion.answer = answer;
      updateAssertionUI(msgId, assertionId);

      // Clear active demand question if this was it
      if (state.activeDemandQuestion?.assertionId === assertionId)
        state.activeDemandQuestion = null;

      break;
    }
  }
}

/**
 * Submit an answer to a user_prompt element.
 * Creates a new user message with the answer and an interaction to update the prompt.
 */
function submitUserPromptAnswer(messageId, promptId, question, answer) {
  console.log('[App] submitUserPromptAnswer called:', { messageId, promptId, question, answer });

  // Update the message content in SessionStore so re-renders preserve the answered state
  updatePromptInState(messageId, promptId, answer);

  // Create message content with interaction
  let interactionPayload = {
    interaction_id:  `prompt-response-${promptId}`,
    target_id:       '@system',
    target_property: 'update_prompt',
    payload: {
      message_id: messageId,
      prompt_id:  promptId,
      answer:     answer,
      question:   question,
    },
  };

  let content = `Answering "${question}":\n\n${answer}\n\n<interaction>\n${JSON.stringify(interactionPayload, null, 2)}\n</interaction>`;

  console.log('[App] Sending message with interaction:', content);

  // Send as new user message
  if (state.streamingMode) {
    processMessageStream(content);
  } else {
    processMessage(content);
  }
}

/**
 * Update a prompt's answered state in SessionStore so re-renders preserve it.
 * Uses SessionStore.answerPrompt() which handles:
 * - ID coercion (string/number)
 * - Content format (string/array)
 * - XML escaping
 * - Prompt pattern matching
 */
function updatePromptInState(messageId, promptId, answer) {
  console.log('[App] updatePromptInState:', { messageId, promptId, answer });

  const session = getCurrentSessionMessages();
  if (!session) {
    console.log('[App] No active session');
    return;
  }

  const success = session.answerPrompt(messageId, promptId, answer);

  if (success) {
    console.log('[App] Updated prompt in SessionStore');
  } else {
    console.log('[App] Failed to update prompt - message or prompt not found');
  }
}

// Make submitUserPromptAnswer available globally (called from markup.js)
window.submitUserPromptAnswer = submitUserPromptAnswer;

// ============================================================================
// Prompt Batch Submission System
// ============================================================================
// Prompts are buffered per message frame. Users can:
// S3 Form Model: Every message with prompts is a FORM.
// 1. User fills in prompts (answers buffered, NOT individually submitted)
// 2. "Submit" batch-sends all answered prompts for a message
// 3. "Ignore" dismisses all unanswered prompts for a message

// Buffer: messageId → Map<promptId, { question, answer, type }>
const _pendingPromptAnswers = new Map();
const _submittedPrompts = new Set();

/**
 * Buffer a prompt answer for batch submission.
 * @param {string} messageId
 * @param {string} promptId
 * @param {string} question
 * @param {string} answer
 * @param {string} type
 */
function bufferPromptAnswer(messageId, promptId, question, answer, type) {
  if (!_pendingPromptAnswers.has(messageId))
    _pendingPromptAnswers.set(messageId, new Map());

  _pendingPromptAnswers.get(messageId).set(promptId, { question, answer, type });

  // Dispatch event so hero-chat can update Submit/Ignore button state
  document.dispatchEvent(new CustomEvent('prompt-answer-buffered', {
    detail: { messageId, promptId, pendingCount: _pendingPromptAnswers.get(messageId).size },
  }));
}

/**
 * Collect answers from prompt elements that haven't been buffered yet.
 * Reads getCurrentAnswer() from each unanswered hml-prompt in the message.
 * @param {string} messageId
 */
function _collectUnbufferedAnswers(messageId) {
  let messageEl = document.querySelector(`[data-message-id="${messageId}"]`) ||
                  document.querySelector(`[data-frame-id="${messageId}"]`);
  if (!messageEl) return;

  // Also check shadow DOMs (hero-chat renders in shadow DOM)
  let chatEl = document.querySelector('hero-chat');
  if (chatEl && chatEl.shadowRoot) {
    messageEl = chatEl.shadowRoot.querySelector(`[data-message-id="${messageId}"]`) ||
                chatEl.shadowRoot.querySelector(`[data-frame-id="${messageId}"]`) ||
                messageEl;
  }

  let prompts = messageEl.querySelectorAll('hml-prompt');
  for (let prompt of prompts) {
    if (prompt.isAnswered) continue;

    let answer = (typeof prompt.getCurrentAnswer === 'function') ? prompt.getCurrentAnswer() : null;
    if (!answer) continue;

    let promptId = prompt.promptId;
    let key = `${messageId}-${promptId}`;
    if (_submittedPrompts.has(key)) continue;

    bufferPromptAnswer(messageId, promptId, prompt.question, answer, prompt.promptType);
  }
}

/**
 * Submit all buffered prompt answers for a message as a batch.
 * Sends a single message with multiple interaction blocks.
 * @param {string} messageId
 */
function submitPromptBatch(messageId) {
  // Collect any answers from prompt elements that haven't been buffered yet
  // (e.g., user typed but didn't press Enter)
  _collectUnbufferedAnswers(messageId);

  let answers = _pendingPromptAnswers.get(messageId);
  if (!answers || answers.size === 0)
    return;

  // Build interaction blocks for all answers
  let interactions = [];
  let summaryParts = [];

  for (let [promptId, data] of answers) {
    let key = `${messageId}-${promptId}`;
    if (_submittedPrompts.has(key))
      continue;

    _submittedPrompts.add(key);

    // Update state
    updatePromptInState(messageId, promptId, data.answer);

    interactions.push({
      interaction_id:  `prompt-response-${promptId}`,
      target_id:       '@system',
      target_property: 'update_prompt',
      payload: {
        message_id: messageId,
        prompt_id:  promptId,
        answer:     data.answer,
        question:   data.question,
      },
    });

    summaryParts.push(`"${data.question}": ${data.answer}`);
  }

  if (interactions.length === 0)
    return;

  // Build single message with all interaction blocks
  let interactionBlocks = interactions.map((interaction) =>
    `<interaction>\n${JSON.stringify(interaction, null, 2)}\n</interaction>`
  ).join('\n\n');

  let content = `Answering ${interactions.length} prompt${(interactions.length > 1) ? 's' : ''}:\n\n${summaryParts.join('\n')}\n\n${interactionBlocks}`;

  console.log('[App] Batch submitting prompts:', { messageId, count: interactions.length });

  // Clear buffer
  _pendingPromptAnswers.delete(messageId);

  // Mark prompt elements as answered visually
  _markPromptsAnswered(messageId, answers);

  // Send as user message
  if (state.streamingMode)
    processMessageStream(content);
  else
    processMessage(content);

  // Notify UI
  document.dispatchEvent(new CustomEvent('prompt-batch-submitted', {
    detail: { messageId, count: interactions.length },
  }));
}

/**
 * Mark prompt elements as visually answered after batch submission.
 * @param {string} messageId
 * @param {Map} answers - Map of promptId → { question, answer, type }
 */
function _markPromptsAnswered(messageId, answers) {
  let messageEl = null;

  // Check shadow DOM first (hero-chat renders in shadow DOM)
  let chatEl = document.querySelector('hero-chat');
  if (chatEl && chatEl.shadowRoot) {
    messageEl = chatEl.shadowRoot.querySelector(`[data-message-id="${messageId}"]`) ||
                chatEl.shadowRoot.querySelector(`[data-frame-id="${messageId}"]`);
  }

  if (!messageEl) {
    messageEl = document.querySelector(`[data-message-id="${messageId}"]`) ||
                document.querySelector(`[data-frame-id="${messageId}"]`);
  }

  if (!messageEl) return;

  let prompts = messageEl.querySelectorAll('hml-prompt');
  for (let prompt of prompts) {
    let data = answers.get(prompt.promptId);
    if (data && typeof prompt.markAnswered === 'function') {
      prompt.markAnswered(data.answer);
    }
  }
}

/**
 * Ignore all prompts for a message.
 * Sends a refusal frame to the server so the agent knows the user declined.
 * @param {string} messageId
 */
function ignorePromptBatch(messageId) {
  // Mark all prompts as submitted so they can't be resubmitted
  let answers = _pendingPromptAnswers.get(messageId);
  if (answers) {
    for (let [promptId] of answers) {
      _submittedPrompts.add(`${messageId}-${promptId}`);
    }
  }

  // Also mark any unbuffered prompts as submitted
  _collectUnbufferedPromptIds(messageId);

  _pendingPromptAnswers.delete(messageId);

  console.log('[App] Ignoring prompts for message:', messageId);

  // Send refusal to server so agent knows user declined
  let interactionPayload = {
    interaction_id:  `prompt-ignore-${messageId}`,
    target_id:       '@system',
    target_property: 'ignore_prompts',
    payload: {
      message_id: messageId,
      action:     'ignored',
    },
  };

  let content = `[User declined to answer prompts]\n\n<interaction>\n${JSON.stringify(interactionPayload, null, 2)}\n</interaction>`;

  if (state.streamingMode)
    processMessageStream(content);
  else
    processMessage(content);

  // Notify UI
  document.dispatchEvent(new CustomEvent('prompt-batch-ignored', {
    detail: { messageId },
  }));
}

/**
 * Mark all unbuffered prompt IDs in a message as submitted.
 * Used by ignorePromptBatch to prevent re-submission.
 * @param {string} messageId
 */
function _collectUnbufferedPromptIds(messageId) {
  let messageEl = document.querySelector(`[data-message-id="${messageId}"]`) ||
                  document.querySelector(`[data-frame-id="${messageId}"]`);

  let chatEl = document.querySelector('hero-chat');
  if (chatEl && chatEl.shadowRoot) {
    messageEl = chatEl.shadowRoot.querySelector(`[data-message-id="${messageId}"]`) ||
                chatEl.shadowRoot.querySelector(`[data-frame-id="${messageId}"]`) ||
                messageEl;
  }

  if (!messageEl) return;

  let prompts = messageEl.querySelectorAll('hml-prompt');
  for (let prompt of prompts) {
    if (prompt.isAnswered) continue;
    let key = `${messageId}-${prompt.promptId}`;
    _submittedPrompts.add(key);
  }
}

/**
 * Get pending prompt count for a message.
 * @param {string} messageId
 * @returns {number}
 */
function getPendingPromptCount(messageId) {
  let answers = _pendingPromptAnswers.get(messageId);
  return (answers) ? answers.size : 0;
}

// Expose globally
window.submitPromptBatch   = submitPromptBatch;
window.ignorePromptBatch   = ignorePromptBatch;
window.bufferPromptAnswer  = bufferPromptAnswer;
window.getPendingPromptCount = getPendingPromptCount;

// Listen for prompt-answer-ready events from <hml-prompt> Web Components.
// S3: All prompts are forms — answers are buffered, not individually submitted.
// Submission happens only via the message-level Submit button (submitPromptBatch).
document.addEventListener('prompt-answer-ready', (event) => {
  let { messageId, promptId, question, answer, type } = event.detail;
  if (!messageId || !promptId) return;

  // Deduplicate
  let key = `${messageId}-${promptId}`;
  if (_submittedPrompts.has(key)) return;

  bufferPromptAnswer(messageId, promptId, question, answer, type);
});

// Note: prompt-submit event is no longer dispatched (S3: per-prompt submit removed).
// All submission happens through the message-level Submit button (submitPromptBatch).

function updateOperationState(command) {
  let index = state.runningOperations.findIndex((op) => op.id === command.id);

  if (index >= 0) {
    if (command.status === 'completed' || command.status === 'failed' || command.status === 'aborted') {
      // Remove completed operations after a delay
      state.runningOperations[index] = command;
      renderOperationsPanel();

      setTimeout(() => {
        state.runningOperations = state.runningOperations.filter((op) => op.id !== command.id);
        renderOperationsPanel();
      }, 3000);
    } else {
      state.runningOperations[index] = command;
      renderOperationsPanel();
    }
  } else if (command.status === 'pending' || command.status === 'running') {
    state.runningOperations.push(command);
    renderOperationsPanel();
  }
}

function abortOperation(commandId) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'abort', commandId: commandId }));
  }
}

function renderOperationsPanel() {
  if (state.runningOperations.length === 0) {
    elements.operationsPanel.style.display = 'none';
    return;
  }

  elements.operationsPanel.style.display = 'block';

  let html = state.runningOperations.map((op) => `
    <div class="operation-item">
      <div class="operation-info">
        <div class="operation-command">${escapeHtml(op.command)}</div>
        <div class="operation-status ${op.status}">${op.status}</div>
      </div>
      ${(op.status === 'pending' || op.status === 'running')
        ? `<button class="button operation-abort" onclick="abortOperation('${op.id}')">Abort</button>`
        : ''}
    </div>
  `).join('');

  elements.operationsList.innerHTML = html;
}

// ============================================================================
// Abilities
// ============================================================================

async function loadAbilities() {
  try {
    let data = await fetchAbilities();
    state.abilities.system = data.system || [];
    state.abilities.user   = data.user || [];
  } catch (error) {
    console.error('Failed to load abilities:', error);
  }
}

// Note: Modal functions (showAbilitiesModal, showAgentsModal, etc.) have been moved to hero-modal-* components

// ============================================================================
// Event Listeners
// ============================================================================

// Login — hero-login component dispatches hero:authenticated on success
document.addEventListener('hero:authenticated', () => navigate('/'));

// Operations panel toggle
elements.toggleOperations.addEventListener('click', () => {
  let list = elements.operationsList;

  if (list.style.display === 'none') {
    list.style.display = 'block';
    elements.toggleOperations.innerHTML = '&#8722;';
  } else {
    list.style.display = 'none';
    elements.toggleOperations.innerHTML = '+';
  }
});

// Browser navigation
window.addEventListener('popstate', handleRoute);

// ============================================================================
// Component Events (hero-header, etc.)
// ============================================================================

// Handle navigate events from components
document.addEventListener('navigate', (e) => {
  let path = e.detail?.path;
  if (path) {
    window.history.pushState({}, '', BASE_PATH + path);
    handleRoute();
  }
});

// Handle logout events from components
document.addEventListener('logout', () => {
  handleLogout();
});

// Note: show-modal events are now handled by hero-modal-* components directly
// They listen for 'show-modal' and open themselves based on event.detail.modal

// Handle clear-messages events from components
document.addEventListener('clear-messages', () => {
  handleClearMessages();
});

// Handle toggle-hidden events from components
document.addEventListener('toggle-hidden', (e) => {
  state.showHiddenMessages = e.detail?.show ?? false;
  renderMessages();
});

// Handle send events from hero-input
document.addEventListener('hero:send-message', async (e) => {
  let { content, files, streaming, sessionId } = e.detail || {};
  if (content && sessionId) {
    // Upload files first if any
    if (files && files.length > 0) {
      try {
        let uploadResult = await API.uploads.upload(sessionId, files);
        if (uploadResult.uploads && uploadResult.uploads.length > 0) {
          let fileRefs = uploadResult.uploads
            .map((u) => `[${u.originalName}](${u.url})`)
            .join(' ');
          content = content + '\n\n' + fileRefs;
        }
      } catch (err) {
        console.error('File upload failed:', err.message);
      }
    }

    // Call the existing sendMessage logic
    let inputEl = document.querySelector('hero-input');
    await handleSendMessageContent(content, streaming);
    if (inputEl) inputEl.loading = false;
  }
});

// Note: Commands are now handled server-side via the message POST endpoint.
// The hero:command event is no longer used - commands are sent as regular messages
// and the server intercepts them before involving the AI agent.

// Handle clear events from hero-input
document.addEventListener('hero:clear', () => {
  handleClearMessages();
});

// ============================================================================
// Initialize
// ============================================================================

handleRoute();
