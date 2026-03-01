'use strict';

// ============================================================================
// API Functions
// ============================================================================

/**
 * Base API request function.
 */
async function api(method, path, body) {
  let options = {
    method:      method,
    credentials: 'same-origin',
    headers:     {},
  };

  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response = await fetch(`api${path}`, options);
  let data     = await response.json();

  if (!response.ok)
    throw new Error(data.error || 'Request failed');

  return data;
}

// ============================================================================
// API Namespace
// ============================================================================

/**
 * Organized API namespace for cleaner code.
 *
 * Usage:
 *   await API.sessions.list()
 *   await API.sessions.archive(sessionId)
 *   await API.agents.list()
 */
const API = {
  // --------------------------------------------------------------------------
  // Auth
  // --------------------------------------------------------------------------
  auth: {
    login:  (username, password) => api('POST', '/login', { username, password }),
    logout: () => api('POST', '/logout'),
    me:     () => api('GET', '/me'),
  },

  // --------------------------------------------------------------------------
  // Sessions
  // --------------------------------------------------------------------------
  sessions: {
    list: async (options = {}) => {
      let params = new URLSearchParams();
      if (options.showHidden) params.append('showHidden', '1');
      if (options.search) params.append('search', options.search);
      let queryString = params.toString();
      let path = (queryString) ? `/sessions?${queryString}` : '/sessions';
      let data = await api('GET', path);
      return data.sessions;
    },

    get:     (id) => api('GET', `/sessions/${id}`),
    create:  (name, agentId, systemPrompt) => {
      // Support both single agentId and agentIds array
      let body = { name, systemPrompt };
      if (Array.isArray(agentId))
        body.agentIds = agentId;
      else
        body.agentId = agentId;
      return api('POST', '/sessions', body);
    },
    update:  (id, updates) => api('PUT', `/sessions/${id}`, updates),
    delete:  (id) => api('DELETE', `/sessions/${id}`),
    archive: (id) => api('POST', `/sessions/${id}/archive`),
    unarchive: (id) => api('POST', `/sessions/${id}/unarchive`),
    setStatus: (id, status) => api('PUT', `/sessions/${id}/status`, { status }),
  },

  // --------------------------------------------------------------------------
  // Messages
  // --------------------------------------------------------------------------
  messages: {
    list:   (sessionId) => api('GET', `/sessions/${sessionId}/messages`),
    send:   (sessionId, content) => api('POST', `/sessions/${sessionId}/messages`, { content }),
    clear:  (sessionId) => api('DELETE', `/sessions/${sessionId}/messages`),
    // stream is handled separately due to its complexity
  },

  // --------------------------------------------------------------------------
  // Agents
  // --------------------------------------------------------------------------
  agents: {
    list: async () => {
      let data = await api('GET', '/agents');
      return data.agents;
    },
    get:       (id) => api('GET', `/agents/${id}`),
    create:    (name, type, apiKey, apiUrl, defaultAbilities, config) =>
      api('POST', '/agents', { name, type, apiKey, apiUrl, defaultAbilities, config }),
    update:    (id, updates) => api('PUT', `/agents/${id}`, updates),
    delete:    (id) => api('DELETE', `/agents/${id}`),
    getConfig: async (id) => {
      let data = await api('GET', `/agents/${id}/config`);
      return data.config;
    },
    updateConfig: (id, config) => api('PUT', `/agents/${id}/config`, { config }),
  },

  // --------------------------------------------------------------------------
  // Abilities
  // --------------------------------------------------------------------------
  abilities: {
    list: async () => {
      let data = await api('GET', '/abilities');
      let system = data.abilities.filter((a) => a.source === 'system' || a.source === 'builtin');
      let user = data.abilities.filter((a) => a.source === 'user');
      return { system, user, all: data.abilities };
    },
    get:    (id) => api('GET', `/abilities/${id}`),
    create: (data) => {
      let { name, category, description, applies, content } = data;
      return api('POST', '/abilities', { name, category, description, applies, content, type: 'process' });
    },
    update: (id, data) => {
      let { name, category, description, applies, content } = data;
      return api('PUT', `/abilities/${id}`, { name, category, description, applies, content });
    },
    delete: (id) => api('DELETE', `/abilities/${id}`),
  },

  // --------------------------------------------------------------------------
  // Usage / Billing
  // --------------------------------------------------------------------------
  usage: {
    global:     () => api('GET', '/usage'),
    session:    (sessionId) => api('GET', `/usage/session/${sessionId}`),
    charge:     (data) => api('POST', '/usage/charge', data),
    correction: (data) => api('POST', '/usage/correction', data),
  },

  // --------------------------------------------------------------------------
  // Frames (Interaction Frames System)
  // --------------------------------------------------------------------------
  frames: {
    /**
     * List frames for a session.
     * @param {number} sessionId - Session ID
     * @param {object} [options] - Query options
     * @param {string} [options.fromTimestamp] - Get frames after this timestamp
     * @param {string} [options.before] - Get frames before this timestamp (backward pagination)
     * @param {boolean} [options.fromCompact] - Start from most recent compact frame
     * @param {string[]} [options.types] - Filter by frame types
     * @param {number} [options.limit] - Maximum frames to return
     * @returns {Promise<{frames: object[], count: number, hasMore: boolean}>}
     */
    list: async (sessionId, options = {}) => {
      let params = new URLSearchParams();
      if (options.fromTimestamp) params.append('fromTimestamp', options.fromTimestamp);
      if (options.before) params.append('before', options.before);
      if (options.fromCompact) params.append('fromCompact', '1');
      if (options.types) params.append('types', options.types.join(','));
      if (options.limit) params.append('limit', String(options.limit));
      let queryString = params.toString();
      let path = (queryString)
        ? `/sessions/${sessionId}/frames?${queryString}`
        : `/sessions/${sessionId}/frames`;
      return api('GET', path);
    },

    /**
     * Get a single frame by ID.
     * @param {number} sessionId - Session ID
     * @param {string} frameId - Frame ID
     * @returns {Promise<object>}
     */
    get: (sessionId, frameId) => api('GET', `/sessions/${sessionId}/frames/${frameId}`),

    /**
     * Get frame statistics for a session.
     * @param {number} sessionId - Session ID
     * @returns {Promise<object>}
     */
    stats: (sessionId) => api('GET', `/sessions/${sessionId}/frames/stats`),
  },

  // --------------------------------------------------------------------------
  // Search
  // --------------------------------------------------------------------------
  search: {
    /**
     * Search frame content across sessions.
     * @param {string} query - Search text
     * @param {object} [options] - Search options
     * @param {number} [options.sessionId] - Limit to specific session
     * @param {string[]} [options.types] - Frame types to search
     * @param {number} [options.limit] - Max results
     * @param {number} [options.offset] - Pagination offset
     * @returns {Promise<{results: object[], total: number, hasMore: boolean}>}
     */
    frames: async (query, options = {}) => {
      let params = new URLSearchParams();
      params.append('query', query);
      if (options.sessionId) params.append('sessionId', String(options.sessionId));
      if (options.types) params.append('types', options.types.join(','));
      if (options.limit) params.append('limit', String(options.limit));
      if (options.offset) params.append('offset', String(options.offset));
      return api('GET', `/search?${params.toString()}`);
    },
  },

  // --------------------------------------------------------------------------
  // Uploads
  // --------------------------------------------------------------------------
  uploads: {
    /**
     * Upload files to a session.
     * @param {number} sessionId - Session ID
     * @param {File[]} files - Files to upload
     * @returns {Promise<{uploads: object[]}>}
     */
    upload: async (sessionId, files) => {
      let formData = new FormData();
      for (let file of files) {
        formData.append('files', file);
      }

      let basePath = window.__BASE_PATH || '/kikx/';
      let response = await fetch(`${basePath}api/sessions/${sessionId}/uploads`, {
        method:      'POST',
        body:        formData,
        credentials: 'same-origin',
      });

      if (!response.ok) {
        let error = await response.json().catch(() => ({ error: 'Upload failed' }));
        throw new Error(error.error || 'Upload failed');
      }

      return response.json();
    },

    /**
     * List uploads for a session.
     * @param {number} sessionId - Session ID
     * @returns {Promise<{uploads: object[]}>}
     */
    list: async (sessionId) => {
      return api('GET', `/sessions/${sessionId}/uploads`);
    },

    /**
     * Delete an upload.
     * @param {number} uploadId - Upload ID
     * @returns {Promise<{success: boolean}>}
     */
    delete: async (uploadId) => {
      return api('DELETE', `/uploads/${uploadId}`);
    },
  },

  // --------------------------------------------------------------------------
  // User Profile & Settings
  // --------------------------------------------------------------------------
  user: {
    /**
     * Get current user's profile.
     * @returns {Promise<object>} Profile with displayName, email, usage stats
     */
    profile: () => api('GET', '/users/me/profile'),

    /**
     * Update current user's profile.
     * @param {object} data - { displayName, email }
     * @returns {Promise<object>}
     */
    updateProfile: (data) => api('PUT', '/users/me/profile', data),

    /**
     * Change current user's password.
     * @param {object} data - { currentPassword, newPassword }
     * @returns {Promise<object>}
     */
    changePassword: (data) => api('PUT', '/users/me/password', data),

    /**
     * List current user's API keys (no plaintext).
     * @returns {Promise<{apiKeys: object[]}>}
     */
    apiKeys: () => api('GET', '/users/me/api-keys'),

    /**
     * Create a new API key. Returns plaintext once.
     * @param {object} data - { name, scopes?, expiresInDays? }
     * @returns {Promise<{key: string, id: number, name: string}>}
     */
    createApiKey: (data) => api('POST', '/users/me/api-keys', data),

    /**
     * Revoke an API key.
     * @param {number} id - API key ID
     * @returns {Promise<{success: boolean}>}
     */
    revokeApiKey: (id) => api('DELETE', `/users/me/api-keys/${id}`),
  },
};

// Make API available globally
window.API = API;

async function login(username, password) {
  let result = await api('POST', '/login', { username, password });

  // Save token to localStorage for WebSocket authentication
  if (result && result.token) {
    localStorage.setItem('token', result.token);
  }

  return result;
}

async function logout() {
  // Clear token from localStorage
  localStorage.removeItem('token');
  return await api('POST', '/logout');
}

async function fetchMe() {
  return await api('GET', '/me');
}

async function fetchSessions(options = {}) {
  let params = new URLSearchParams();

  if (options.showHidden || state.showHidden)
    params.append('showHidden', '1');

  if (options.search)
    params.append('search', options.search);

  let queryString = params.toString();
  let path        = (queryString) ? `/sessions?${queryString}` : '/sessions';
  let data        = await api('GET', path);

  return data.sessions;
}

async function fetchSession(id) {
  return await api('GET', `/sessions/${id}`);
}

async function createSession(name, agentId, systemPrompt) {
  // Support both single agentId and agentIds array
  let body = { name, systemPrompt };
  if (Array.isArray(agentId))
    body.agentIds = agentId;
  else
    body.agentId = agentId;
  return await api('POST', '/sessions', body);
}

async function sendMessage(sessionId, content) {
  return await api('POST', `/sessions/${sessionId}/messages`, { content });
}

/**
 * Send a message with streaming response via SSE.
 *
 * @param {number} sessionId - Session ID
 * @param {string} content - Message content
 * @param {object} callbacks - Event callbacks
 * @returns {Promise<object>} Final response
 */
async function sendMessageStream(sessionId, content, callbacks = {}) {
  debug('API', 'sendMessageStream called', { sessionId, contentLength: content.length });

  return new Promise((resolve, reject) => {
    let url = `${BASE_PATH}/api/sessions/${sessionId}/messages/stream`;
    debug('API', 'Fetching stream URL:', url);

    fetch(url, {
      method:      'POST',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ content }),
      credentials: 'same-origin',
    }).then(async (response) => {
      debug('API', 'Stream response received', {
        status:      response.status,
        ok:          response.ok,
        headers:     Object.fromEntries(response.headers.entries()),
        bodyUsed:    response.bodyUsed,
        redirected:  response.redirected,
      });

      if (!response.ok) {
        let error = await response.json().catch(() => ({ error: 'Stream failed' }));
        debug('API', 'Stream error response:', error);
        reject(new Error(error.error || 'Stream failed'));
        return;
      }

      // Check if this is a command response (JSON) vs streaming response (SSE)
      let contentType = response.headers.get('Content-Type') || '';
      if (contentType.includes('application/json')) {
        // Command response - parse JSON and call appropriate callback
        let commandResult = await response.json();
        debug('API', 'Command response received:', commandResult);

        // Call the command callback if provided
        if (callbacks.onCommand) {
          callbacks.onCommand(commandResult);
        }

        // Resolve with command result
        resolve({
          isCommand: true,
          ...commandResult,
        });
        return;
      }

      let reader      = response.body.getReader();
      let decoder     = new TextDecoder();
      let buffer      = '';
      let fullContent = '';
      let messageId   = null;
      let chunkCount  = 0;
      let eventCount  = 0;
      let eventType   = null;  // Persist across chunks for multi-chunk events
      let eventData   = null;

      debug('API', 'Starting to read stream...');

      try {
        while (true) {
          let readResult;
          try {
            readResult = await reader.read();
          } catch (readError) {
            debug('API', 'reader.read() threw error:', readError.message);
            throw readError;
          }

          let { done, value } = readResult;

          if (done) {
            debug('API', 'Stream done', { chunkCount, eventCount, fullContentLength: fullContent.length });
            break;
          }

          chunkCount++;
          let chunk = decoder.decode(value, { stream: true });
          debug('API', `Chunk #${chunkCount} received`, { length: chunk.length, preview: chunk.slice(0, 100) });

          buffer += chunk;

          // Parse SSE events from buffer
          let lines = buffer.split('\n');
          buffer    = lines.pop(); // Keep incomplete line in buffer

          for (let line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              eventData = line.slice(6);
            } else if (line === '' && eventType && eventData) {
              // End of event
              eventCount++;
              debug('API', `Event #${eventCount} received:`, eventType);

              try {
                let data = JSON.parse(eventData);
                debug('API', `Event data:`, data);

                // Track message ID
                if (data.messageId)
                  messageId = data.messageId;

                // Call appropriate callback
                switch (eventType) {
                  case 'message_start':
                    debug('API', 'Calling onStart callback');
                    callbacks.onStart?.(data);
                    break;

                  case 'text':
                    fullContent += data.text;
                    debug('API', 'Calling onText callback', { textLength: data.text.length, totalLength: fullContent.length });
                    callbacks.onText?.(data);
                    break;

                  case 'element_start':
                    debug('API', 'Calling onElementStart callback');
                    callbacks.onElementStart?.(data);
                    break;

                  case 'element_update':
                    debug('API', 'Calling onElementUpdate callback');
                    callbacks.onElementUpdate?.(data);
                    break;

                  case 'element_complete':
                    debug('API', 'Calling onElementComplete callback');
                    callbacks.onElementComplete?.(data);
                    break;

                  case 'element_executing':
                    debug('API', 'Calling onElementExecuting callback');
                    callbacks.onElementExecuting?.(data);
                    break;

                  case 'element_result':
                    debug('API', 'Calling onElementResult callback');
                    callbacks.onElementResult?.(data);
                    break;

                  case 'element_error':
                    debug('API', 'Calling onElementError callback');
                    callbacks.onElementError?.(data);
                    break;

                  case 'tool_use_start':
                    debug('API', 'Calling onToolUseStart callback');
                    callbacks.onToolUseStart?.(data);
                    break;

                  case 'tool_result':
                    debug('API', 'Calling onToolResult callback');
                    callbacks.onToolResult?.(data);
                    break;

                  // Interaction events (for <interaction> tag handling)
                  case 'interaction_detected':
                    debug('API', 'Calling onInteractionDetected callback');
                    callbacks.onInteractionDetected?.(data);
                    break;

                  case 'interaction_started':
                    debug('API',' interaction_started event received:', data);
                    debug('API', 'Calling onInteractionStarted callback', data);
                    callbacks.onInteractionStarted?.(data);
                    break;

                  case 'interaction_update':
                    debug('API',' interaction_update event received:', data);
                    debug('API', 'Calling onInteractionUpdate callback', data);
                    callbacks.onInteractionUpdate?.(data);
                    break;

                  case 'interaction_result':
                    debug('API',' interaction_result event received:', {
                      interactionId: data.interactionId,
                      status:        data.status,
                      hasResult:     !!data.result,
                    });
                    debug('API',' callbacks.onInteractionResult exists?', typeof callbacks.onInteractionResult);
                    debug('API', 'Calling onInteractionResult callback');
                    if (callbacks.onInteractionResult) {
                      try {
                        callbacks.onInteractionResult(data);
                        debug('API', 'interaction_result callback completed');
                      } catch (callbackError) {
                        console.error('[API] interaction_result callback threw error:', callbackError);
                      }
                    } else {
                      debug('API',' NO onInteractionResult callback defined!');
                    }
                    break;

                  case 'interaction_continuing':
                    debug('API', 'Calling onInteractionContinuing callback');
                    callbacks.onInteractionContinuing?.(data);
                    break;

                  case 'interaction_complete':
                    debug('API',' interaction_complete event received:', {
                      hasContent:      !!data.content,
                      contentLength:   data.content?.length,
                      contentPreview:  data.content?.slice(0, 100),
                    });
                    debug('API', 'Interaction complete, updating fullContent');
                    // Update the accumulated content with the final clean content
                    if (data.content) {
                      fullContent = data.content;
                    }
                    callbacks.onInteractionComplete?.(data);
                    break;

                  case 'interaction_error':
                    debug('API', 'Calling onInteractionError callback');
                    callbacks.onInteractionError?.(data);
                    break;

                  case 'rate_limit_wait':
                    debug('API', 'Rate limit wait:', data);
                    callbacks.onRateLimitWait?.(data);
                    break;

                  case 'usage':
                    debug('API', 'Token usage:', data);
                    callbacks.onUsage?.(data);
                    break;

                  case 'message_complete':
                    debug('API',' message_complete event received:', {
                      hasContent:      !!data.content,
                      contentLength:   data.content?.length,
                      contentPreview:  data.content?.slice(0, 100),
                    });
                    debug('API', 'Calling onComplete callback');
                    callbacks.onComplete?.(data);
                    break;

                  case 'error':
                    debug('API', 'Stream error event:', data);
                    callbacks.onError?.(data);
                    reject(new Error(data.error));
                    return;

                  default:
                    debug('API', 'Unknown event type:', eventType);
                }
              } catch (e) {
                console.error('Failed to parse SSE event:', e);
                debug('API', 'Parse error:', e.message, 'Raw data:', eventData);
              }

              eventType = null;
              eventData = null;
            }
          }
        }
      } catch (streamError) {
        debug('API', 'Stream processing error:', streamError.message);
        reject(streamError);
        return;
      }

      debug('API', 'Stream complete, resolving', { fullContentLength: fullContent.length, messageId });
      resolve({ content: fullContent, messageId });
    }).catch((error) => {
      debug('API', 'Fetch error:', error.message);
      reject(error);
    });
  });
}

async function clearMessages(sessionId) {
  return await api('DELETE', `/sessions/${sessionId}/messages`);
}

async function fetchAgents() {
  let data = await api('GET', '/agents');
  return data.agents;
}

async function createAgent(name, type, apiKey, apiUrl, defaultAbilities, config) {
  return await api('POST', '/agents', { name, type, apiKey, apiUrl, defaultAbilities, config });
}

async function fetchAbilities() {
  let data   = await api('GET', '/abilities');
  let system = data.abilities.filter((a) => a.source === 'system' || a.source === 'builtin');
  let user   = data.abilities.filter((a) => a.source === 'user');
  return { system, user };
}

async function fetchAbility(id) {
  return await api('GET', `/abilities/${id}`);
}

async function createAbility(data) {
  let { name, category, description, applies, content } = data;
  return await api('POST', '/abilities', { name, category, description, applies, content, type: 'process' });
}

async function updateAbility(id, data) {
  let { name, category, description, applies, content } = data;
  return await api('PUT', `/abilities/${id}`, { name, category, description, applies, content });
}

async function deleteAbility(id) {
  return await api('DELETE', `/abilities/${id}`);
}

async function fetchAgentConfig(id) {
  let data = await api('GET', `/agents/${id}/config`);
  return data.config;
}

async function updateAgentConfig(id, config) {
  return await api('PUT', `/agents/${id}/config`, { config });
}

async function deleteAgent(id) {
  return await api('DELETE', `/agents/${id}`);
}

async function fetchUsage() {
  return await api('GET', '/usage');
}

async function fetchSessionUsage(sessionId) {
  return await api('GET', `/usage/session/${sessionId}`);
}

async function recordCharge(data) {
  return await api('POST', '/usage/charge', data);
}

async function createUsageCorrection(data) {
  return await api('POST', '/usage/correction', data);
}

// ============================================================================
// Session Archive Functions (new)
// ============================================================================

async function archiveSession(id) {
  return await api('POST', `/sessions/${id}/archive`);
}

async function unarchiveSession(id) {
  return await api('POST', `/sessions/${id}/unarchive`);
}

// ============================================================================
// Frame Functions
// ============================================================================

/**
 * Fetch frames for a session.
 * @param {number} sessionId - Session ID
 * @param {object} [options] - Query options
 * @returns {Promise<{frames: object[], count: number, hasMore: boolean}>}
 */
async function fetchFrames(sessionId, options = {}) {
  return await API.frames.list(sessionId, options);
}

/**
 * Fetch a single frame by ID.
 * @param {number} sessionId - Session ID
 * @param {string} frameId - Frame ID
 * @returns {Promise<object>}
 */
async function fetchFrame(sessionId, frameId) {
  return await API.frames.get(sessionId, frameId);
}

/**
 * Convert frames to message-like objects for rendering.
 * This bridges the old message-based UI with the new frame system.
 *
 * @param {object[]} frames - Array of frames
 * @param {object} compiled - Compiled frame payloads
 * @returns {object[]} Array of message-like objects
 */
function framesToMessages(frames, compiled = null) {
  let messages = [];

  for (let frame of frames) {
    // Get the current payload (may be updated by UPDATE frames)
    // Support both Map (from session-frames-provider) and plain object
    let payload;
    if (compiled instanceof Map) {
      payload = compiled.get(frame.id) || frame.payload;
    } else if (compiled && compiled[frame.id]) {
      payload = compiled[frame.id];
    } else {
      payload = frame.payload;
    }

    if (frame.type === 'message') {
      messages.push({
        id:         frame.id,
        role:       payload.role || (frame.authorType === 'user' ? 'user' : 'assistant'),
        content:    payload.content || '',
        hidden:     payload.hidden || false,
        type:       frame.type,
        authorType: frame.authorType,
        timestamp:  frame.timestamp,
        frameId:    frame.id,
      });
    } else if (frame.type === 'request') {
      // Skip permission_request frames — the hml-prompt MESSAGE frame is the UI
      if (payload.action === 'permission_request') continue;

      // Request frames (like websearch) can be rendered as special messages
      messages.push({
        id:         frame.id,
        role:       'assistant',
        content:    '',
        hidden:     false,
        type:       'request',
        action:     payload.action,
        data:       payload,
        authorType: frame.authorType,
        timestamp:  frame.timestamp,
        frameId:    frame.id,
        parentId:   frame.parentId,
      });
    } else if (frame.type === 'result') {
      // Skip permission_response frames — handled internally
      if (payload.action === 'permission_response') continue;

      // Result frames can be nested under their parent request
      messages.push({
        id:         frame.id,
        role:       'system',
        content:    '',
        hidden:     false,
        type:       'result',
        result:     payload,
        authorType: frame.authorType,
        timestamp:  frame.timestamp,
        frameId:    frame.id,
        parentId:   frame.parentId,
      });
    } else if (frame.type === 'compact') {
      // Compact frames render as visible summary dividers
      messages.push({
        id:         frame.id,
        role:       'system',
        context:    payload.context || '',
        hidden:     false,
        type:       'compact',
        authorType: frame.authorType,
        timestamp:  frame.timestamp,
        frameId:    frame.id,
        createdAt:  frame.timestamp,
      });
    }
    // UPDATE frames don't create new messages, they modify existing ones
  }

  return messages;
}

// ============================================================================
// ES Module Exports
// ============================================================================

// ============================================================================
// Global Window Exports
// ============================================================================
// These exports maintain compatibility with existing code that uses window.functionName
// New code should use API.namespace.method() instead

window.archiveSession     = archiveSession;
window.unarchiveSession   = unarchiveSession;
window.fetchSessions      = fetchSessions;
window.fetchSession       = fetchSession;
window.createSession      = createSession;
window.sendMessage        = sendMessage;
window.sendMessageStream  = sendMessageStream;
window.clearMessages      = clearMessages;
window.fetchAgents        = fetchAgents;
window.createAgent        = createAgent;
window.fetchAbilities     = fetchAbilities;
window.fetchAbility       = fetchAbility;
window.createAbility      = createAbility;
window.updateAbility      = updateAbility;
window.deleteAbility      = deleteAbility;
window.fetchAgentConfig   = fetchAgentConfig;
window.updateAgentConfig  = updateAgentConfig;
window.deleteAgent        = deleteAgent;
window.fetchUsage         = fetchUsage;
window.fetchSessionUsage  = fetchSessionUsage;
window.recordCharge       = recordCharge;
window.createUsageCorrection = createUsageCorrection;
window.login              = login;
window.logout             = logout;
window.fetchMe            = fetchMe;
window.fetchFrames        = fetchFrames;
window.fetchFrame         = fetchFrame;
window.framesToMessages   = framesToMessages;
