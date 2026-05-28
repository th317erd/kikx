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
// Login flow
// ---------------------------------------------------------------------------

export async function login(page, options = {}) {
  let email    = options.email || TEST_USER.email;
  let password = options.password || TEST_USER.password;

  await page.goto(`${BASE_URL}${BASE_PATH}/login`, { waitUntil: 'networkidle2' });

  // Get login page element
  let loginPage = await page.$('kikx-login-page');
  if (!loginPage)
    throw new Error('kikx-login-page element not found');

  // Fill email
  let emailInput = await page.$('kikx-login-page .email-input');
  if (!emailInput)
    throw new Error('.email-input not found in login page');

  await emailInput.click({ clickCount: 3 }); // Select all existing text
  await emailInput.type(email, { delay: 20 });

  // Fill password
  let passwordInput = await page.$('kikx-login-page .password-input');
  if (!passwordInput)
    throw new Error('.password-input not found in login page');

  await passwordInput.click({ clickCount: 3 });
  await passwordInput.type(password, { delay: 20 });

  // Submit
  let submitButton = await page.$('kikx-login-page .submit-button');
  if (!submitButton)
    throw new Error('.submit-button not found in login page');

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
// Message helpers
// ---------------------------------------------------------------------------

export async function sendMessage(page, text) {
  let textarea = await page.$('kikx-session-page kikx-message-input .message-textarea');
  if (!textarea)
    throw new Error('.message-textarea not found in message input');

  await textarea.click();
  await textarea.type(text, { delay: 15 });

  // Press Enter to send (not Shift+Enter)
  await textarea.press('Enter');
}

export async function getMessages(page, alignment) {
  let selector = (alignment)
    ? `kikx-session-page kikx-chat-view kikx-interaction[alignment="${alignment}"]`
    : 'kikx-session-page kikx-chat-view kikx-interaction';

  return page.$$(selector);
}

export async function getMessageCount(page, alignment) {
  let messages = await getMessages(page, alignment);
  return messages.length;
}

export async function waitForAgentResponse(page, options = {}) {
  let timeout      = options.timeout || 30000;
  let initialCount = options.initialCount || 0;

  // Wait for a new agent message to appear — direct DOM query (no shadow DOM)
  await page.waitForFunction(
    (count) => {
      let messages = document.querySelectorAll('kikx-session-page kikx-chat-view kikx-interaction[alignment="agent"]');
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
  let container = await page.$('kikx-session-page kikx-chat-view .chat-container');
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
  let container = await page.$('kikx-session-page kikx-chat-view .chat-container');
  if (!container)
    throw new Error('.chat-container not found in chat view');

  await container.evaluate((el) => {
    el.scrollTop = 0;
  });
}
