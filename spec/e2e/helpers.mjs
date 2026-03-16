'use strict';

// ---------------------------------------------------------------------------
// E2E Test Helpers — Puppeteer utilities for Kikx browser testing
// ---------------------------------------------------------------------------

import puppeteer from 'puppeteer';

// Allow self-signed certificates in Node.js fetch (for server availability check)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

export const BASE_URL  = process.env.KIKX_E2E_URL || 'https://wyatt-desktop.mythix.info';
export const BASE_PATH = '/kikx';

export const TEST_USER = {
  email:    'test-bot@kikx.com',
  password: 'securePass123',
};

// ---------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------

export async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args:     [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--ignore-certificate-errors',
    ],
  });
}

// ---------------------------------------------------------------------------
// Server availability check
// ---------------------------------------------------------------------------

export async function isServerRunning() {
  try {
    // Disable TLS verification for self-signed certs in dev
    let response = await fetch(`${BASE_URL}${BASE_PATH}/login`, {
      signal: AbortSignal.timeout(5000),
    });

    return response.ok || response.status === 304;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shadow DOM helpers
//
// Puppeteer can pierce shadow DOM with `>>>` selector in newer versions,
// but for reliability we use evaluateHandle to get shadow roots explicitly.
// ---------------------------------------------------------------------------

export async function getShadowRoot(elementHandle) {
  return elementHandle.evaluateHandle((el) => el.shadowRoot);
}

export async function shadowQuery(page, hostSelector, innerSelector) {
  let host = await page.$(hostSelector);
  if (!host)
    return null;

  let shadow = await getShadowRoot(host);
  return shadow.$(innerSelector);
}

export async function shadowQueryAll(page, hostSelector, innerSelector) {
  let host = await page.$(hostSelector);
  if (!host)
    return [];

  let shadow = await getShadowRoot(host);
  return shadow.$$(innerSelector);
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

export async function login(page, options = {}) {
  let email    = options.email || TEST_USER.email;
  let password = options.password || TEST_USER.password;

  await page.goto(`${BASE_URL}${BASE_PATH}/login`, { waitUntil: 'networkidle2' });

  // Get login page shadow root
  let loginPage = await page.$('kikx-login-page');
  if (!loginPage)
    throw new Error('kikx-login-page element not found');

  let shadow = await getShadowRoot(loginPage);

  // Fill email
  let emailInput = await shadow.$('.email-input');
  if (!emailInput)
    throw new Error('.email-input not found in login page shadow DOM');

  await emailInput.click({ clickCount: 3 }); // Select all existing text
  await emailInput.type(email, { delay: 20 });

  // Fill password
  let passwordInput = await shadow.$('.password-input');
  if (!passwordInput)
    throw new Error('.password-input not found in login page shadow DOM');

  await passwordInput.click({ clickCount: 3 });
  await passwordInput.type(password, { delay: 20 });

  // Submit
  let submitButton = await shadow.$('.submit-button');
  if (!submitButton)
    throw new Error('.submit-button not found in login page shadow DOM');

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }),
    submitButton.click(),
  ]);
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

export async function navigateToSession(page, sessionID) {
  await page.goto(
    `${BASE_URL}${BASE_PATH}/sessions/${sessionID}`,
    { waitUntil: 'networkidle2' },
  );

  await page.waitForSelector('kikx-session-page', { timeout: 5000 });
}

// ---------------------------------------------------------------------------
// Session page shadow DOM access
//
// kikx-chat-view, kikx-message-input, and kikx-interaction elements
// are all inside kikx-session-page's shadow DOM.
// ---------------------------------------------------------------------------

export async function getSessionPageShadow(page) {
  let sessionPage = await page.$('kikx-session-page');
  if (!sessionPage)
    return null;

  return getShadowRoot(sessionPage);
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

export async function sendMessage(page, text) {
  let sessionShadow = await getSessionPageShadow(page);
  if (!sessionShadow)
    throw new Error('kikx-session-page not found');

  let msgInput = await sessionShadow.$('kikx-message-input');
  if (!msgInput)
    throw new Error('kikx-message-input not found in session page shadow DOM');

  let inputShadow = await getShadowRoot(msgInput);

  let textarea = await inputShadow.$('.message-textarea');
  if (!textarea)
    throw new Error('.message-textarea not found in message input shadow DOM');

  await textarea.click();
  await textarea.type(text, { delay: 15 });

  // Press Enter to send (not Shift+Enter)
  await textarea.press('Enter');
}

export async function getMessages(page, alignment) {
  let sessionShadow = await getSessionPageShadow(page);
  if (!sessionShadow)
    return [];

  let chatView = await sessionShadow.$('kikx-chat-view');
  if (!chatView)
    return [];

  // Interactions are appended to .interaction-stream inside chat view's shadow DOM
  let chatShadow = await getShadowRoot(chatView);

  let selector = (alignment)
    ? `kikx-interaction[alignment="${alignment}"]`
    : 'kikx-interaction';

  return chatShadow.$$(selector);
}

export async function getMessageCount(page, alignment) {
  let messages = await getMessages(page, alignment);
  return messages.length;
}

export async function waitForAgentResponse(page, options = {}) {
  let timeout      = options.timeout || 30000;
  let initialCount = options.initialCount || 0;

  // Wait for a new agent message to appear — must traverse two shadow DOMs:
  // session-page shadow → kikx-chat-view → chat-view shadow → kikx-interaction
  await page.waitForFunction(
    (count) => {
      let sessionPage = document.querySelector('kikx-session-page');
      if (!sessionPage || !sessionPage.shadowRoot)
        return false;

      let chatView = sessionPage.shadowRoot.querySelector('kikx-chat-view');
      if (!chatView || !chatView.shadowRoot)
        return false;

      let messages = chatView.shadowRoot.querySelectorAll('kikx-interaction[alignment="agent"]');
      return messages.length > count;
    },
    { timeout },
    initialCount,
  );
}

// ---------------------------------------------------------------------------
// Scroll helpers
// ---------------------------------------------------------------------------

export async function getScrollInfo(page) {
  let sessionShadow = await getSessionPageShadow(page);
  if (!sessionShadow)
    return null;

  let chatView = await sessionShadow.$('kikx-chat-view');
  if (!chatView)
    return null;

  let chatShadow = await getShadowRoot(chatView);
  let container   = await chatShadow.$('.chat-container');
  if (!container)
    return null;

  return container.evaluate((el) => ({
    scrollTop:    el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    atTop:        el.scrollTop <= 50,
    atBottom:     (el.scrollHeight - el.scrollTop - el.clientHeight) <= 50,
  }));
}

export async function scrollToTop(page) {
  let sessionShadow = await getSessionPageShadow(page);
  if (!sessionShadow)
    throw new Error('kikx-session-page not found');

  let chatView = await sessionShadow.$('kikx-chat-view');
  if (!chatView)
    throw new Error('kikx-chat-view not found');

  let chatShadow = await getShadowRoot(chatView);
  let container   = await chatShadow.$('.chat-container');

  await container.evaluate((el) => {
    el.scrollTop = 0;
  });
}
