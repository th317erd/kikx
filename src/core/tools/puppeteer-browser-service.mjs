'use strict';

import puppeteerCore from 'puppeteer-core';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

const DEFAULT_DEBUGGING_URL = 'http://127.0.0.1:9223';
const DEFAULT_VIEWPORT = { width: 1280, height: 900 };

export class PuppeteerBrowserService {
  constructor(options = {}) {
    this.debuggingURL = options.debuggingURL || process.env.KIKX_PUPPETEER_DEBUGGING_URL || DEFAULT_DEBUGGING_URL;
    this.launchOptions = options.launchOptions || {};
    this.defaultViewport = options.defaultViewport || DEFAULT_VIEWPORT;
    this.logger = options.logger || console;
    this.puppeteerCore = options.puppeteerCore || puppeteerCore;
    this.stealthPuppeteer = options.stealthPuppeteer || null;
    this._browser = null;
    this._browserMode = '';
  }

  async withPage(callback) {
    if (typeof callback !== 'function')
      throw new TypeError('withPage() requires a callback');

    let browser = await this.browser();
    let page = await browser.newPage();
    try {
      return await callback(page, {
        browser,
        mode: this._browserMode,
      });
    } finally {
      await closePage(page);
    }
  }

  async browser() {
    if (this._browser?.connected === true || typeof this._browser?.isConnected === 'function' && this._browser.isConnected())
      return this._browser;

    let connectError = null;
    try {
      this._browser = await this.puppeteerCore.connect({
        browserURL: this.debuggingURL,
        defaultViewport: this.defaultViewport,
      });
      this._browserMode = 'cdp';
      this._browser.on?.('disconnected', () => {
        if (this._browserMode === 'cdp')
          this._browser = null;
      });
      return this._browser;
    } catch (error) {
      connectError = error;
    }

    try {
      let puppeteer = this.stealthPuppeteer || createStealthPuppeteer(this.puppeteerCore);
      this._browser = await puppeteer.launch(normalizeLaunchOptions({
        headless: false,
        defaultViewport: this.defaultViewport,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          ...(Array.isArray(this.launchOptions.args) ? this.launchOptions.args : []),
        ],
        ...this.launchOptions,
      }));
      this._browserMode = 'launch';
      this._browser.on?.('disconnected', () => {
        if (this._browserMode === 'launch')
          this._browser = null;
      });
      return this._browser;
    } catch (launchError) {
      throw new Error([
        `Unable to connect to Puppeteer debugging browser at ${this.debuggingURL}: ${connectError?.message || connectError}`,
        `Unable to launch fallback headed Puppeteer browser: ${launchError?.message || launchError}`,
      ].join('\n'));
    }
  }

  async close() {
    let browser = this._browser;
    let mode = this._browserMode;
    this._browser = null;
    this._browserMode = '';

    if (!browser)
      return;

    try {
      if (mode === 'cdp' && typeof browser.disconnect === 'function')
        browser.disconnect();
      else if (typeof browser.close === 'function')
        await browser.close();
      else if (typeof browser.disconnect === 'function')
        browser.disconnect();
    } catch (error) {
      this.logger.warn?.(`Failed to close Puppeteer browser service: ${error.message}`);
    }
  }
}

function createStealthPuppeteer(puppeteerCore) {
  let puppeteer = addExtra(puppeteerCore);
  puppeteer.use(StealthPlugin());
  return puppeteer;
}

function normalizeLaunchOptions(options) {
  let normalized = { ...options };
  if (!normalized.executablePath && process.env.PUPPETEER_EXECUTABLE_PATH)
    normalized.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;

  if (!normalized.executablePath && !normalized.channel)
    normalized.channel = process.env.KIKX_PUPPETEER_CHANNEL || 'chrome';

  return normalized;
}

async function closePage(page) {
  try {
    await page.close?.();
  } catch (_error) {}
}
