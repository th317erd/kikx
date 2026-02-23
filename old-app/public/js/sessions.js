'use strict';

// ============================================================================
// Sessions
// ============================================================================

async function loadSessions() {
  try {
    state.sessions = await fetchSessions();
    state.agents   = await fetchAgents();

    // Only call renderSessionsList if the element exists (legacy support)
    if (elements.sessionsList) {
      renderSessionsList();
    }
  } catch (error) {
    console.error('Failed to load sessions:', error);
    if (elements.sessionsList) {
      elements.sessionsList.innerHTML = '<div class="loading">Failed to load sessions</div>';
    }
  }
}

function renderSessionsList() {
  // Skip if using hero-sidebar component (no legacy element)
  if (!elements.sessionsList) {
    return;
  }

  let filteredSessions = state.sessions;

  if (state.searchQuery) {
    let query = state.searchQuery.toLowerCase();
    filteredSessions = state.sessions.filter((s) =>
      s.name.toLowerCase().includes(query) ||
      (s.preview && s.preview.toLowerCase().includes(query))
    );
  }

  if (filteredSessions.length === 0) {
    if (state.sessions.length === 0 && state.agents.length === 0) {
      elements.sessionsList.innerHTML = `
        <div class="no-sessions">
          <p>No agents configured yet.</p>
          <p><span class="no-agents-link" onclick="document.dispatchEvent(new CustomEvent('show-modal', { detail: { modal: 'new-agent' } }))">Add an Agent</span> to get started.</p>
        </div>
      `;
    } else if (state.sessions.length === 0) {
      elements.sessionsList.innerHTML = `
        <div class="no-sessions">
          <p>No sessions yet.</p>
          <p>Click "New Session" to start chatting with an AI agent.</p>
        </div>
      `;
    } else {
      elements.sessionsList.innerHTML = `
        <div class="no-sessions">
          <p>No sessions match your search.</p>
        </div>
      `;
    }
    return;
  }

  let html = filteredSessions.map((session) => {
    let statusClass = '';
    if (session.status === 'archived')
      statusClass = 'archived';
    else if (session.status === 'agent')
      statusClass = 'agent-session';

    let depthStyle = (session.depth > 0) ? `style="margin-left: ${session.depth * 24}px"` : '';
    let childClass = (session.depth > 0) ? 'child-session' : '';

    let isArchived   = session.status === 'archived';
    let archiveIcon  = (isArchived) ? '♻️' : '🗑️';
    let archiveTitle = (isArchived) ? 'Restore session' : 'Archive session';

    let dateStr  = formatRelativeDate(session.updatedAt);
    let preview  = session.preview || '';
    let msgCount = session.messageCount || 0;
    let msgLabel = (msgCount === 1) ? '1 message' : `${msgCount} messages`;

    let statusBadge = '';
    if (session.status === 'agent')
      statusBadge = '<span class="session-status-badge agent">agent</span>';

    return `
      <div class="session-row ${statusClass} ${childClass}" data-session-id="${session.id}" ${depthStyle}>
        <div class="session-info" onclick="navigateToSession(${session.id})">
          <div class="session-title">${escapeHtml(session.name)}${statusBadge}</div>
          <div class="session-preview">${(preview) ? escapeHtml(preview) : '<span class="no-preview">No messages yet</span>'}</div>
          <div class="session-message-count">${msgLabel}</div>
        </div>
        <div class="session-meta">
          <span class="session-date">${dateStr}</span>
          <span class="session-agent">${escapeHtml(session.agent.name)}</span>
        </div>
        <div class="session-actions">
          <button class="session-archive-button" onclick="toggleSessionArchive(event, ${session.id}, ${isArchived})" title="${archiveTitle}">
            ${archiveIcon}
          </button>
        </div>
      </div>
    `;
  }).join('');

  elements.sessionsList.innerHTML = html;
}

async function toggleSessionArchive(event, sessionId, isArchived) {
  event.stopPropagation();

  try {
    let endpoint = (isArchived) ? 'unarchive' : 'archive';
    await fetch(`${BASE_PATH}/api/sessions/${sessionId}/${endpoint}`, {
      method: 'POST',
    });

    state.sessions = await fetchSessions();
    renderSessionsList();
  } catch (error) {
    console.error('Failed to toggle archive:', error);
  }
}

function navigateToSession(sessionId) {
  navigate(`/sessions/${sessionId}`);
}
