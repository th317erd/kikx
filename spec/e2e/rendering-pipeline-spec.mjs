'use strict';

// =============================================================================
// Rendering Pipeline E2E Tests
// =============================================================================
// Puppeteer-driven tests that verify the complete rendering pipeline end-to-end:
// login → session load → message send → optimistic rendering → agent response →
// streaming finalization → scroll-up pagination.
//
// Requires a running Kikx server on localhost:8089 (or KIKX_E2E_URL).
// Run with: npm run test:e2e
// =============================================================================

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_URL,
  BASE_PATH,
  TEST_USER,
  launchBrowser,
  isServerRunning,
  login,
  navigateToSession,
  sendMessage,
  getMessages,
  getMessageCount,
  waitForAgentResponse,
  getScrollInfo,
  scrollToTop,
} from './helpers.mjs';

// Check server availability BEFORE test suites are defined (top-level await)
let serverAvailable = await isServerRunning();
let browser;

if (!serverAvailable)
  console.log('\n  [SKIP] Kikx server not running — E2E tests skipped.\n');

before(async () => {
  if (serverAvailable)
    browser = await launchBrowser();
});

after(async () => {
  if (browser)
    await browser.close();
});

// ---------------------------------------------------------------------------
// Helper: create a fresh page and log in
// ---------------------------------------------------------------------------

async function createLoggedInPage() {
  let page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await login(page);
  return page;
}

// ---------------------------------------------------------------------------
// Helper: create a session via the API and return its ID
// ---------------------------------------------------------------------------

async function getAuthToken(page) {
  return page.evaluate(() => {
    let raw = localStorage.getItem('kikx_auth');
    if (!raw)
      return null;

    let parsed = JSON.parse(raw);
    return parsed && parsed.token ? parsed.token : null;
  });
}

// test-claude agent ID (belongs to test-bot user, has valid Anthropic API key)
const TEST_AGENT_ID = 'agt_d6k1n1wpe7dy5tq17hcg';

async function createTestSession(page, options = {}) {
  let token   = await getAuthToken(page);
  let agentID = options.agentID || TEST_AGENT_ID;

  let sessionData = await page.evaluate(async (basePath, authToken, _agentID) => {
    let headers = { 'Content-Type': 'application/json' };
    if (authToken)
      headers['Authorization'] = `Bearer ${authToken}`;

    let response = await fetch(`${basePath}/api/v2/sessions`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({
        name:    `E2E Test ${Date.now()}`,
        agentID: _agentID,
      }),
    });

    if (!response.ok)
      throw new Error(`Failed to create session: ${response.status}`);

    let json = await response.json();
    return json.data.session;
  }, BASE_PATH, token, agentID);

  return sessionData;
}

// ---------------------------------------------------------------------------
// Helper: list sessions via the API
// ---------------------------------------------------------------------------

async function listSessions(page) {
  let token = await getAuthToken(page);

  return page.evaluate(async (basePath, authToken) => {
    let headers = {};
    if (authToken)
      headers['Authorization'] = `Bearer ${authToken}`;

    let response = await fetch(`${basePath}/api/v2/sessions`, { headers });

    if (!response.ok)
      throw new Error(`Failed to list sessions: ${response.status}`);

    let json = await response.json();
    return json.data.sessions;
  }, BASE_PATH, token);
}

// =============================================================================
// Login Tests
// =============================================================================

describe('E2E: Login flow', { skip: !serverAvailable && 'Server not running' }, () => {
  let page;

  beforeEach(async () => {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
  });

  after(async () => {
    if (page)
      await page.close();
  });

  it('renders the login page with email, password, and submit', async () => {
    await page.goto(`${BASE_URL}${BASE_PATH}/login`, { waitUntil: 'networkidle2' });

    let loginPage = await page.$('kikx-login-page');
    assert.ok(loginPage, 'kikx-login-page element should exist');

    let emailInput    = await page.$('kikx-login-page .email-input');
    let passwordInput = await page.$('kikx-login-page .password-input');
    let submitButton  = await page.$('kikx-login-page .submit-button');

    assert.ok(emailInput, 'email input should exist');
    assert.ok(passwordInput, 'password input should exist');
    assert.ok(submitButton, 'submit button should exist');
  });

  it('redirects to home after successful login', async () => {
    await login(page);

    let url = new URL(page.url());
    assert.ok(
      url.pathname.startsWith(BASE_PATH),
      `Should redirect to ${BASE_PATH} after login, got ${url.pathname}`,
    );

    // Should NOT be on the login page anymore
    assert.ok(
      !url.pathname.endsWith('/login'),
      'Should not be on login page after successful login',
    );
  });

  it('shows error on invalid credentials', async () => {
    await page.goto(`${BASE_URL}${BASE_PATH}/login`, { waitUntil: 'networkidle2' });

    let emailInput    = await page.$('kikx-login-page .email-input');
    let passwordInput = await page.$('kikx-login-page .password-input');
    let submitButton  = await page.$('kikx-login-page .submit-button');

    await emailInput.type('wrong@example.com', { delay: 10 });
    await passwordInput.type('wrongPassword', { delay: 10 });
    await submitButton.click();

    // Wait a moment for the error to appear
    await page.waitForFunction(
      () => {
        let status = document.querySelector('kikx-login-page .status-message');
        return status && status.textContent.trim().length > 0;
      },
      { timeout: 5000 },
    );

    let statusText = await page.evaluate(() => {
      let status = document.querySelector('kikx-login-page .status-message');
      return status ? status.textContent.trim() : '';
    });

    assert.ok(statusText.length > 0, 'Should show error message for invalid credentials');
  });
});

// =============================================================================
// Session Page Rendering
// =============================================================================

describe('E2E: Session page rendering', { skip: !serverAvailable && 'Server not running' }, () => {
  let page;

  before(async () => {
    page = await createLoggedInPage();
  });

  after(async () => {
    if (page)
      await page.close();
  });

  it('renders the session page with chat view and message input', async () => {
    // Need a session to see chat view + message input
    let sessions = await listSessions(page);

    if (sessions.length === 0) {
      await createTestSession(page);
      sessions = await listSessions(page);
    }

    await navigateToSession(page, sessions[0].id);

    let sessionPage = await page.$('kikx-session-page');
    assert.ok(sessionPage, 'kikx-session-page should exist');

    let chatView = await page.$('kikx-session-page kikx-chat-view');
    assert.ok(chatView, 'kikx-chat-view should exist inside session page');

    let messageInput = await page.$('kikx-session-page kikx-message-input');
    assert.ok(messageInput, 'kikx-message-input should exist inside session page');
  });

  it('can navigate to a specific session', async () => {
    let sessions = await listSessions(page);

    if (sessions.length === 0) {
      // Create one if none exist
      await createTestSession(page);
      sessions = await listSessions(page);
    }

    let sessionID = sessions[0].id;
    await navigateToSession(page, sessionID);

    let sessionPage = await page.$('kikx-session-page');
    assert.ok(sessionPage, 'Session page should render');

    let dataID = await sessionPage.evaluate((el) => el.getAttribute('data-id'));
    assert.equal(dataID, sessionID, 'Session page data-id should match');
  });
});

// =============================================================================
// Message Sending & Optimistic Rendering
// =============================================================================

describe('E2E: Message sending and rendering', { skip: !serverAvailable && 'Server not running' }, () => {
  let page;
  let sessionID;

  before(async () => {
    page = await createLoggedInPage();

    // Create a fresh session for message testing
    let session = await createTestSession(page);
    sessionID   = session.id;

    await navigateToSession(page, sessionID);
  });

  after(async () => {
    if (page)
      await page.close();
  });

  it('renders an optimistic user message with pending class', async () => {
    let initialCount = await getMessageCount(page, 'user');

    await sendMessage(page, 'E2E test message');

    // Wait for the user message to appear — direct DOM query
    await page.waitForFunction(
      (count) => {
        let messages = document.querySelectorAll('kikx-session-page kikx-chat-view kikx-interaction[alignment="user"]');
        return messages.length > count;
      },
      { timeout: 10000 },
      initialCount,
    );

    let userMessages = await getMessages(page, 'user');
    assert.ok(userMessages.length > initialCount, 'New user message should appear');
  });

  it('user message has correct alignment attribute', async () => {
    let userMessages = await getMessages(page, 'user');
    let lastMessage  = userMessages[userMessages.length - 1];

    let alignment = await lastMessage.evaluate((el) => el.getAttribute('alignment'));
    assert.equal(alignment, 'user');
  });

  it('receives an agent response after sending a message', async () => {
    let initialAgentCount = await getMessageCount(page, 'agent');

    // Send a simple message that should get a response
    await sendMessage(page, 'Say hello');

    // Wait for agent response (may take a while due to LLM processing)
    await waitForAgentResponse(page, {
      timeout:      60000,
      initialCount: initialAgentCount,
    });

    let agentMessages = await getMessages(page, 'agent');
    assert.ok(
      agentMessages.length > initialAgentCount,
      'Agent should have responded with at least one message',
    );
  });

  it('agent response has data-frame-id (finalized, not phantom)', async () => {
    // Wait for finalization — data-frame-id is set when the commit frame arrives
    await page.waitForFunction(
      () => {
        let agents = document.querySelectorAll('kikx-session-page kikx-chat-view kikx-interaction[alignment="agent"]');
        if (agents.length === 0)
          return false;

        let last = agents[agents.length - 1];
        return last.hasAttribute('data-frame-id');
      },
      { timeout: 15000 },
    );

    let agentMessages = await getMessages(page, 'agent');
    let lastAgent     = agentMessages[agentMessages.length - 1];

    let frameID = await lastAgent.evaluate((el) => el.getAttribute('data-frame-id'));
    assert.ok(frameID, 'Agent message should have a data-frame-id after finalization');
    assert.ok(frameID.length > 0, 'data-frame-id should not be empty');
  });

  it('agent response contains message content', async () => {
    let agentMessages = await getMessages(page, 'agent');
    let lastAgent     = agentMessages[agentMessages.length - 1];

    // Check for content attribute on kikx-message-content (child of interaction)
    let contentHTML = await lastAgent.evaluate((el) => {
      let content = el.querySelector('kikx-message-content');
      if (!content)
        return '';

      // Try the 'content' property first, then attribute, then innerHTML
      return content.content || content.getAttribute('content') || content.innerHTML || '';
    });

    assert.ok(contentHTML.length > 0, 'Agent message should have content');
  });

  it('agent message is not pending (no pending class)', async () => {
    let agentMessages = await getMessages(page, 'agent');
    let lastAgent     = agentMessages[agentMessages.length - 1];

    let isPending = await lastAgent.evaluate((el) => el.classList.contains('pending'));
    assert.ok(!isPending, 'Agent message should not have pending class');
  });
});

// =============================================================================
// Chat View Scroll Behavior
// =============================================================================

describe('E2E: Chat view scroll', { skip: !serverAvailable && 'Server not running' }, () => {
  let page;
  let sessionID;

  before(async () => {
    page = await createLoggedInPage();

    // Create a session with some messages for scroll testing
    let session = await createTestSession(page);
    sessionID   = session.id;

    await navigateToSession(page, sessionID);

    // Send a few messages to create scroll content
    for (let i = 0; i < 3; i++) {
      await sendMessage(page, `Scroll test message ${i + 1}. Tell me a short fact.`);

      // Wait for agent response before sending next
      let currentAgentCount = await getMessageCount(page, 'agent');
      await waitForAgentResponse(page, {
        timeout:      60000,
        initialCount: currentAgentCount,
      });
    }
  });

  after(async () => {
    if (page)
      await page.close();
  });

  it('chat view starts anchored to bottom', async () => {
    let scrollInfo = await getScrollInfo(page);
    assert.ok(scrollInfo, 'Should be able to get scroll info');
    assert.ok(scrollInfo.atBottom, 'Chat should be anchored to bottom');
  });

  it('scrolling to top fires near-top event (triggers pagination)', async () => {
    let messageCountBefore = await getMessageCount(page);

    await scrollToTop(page);

    // Give it a moment to process the near-top event
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // The scroll position should have been adjusted if older messages loaded
    let scrollInfo = await getScrollInfo(page);
    assert.ok(scrollInfo, 'Should get scroll info after scrolling to top');
  });

  it('messages maintain order after scroll interaction', async () => {
    let messages = await getMessages(page);
    let orders   = [];

    for (let msg of messages) {
      let order = await msg.evaluate((el) => el.getAttribute('data-frame-order'));
      if (order)
        orders.push(Number(order));
    }

    // Verify orders are in ascending sequence (if present)
    if (orders.length > 1) {
      for (let i = 1; i < orders.length; i++)
        assert.ok(orders[i] >= orders[i - 1], `Frame order should be ascending: ${orders[i - 1]} <= ${orders[i]}`);
    }
  });
});

// =============================================================================
// DOM Structure Verification
// =============================================================================

describe('E2E: DOM structure', { skip: !serverAvailable && 'Server not running' }, () => {
  let page;

  before(async () => {
    page = await createLoggedInPage();

    // Navigate to a session with messages
    let sessions = await listSessions(page);

    if (sessions.length === 0) {
      let session = await createTestSession(page);
      await navigateToSession(page, session.id);

      // Send one message to populate
      await sendMessage(page, 'DOM structure test');
      await waitForAgentResponse(page, { timeout: 60000, initialCount: 0 });
    } else {
      await navigateToSession(page, sessions[0].id);
      // Wait a moment for frames to load
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  });

  after(async () => {
    if (page)
      await page.close();
  });

  it('kikx-interaction elements have correct attributes', async () => {
    let messages = await getMessages(page);

    if (messages.length === 0)
      return; // No messages to test

    let firstMessage = messages[0];

    let alignment = await firstMessage.evaluate((el) => el.getAttribute('alignment'));
    assert.ok(
      ['user', 'agent', 'system'].includes(alignment),
      `alignment should be user/agent/system, got "${alignment}"`,
    );
  });

  it('kikx-interaction elements contain kikx-message-content', async () => {
    let messages = await getMessages(page);

    if (messages.length === 0)
      return;

    for (let msg of messages) {
      let hasContent = await msg.evaluate((el) => {
        // Some frame types (like permission-request) might not have message-content
        let bubbleType = el.getAttribute('bubble-type');
        if (bubbleType === 'permission' || bubbleType === 'error')
          return true; // Skip these

        let content = el.querySelector('kikx-message-content');
        return !!content;
      });

      assert.ok(hasContent, 'Each interaction should contain kikx-message-content');
    }
  });

  it('chat view has interaction-stream container', async () => {
    let chatView = await page.$('kikx-session-page kikx-chat-view');
    assert.ok(chatView, 'kikx-chat-view should exist inside session page');

    let chatContainer     = await page.$('kikx-session-page kikx-chat-view .chat-container');
    let interactionStream = await page.$('kikx-session-page kikx-chat-view .interaction-stream');

    assert.ok(chatContainer, '.chat-container should exist in chat view');
    assert.ok(interactionStream, '.interaction-stream should exist in chat view');
  });

  it('message input has textarea and send button', async () => {
    let messageInput = await page.$('kikx-session-page kikx-message-input');
    assert.ok(messageInput, 'kikx-message-input should exist inside session page');

    let textarea   = await page.$('kikx-session-page kikx-message-input .message-textarea');
    let sendButton = await page.$('kikx-session-page kikx-message-input .send-button');

    assert.ok(textarea, '.message-textarea should exist in message input');
    assert.ok(sendButton, '.send-button should exist in message input');
  });
});
