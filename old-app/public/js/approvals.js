'use strict';

// ============================================================================
// Ability Approval UI
// ============================================================================
// Handles the ability approval system, including:
// - Rendering approval request UI
// - Handling approval/denial responses
// - Ability question prompts
// - Message queue processing
//
// Dependencies: state, escapeHtml, forceScrollToBottom, scrollToBottom,
//               sendApprovalResponse, sendAbilityQuestionResponse,
//               processMessage, processMessageStream

function renderAbilityApproval(approval) {
  let { executionId, abilityName, description, params, dangerLevel, status } = approval;

  // If already resolved, show status
  if (status === 'approved') {
    return `
      <div class="approval-request safe" data-execution-id="${escapeHtml(executionId)}">
        <div class="approval-header">
          <span class="approval-icon">✓</span>
          <span class="approval-title">Approved</span>
        </div>
        <div class="approval-body">
          <div class="approval-ability-name">${escapeHtml(abilityName)}</div>
        </div>
      </div>
    `;
  }

  if (status === 'denied') {
    return `
      <div class="approval-request dangerous" data-execution-id="${escapeHtml(executionId)}">
        <div class="approval-header">
          <span class="approval-icon">✕</span>
          <span class="approval-title">Denied</span>
        </div>
        <div class="approval-body">
          <div class="approval-ability-name">${escapeHtml(abilityName)}</div>
        </div>
      </div>
    `;
  }

  // Pending approval request
  let dangerClass = (dangerLevel === 'dangerous') ? 'dangerous' : ((dangerLevel === 'safe') ? 'safe' : '');
  let paramsHtml  = (params) ? `<pre class="approval-params">${escapeHtml(JSON.stringify(params, null, 2))}</pre>` : '';

  return `
    <div class="approval-request ${dangerClass}" data-execution-id="${escapeHtml(executionId)}">
      <div class="approval-header">
        <span class="approval-icon">🔒</span>
        <span class="approval-title">Permission Required</span>
      </div>
      <div class="approval-body">
        <div class="approval-ability-name">${escapeHtml(abilityName)}</div>
        ${(description) ? `<div class="approval-description">${escapeHtml(description)}</div>` : ''}
        ${paramsHtml}
      </div>
      <div class="approval-actions">
        <button class="button-approve" onclick="handleAbilityApprove('${escapeHtml(executionId)}')">
          <span>👍</span> Approve
        </button>
        <button class="button-deny" onclick="handleAbilityDeny('${escapeHtml(executionId)}')">
          <span>👎</span> Deny
        </button>
      </div>
      <label class="approval-remember">
        <input type="checkbox" id="remember-${escapeHtml(executionId)}">
        <span>Remember for this session</span>
      </label>
    </div>
  `;
}

function renderAbilityQuestion(question) {
  let { questionId, prompt, type, options, status, answer, defaultValue, timeout } = question;

  // If already answered, show the answer
  if (status === 'answered' && answer !== undefined) {
    return `
      <div class="ability-question" data-question-id="${escapeHtml(questionId)}">
        <div class="question-header">
          <span class="question-icon">💬</span>
          <span>Question Answered</span>
        </div>
        <div class="question-prompt">${escapeHtml(prompt)}</div>
        <div class="question-answer">Answer: <strong>${escapeHtml(String(answer))}</strong></div>
      </div>
    `;
  }

  // Render based on question type
  let inputHtml = '';

  if (type === 'binary') {
    inputHtml = `
      <div class="question-binary">
        <button class="button-yes" onclick="handleAbilityQuestionAnswer('${escapeHtml(questionId)}', true)">👍</button>
        <button class="button-no" onclick="handleAbilityQuestionAnswer('${escapeHtml(questionId)}', false)">👎</button>
      </div>
    `;
  } else if (type === 'number' || type === 'float') {
    let step = (type === 'float') ? '0.01' : '1';
    inputHtml = `
      <input type="number" step="${step}" class="question-input" id="ability-q-${escapeHtml(questionId)}"
             placeholder="Enter a ${type}..." value="${defaultValue || ''}">
      <button class="button button-primary" onclick="submitAbilityQuestionInput('${escapeHtml(questionId)}', '${type}')">Submit</button>
    `;
  } else if (options && options.length > 0) {
    // Multiple choice
    inputHtml = `
      <div class="question-choices">
        ${options.map((opt) => `
          <button class="question-choice" onclick="handleAbilityQuestionAnswer('${escapeHtml(questionId)}', '${escapeHtml(String(opt))}')">${escapeHtml(String(opt))}</button>
        `).join('')}
      </div>
    `;
  } else {
    // Free-form string
    inputHtml = `
      <input type="text" class="question-input" id="ability-q-${escapeHtml(questionId)}"
             placeholder="Type your answer..." value="${defaultValue || ''}">
      <button class="button button-primary" onclick="submitAbilityQuestionInput('${escapeHtml(questionId)}', 'string')">Submit</button>
    `;
  }

  let timeoutHtml = (timeout) ? `<div class="question-timeout">Timeout: ${Math.round(timeout / 1000)}s</div>` : '';

  return `
    <div class="ability-question" data-question-id="${escapeHtml(questionId)}">
      <div class="question-header">
        <span class="question-icon">❓</span>
        <span>Question</span>
      </div>
      <div class="question-prompt">${escapeHtml(prompt)}</div>
      ${inputHtml}
      ${timeoutHtml}
    </div>
  `;
}

function handleAbilityApprove(executionId) {
  let rememberCheckbox = document.getElementById(`remember-${executionId}`);
  let rememberForSession = rememberCheckbox?.checked || false;

  sendAbilityApprovalResponse(executionId, true, null, rememberForSession);
}

function handleAbilityDeny(executionId) {
  let reason = prompt('Reason for denial (optional):');
  sendAbilityApprovalResponse(executionId, false, reason, false);
}

function sendAbilityApprovalResponse(executionId, approved, reason, rememberForSession) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN)
    return;

  state.ws.send(JSON.stringify({
    type: 'ability_approval_response',
    executionId,
    approved,
    reason,
    rememberForSession,
  }));

  // Update local state
  if (state.pendingApprovals[executionId]) {
    state.pendingApprovals[executionId].status = (approved) ? 'approved' : 'denied';
    updateAbilityApprovalUI(executionId);
  }
}

function handleAbilityQuestionAnswer(questionId, answer) {
  sendAbilityQuestionAnswer(questionId, answer);
}

function submitAbilityQuestionInput(questionId, type) {
  let input = document.getElementById(`ability-q-${questionId}`);
  if (!input)
    return;

  let value = input.value;

  if (type === 'number')
    value = parseInt(value, 10);
  else if (type === 'float')
    value = parseFloat(value);

  sendAbilityQuestionAnswer(questionId, value);
}

function sendAbilityQuestionAnswer(questionId, answer) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN)
    return;

  state.ws.send(JSON.stringify({
    type: 'ability_question_answer',
    questionId,
    answer,
  }));

  // Update local state
  if (state.pendingAbilityQs[questionId]) {
    state.pendingAbilityQs[questionId].status = 'answered';
    state.pendingAbilityQs[questionId].answer = answer;
    updateAbilityQuestionUI(questionId);
  }
}

function updateAbilityApprovalUI(executionId) {
  let approval = state.pendingApprovals[executionId];
  if (!approval)
    return;

  let el = document.querySelector(`[data-execution-id="${executionId}"]`);
  if (el)
    el.outerHTML = renderAbilityApproval(approval);
}

function updateAbilityQuestionUI(questionId) {
  let question = state.pendingAbilityQs[questionId];
  if (!question)
    return;

  let el = document.querySelector(`[data-question-id="${questionId}"]`);
  if (el)
    el.outerHTML = renderAbilityQuestion(question);
}

function renderLinkElement(assertion) {
  let { id, mode, url, messageId, text, label } = assertion;
  let icon = (mode === 'clipboard') ? '📋' : ((mode === 'internal') ? '↓' : '🔗');
  let clickAction = '';

  if (mode === 'external') {
    clickAction = `onclick="window.open('${escapeHtml(url)}', '_blank')"`;
  } else if (mode === 'internal') {
    clickAction = `onclick="scrollToMessage('${escapeHtml(messageId)}')"`;
  } else if (mode === 'clipboard') {
    clickAction = `onclick="copyToClipboard('${escapeHtml(text)}', this)"`;
  }

  return `
    <div class="element-link" data-element-id="${id}">
      <button class="link-button link-${mode}" ${clickAction}>
        <span class="link-icon">${icon}</span>
        <span class="link-label">${escapeHtml(label)}</span>
        ${(mode === 'clipboard') ? '<span class="link-copied" style="display:none">Copied!</span>' : ''}
      </button>
    </div>
  `;
}

function renderTodoElement(assertion) {
  let { id, title, items, collapsed } = assertion;
  items = items || [];

  let completedCount = items.filter((i) => i.status === 'completed').length;
  let totalCount     = items.length;
  let progressPct    = (totalCount > 0) ? Math.round((completedCount / totalCount) * 100) : 0;

  let itemsHtml = items.map((item) => {
    let statusIcon = (item.status === 'completed') ? '✓' : ((item.status === 'in_progress') ? '⏳' : '○');
    return `
      <li class="todo-item ${item.status}" data-item-id="${item.id}">
        <span class="todo-status">${statusIcon}</span>
        <span class="todo-text">${escapeHtml(item.text)}</span>
      </li>
    `;
  }).join('');

  return `
    <div class="element-todo ${(collapsed) ? 'collapsed' : ''}" data-element-id="${id}">
      <div class="todo-header" onclick="toggleTodoCollapse('${id}')">
        <span class="todo-title">${escapeHtml(title || 'Tasks')}</span>
        <span class="todo-progress">${completedCount}/${totalCount}</span>
        <span class="todo-toggle">${(collapsed) ? '▶' : '▼'}</span>
      </div>
      <div class="todo-progress-bar">
        <div class="todo-progress-fill" style="width: ${progressPct}%"></div>
      </div>
      <ul class="todo-items" ${(collapsed) ? 'style="display:none"' : ''}>
        ${itemsHtml}
      </ul>
    </div>
  `;
}

function renderProgressElement(assertion) {
  let { id, percentage, label, status } = assertion;
  percentage = Math.max(0, Math.min(100, Number(percentage) || 0));

  return `
    <div class="element-progress" data-element-id="${id}">
      <div class="progress-header">
        <span class="progress-label">${escapeHtml(label || 'Progress')}</span>
        <span class="progress-percentage">${percentage}%</span>
      </div>
      <div class="progress-bar-container">
        <div class="progress-bar" style="width: ${percentage}%"></div>
      </div>
      ${(status) ? `<div class="progress-status">${escapeHtml(status)}</div>` : ''}
    </div>
  `;
}

// Element interaction helpers
function scrollToMessage(messageId) {
  let msgEl = document.querySelector(`[data-message-id="${messageId}"]`);
  if (msgEl) {
    msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    msgEl.classList.add('highlight');
    setTimeout(() => msgEl.classList.remove('highlight'), 2000);
  }
}

function copyToClipboard(text, buttonEl) {
  navigator.clipboard.writeText(text).then(() => {
    let copiedSpan = buttonEl.querySelector('.link-copied');
    let labelSpan  = buttonEl.querySelector('.link-label');
    if (copiedSpan && labelSpan) {
      labelSpan.style.display  = 'none';
      copiedSpan.style.display = 'inline';
      setTimeout(() => {
        labelSpan.style.display  = 'inline';
        copiedSpan.style.display = 'none';
      }, 1500);
    }
  }).catch((error) => {
    console.error('Failed to copy:', error);
  });
}

function toggleTodoCollapse(elementId) {
  let todoEl = document.querySelector(`[data-element-id="${elementId}"]`);
  if (!todoEl) return;

  let isCollapsed = todoEl.classList.toggle('collapsed');
  let itemsEl     = todoEl.querySelector('.todo-items');
  let toggleEl    = todoEl.querySelector('.todo-toggle');

  if (itemsEl)  itemsEl.style.display  = (isCollapsed) ? 'none' : 'block';
  if (toggleEl) toggleEl.textContent   = (isCollapsed) ? '▶' : '▼';
}

function renderAssertionsForMessage(messageId) {
  let assertions = state.assertions[messageId];
  if (!assertions || assertions.length === 0)
    return '';

  return assertions.map((a) => renderAssertionBlock(a)).join('');
}

/**
 * Scroll to bottom of the chat. Delegates to hero-chat component.
 * Respects user scroll intent — if user scrolled up to read, this is a no-op.
 */
function scrollToBottom() {
  let heroChat = elements.heroChat;
  if (heroChat && typeof heroChat.scrollToBottom === 'function')
    heroChat.scrollToBottom();
}

/**
 * Force scroll to bottom regardless of current position.
 * Resets user scroll intent — use for explicit user actions (send message, etc).
 */
function forceScrollToBottom() {
  let heroChat = elements.heroChat;
  if (heroChat && typeof heroChat.forceScrollToBottom === 'function')
    heroChat.forceScrollToBottom();
}

/**
 * Check if the user is near the bottom of the chat.
 * @returns {boolean} True if within 100px of bottom
 */
function isNearBottom() {
  let heroChat = elements.heroChat;
  if (heroChat && typeof heroChat.isNearBottom === 'function')
    return heroChat.isNearBottom();

  return true;
}

function showTypingIndicator() {
  let indicator = document.createElement('div');
  indicator.className = 'message message-assistant';
  indicator.id = 'typing-indicator';
  indicator.innerHTML = `
    <div class="message-header">Assistant</div>
    <div class="message-bubble">
      <div class="typing-indicator">
        <span></span><span></span><span></span>
      </div>
    </div>
  `;
  elements.messagesContainer.appendChild(indicator);
  scrollToBottom();
}

function hideTypingIndicator() {
  let indicator = document.getElementById('typing-indicator');

  if (indicator)
    indicator.remove();
}

/**
 * Handle sending a message with content already extracted.
 * Used by hero-input component.
 */
async function handleSendMessageContent(content, streaming = true) {
  if (!content || !state.currentSession)
    return;

  // If busy, queue the message instead
  if (state.isLoading) {
    queueMessage(content);
    return;
  }

  // Process the message
  if (streaming)
    await processMessageStream(content);
  else
    await processMessage(content);
}

function queueMessage(content) {
  let queueId = `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Add to queue
  state.messageQueue.push({ id: queueId, content });

  // Add queued message to UI immediately via SessionStore
  const session = getCurrentSessionMessages();
  if (session) {
    session.add({ role: 'user', content, queued: true, queueId });
  }
  renderMessages();
  forceScrollToBottom(); // User just sent a message, always scroll to show it
}

async function processMessage(content) {
  state.isLoading = true;

  const session = getCurrentSessionMessages();

  // Add user message optimistically (if not already in messages from queue)
  let existingQueued = session ? session.find((m) => m.queued && m.content === content) : null;
  if (existingQueued) {
    // Remove queued styling
    session.update(existingQueued.id, { queued: false, queueId: undefined });
    renderMessages();
  } else if (session) {
    session.add({ role: 'user', content: content });
    renderMessages();
  }
  forceScrollToBottom();

  showTypingIndicator();

  try {
    let response = await sendMessage(state.currentSession.id, content);

    hideTypingIndicator();

    if (session)
      session.add({ role: 'assistant', content: response.content });

    renderMessages();
    scrollToBottom();
  } catch (error) {
    hideTypingIndicator();

    if (session) {
      session.add({
        role:    'assistant',
        content: [{ type: 'text', text: `Error: ${error.message}` }],
      });
    }
    renderMessages();
    scrollToBottom();
  }

  state.isLoading = false;

  // Focus input via hero-input component
  let heroInputEl = document.querySelector('hero-input');
  if (heroInputEl && typeof heroInputEl.focus === 'function')
    heroInputEl.focus();

  await processMessageQueue();
}

async function processMessageQueue() {
  if (state.messageQueue.length === 0)
    return;

  // Get next message from queue
  let queued = state.messageQueue.shift();

  // Process it (use streaming or batch based on mode)
  if (state.streamingMode)
    await processMessageStream(queued.content);
  else
    await processMessage(queued.content);
}
