'use strict';

// Real-browser coverage for the pinned thinking rack lifecycle. The rack is a
// projection of runtime events, not the persisted thread: it must clear on
// EndTyping even when a silenced turn emits no final AgentMessage, and it must
// render one brain for one agent even when responses overlap. Frames from other
// sessions must never leak into the selected thread's rack.

import assert from 'node:assert/strict';
import test from 'node:test';

import puppeteer from 'puppeteer-core';

import {
  findChromeExecutable,
  startStagehandUIServer,
} from '../stagehand/stagehand-test-utils.mjs';

test('Puppeteer clears the thinking rack on EndTyping and keeps one brain per agent', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('Puppeteer local smoke requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [
      { id: 'session_1', title: 'Thinking Rack', messageCount: 0 },
      { id: 'session_2', title: 'Other Session', messageCount: 0 },
    ],
  });

  let browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.KIKX_PUPPETEER_HEADLESS === '0' ? false : 'new',
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'puppeteer-test-token', refresh_token: 'puppeteer-test-refresh' }));
    });
    await page.goto(`${fixture.baseURL}/?view=thread`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('kikx-thinking-rack', { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('kikx-app')?._state?.selectedSessionID === 'session_1', { timeout: 10000 });

    let inject = (sessionID, frames) => page.evaluate(({ sessionID, frames }) => {
      let app = document.querySelector('kikx-app');
      for (let frame of frames)
        app._onRuntimeEvent({ data: JSON.stringify({ type: 'frame.phantom', sessionID, frame: { sessionID, ...frame } }) });
    }, { sessionID, frames });

    let snapshot = () => page.evaluate(() => ({
      panels: document.querySelectorAll('kikx-thinking-panel').length,
      brains: document.querySelectorAll('.kikx-thinking-brain').length,
      ids: [ ...document.querySelectorAll('kikx-thinking-panel') ].map((panel) => panel.dataset.thinkingId),
      rackHidden: document.querySelector('kikx-thinking-rack')?.hidden === true,
      animations: [ ...document.querySelectorAll('.kikx-thinking-brain svg') ].map((brain) => getComputedStyle(brain).animationName),
    }));

    let animationProbe = () => page.evaluate(() => {
      let brain = document.querySelector('.kikx-thinking-brain svg');
      let animation = brain?.getAnimations?.()[0] || null;
      let rect = brain?.getBoundingClientRect();
      let style = brain ? getComputedStyle(brain) : null;
      let origin = style?.transformOrigin || '';
      return {
        transformBox: style?.transformBox || '',
        startTime: animation?.startTime ?? null,
        currentTime: animation?.currentTime ?? null,
        origin,
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
      };
    });

    await inject('session_1', [
      { id: 'resp_1:typing', type: 'BeginTyping', phantom: true, responseFrameID: 'resp_1', content: { agentID: 'agent_1', agentName: 'Zav' } },
      { id: 'resp_1:thinking', type: 'AgentThinking', phantom: true, responseFrameID: 'resp_1', content: { text: 'reasoning' } },
      { id: 'resp_1:delta', type: 'AgentMessageDelta', phantom: true, responseFrameID: 'resp_1', content: { text: 'answer' } },
    ]);
    await delay(250);

    let active = await snapshot();
    assert.equal(active.panels, 1, 'one panel for the active agent');
    assert.equal(active.brains, 1, 'one brain animation node');
    assert.deepEqual(active.animations, [ 'kikx-thinking-giggle' ]);
    assert.equal(active.rackHidden, false);

    let beforeAnimation = await animationProbe();
    assert.ok(beforeAnimation.startTime != null, 'the brain animation is running');
    let [ originX, originY ] = beforeAnimation.origin.split(/\s+/).map((value) => Number.parseFloat(value));
    assert.equal(beforeAnimation.transformBox, 'fill-box', 'the brain animates in its own icon box');
    assert.ok(originX === originY, `animation origin is centered (${beforeAnimation.origin})`);

    // The tooltip is a real scroll window. Hover it, then add enough lines to
    // overflow the fixed 6rem window and verify it stays pinned to the newest
    // line instead of leaving a frozen lower block.
    await inject('session_1', [
      { id: 'resp_1:thinking', type: 'AgentThinking', phantom: true, responseFrameID: 'resp_1', content: { text: Array.from({ length: 40 }, (_, index) => `reason line ${index + 1}`).join('\n') } },
    ]);
    await delay(150);
    await page.hover('.kikx-thinking-brain');
    await delay(100);

    let tipWindow = await page.evaluate(() => {
      let windowElement = document.querySelector('.kikx-thinking-tip__window');
      return windowElement ? {
        scrollTop: windowElement.scrollTop,
        scrollHeight: windowElement.scrollHeight,
        clientHeight: windowElement.clientHeight,
        lines: document.querySelectorAll('.kikx-thinking-tip__line').length,
      } : null;
    });
    assert.ok(tipWindow, 'the thinking tooltip is visible on hover');
    assert.ok(tipWindow.lines >= 40, 'the tooltip has the full thinking window');
    assert.ok(tipWindow.scrollHeight > tipWindow.clientHeight, 'the tooltip content overflows its fixed window');
    assert.ok(tipWindow.scrollTop + tipWindow.clientHeight >= tipWindow.scrollHeight - 2, 'the tooltip is pinned to its newest line');

    // Another thinking packet must update the panel without resetting the
    // running CSS animation.
    await inject('session_1', [
      { id: 'resp_1:thinking', type: 'AgentThinking', phantom: true, responseFrameID: 'resp_1', content: { text: 'more reasoning' } },
    ]);
    await delay(250);
    let afterAnimation = await animationProbe();
    assert.equal(afterAnimation.startTime, beforeAnimation.startTime, 'the brain animation start time is preserved');
    assert.ok(afterAnimation.currentTime >= beforeAnimation.currentTime, 'the brain animation keeps progressing');

    // A frame from another session must not appear in the selected rack.
    await inject('session_2', [
      { id: 'resp_2:typing', type: 'BeginTyping', phantom: true, responseFrameID: 'resp_2', content: { agentID: 'agent_2', agentName: 'Other' } },
      { id: 'resp_2:thinking', type: 'AgentThinking', phantom: true, responseFrameID: 'resp_2', content: { text: 'other session reasoning' } },
    ]);
    await delay(250);
    let scoped = await snapshot();
    assert.equal(scoped.panels, 1, 'another session does not add a brain');
    assert.deepEqual(scoped.ids, [ 'agent_1' ]);

    // Two overlapping responses from the same agent still share one brain.
    await inject('session_1', [
      { id: 'resp_3:typing', type: 'BeginTyping', phantom: true, responseFrameID: 'resp_3', content: { agentID: 'agent_1', agentName: 'Zav' } },
      { id: 'resp_3:thinking', type: 'AgentThinking', phantom: true, responseFrameID: 'resp_3', content: { text: 'first overlap' } },
      { id: 'resp_4:typing', type: 'BeginTyping', phantom: true, responseFrameID: 'resp_4', content: { agentID: 'agent_1', agentName: 'Zav' } },
      { id: 'resp_4:thinking', type: 'AgentThinking', phantom: true, responseFrameID: 'resp_4', content: { text: 'second overlap' } },
    ]);
    await delay(250);
    let overlapping = await snapshot();
    assert.equal(overlapping.panels, 1, 'overlapping responses render one brain');
    assert.equal(overlapping.brains, 1);

    // A silenced turn ends with EndTyping and no final AgentMessage. It must
    // clear the panel instead of leaving the animation running forever.
    await inject('session_1', [
      { id: 'resp_4:typing', type: 'EndTyping', phantom: true, responseFrameID: 'resp_4', content: { agentID: 'agent_1' } },
    ]);
    await delay(250);
    let ended = await snapshot();
    assert.equal(ended.panels, 0, 'EndTyping clears the brain without a final message');
    assert.equal(ended.brains, 0, 'no animation node survives the terminal event');
    assert.equal(ended.rackHidden, true, 'the rack hides when the agent stops');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close().catch(() => {});
  }
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
