'use strict';

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

import { findChromeExecutable } from '../../stagehand/stagehand-test-utils.mjs';

const SPIKE_DIR = path.dirname(fileURLToPath(import.meta.url));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function startStaticServer(root) {
  let server = http.createServer(async (request, response) => {
    let url = new URL(request.url, 'http://localhost');
    let filePath = path.join(root, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));

    if (!filePath.startsWith(root)) {
      response.writeHead(403).end('forbidden');
      return;
    }

    try {
      let body = await fs.readFile(filePath);
      response.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
      response.end(body);
    } catch (_error) {
      response.writeHead(404).end('not found');
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      let address = server.address();
      resolve({
        server,
        baseURL: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function measureMode(page, baseURL, mode, { cards = 30, hz = 10, heavy = false, warmupMs = 1500, measureMs = 4000 } = {}) {
  let url = `${baseURL}/?mode=${mode}&cards=${cards}&hz=${hz}${heavy ? '&heavy=1' : ''}`;
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 15000,
  });
  await page.waitForFunction('globalThis.__spike && document.querySelectorAll(".spike-grid > *").length > 0', { timeout: 15000 });
  await new Promise((resolve) => setTimeout(resolve, warmupMs));
  await page.evaluate(() => globalThis.__spike.reset());
  await new Promise((resolve) => setTimeout(resolve, measureMs));
  return await page.evaluate(() => globalThis.__spike.snapshot());
}

test('P0 spike measures canvas vs HTML mini-card performance at 30 synchronized cards', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Spike benchmark requires Chrome');
    return;
  }

  let fixture = await startStaticServer(SPIKE_DIR);
  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });

    let scenarios = [
      { label: 'canvas / light', mode: 'canvas', heavy: false },
      { label: 'html / light', mode: 'html', heavy: false },
      { label: 'canvas / heavy', mode: 'canvas', heavy: true },
      { label: 'html / heavy', mode: 'html', heavy: true },
    ];

    let results = [];
    console.log('\n=== P0 canvas-vs-html spike (30 synchronized-updating cards, 10Hz) ===');
    for (let scenario of scenarios) {
      let snapshot = await measureMode(page, fixture.baseURL, scenario.mode, { heavy: scenario.heavy });
      results.push({ label: scenario.label, ...snapshot });
      console.log(
        `${scenario.label.padEnd(16)} ` +
        `work avg ${snapshot.averageWorkMs.toFixed(2)}ms p95 ${snapshot.p95WorkMs.toFixed(2)}ms | ` +
        `layout p95 ${snapshot.p95LayoutMs.toFixed(2)}ms | ` +
        `loaf avg ${snapshot.loafAvgMs.toFixed(2)}ms max ${snapshot.loafMaxMs.toFixed(2)}ms (n=${snapshot.loafCount})`,
      );
    }
    console.log('=======================================================================\n');

    await fs.writeFile(
      path.join(SPIKE_DIR, 'spike-results.json'),
      JSON.stringify({ results, capturedAt: new Date().toISOString() }, null, 2),
    );

    for (let result of results) {
      assert.equal(result.cards, 30);
      assert.ok(result.workSamples > 0, `${result.label} produced work samples`);
    }
  } finally {
    await browser.close().catch(() => {});
    await closeServer(fixture.server).catch(() => {});
  }
});
