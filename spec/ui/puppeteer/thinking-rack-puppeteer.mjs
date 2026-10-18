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
      animations: [ ...document.querySelectorAll('.kikx-thinking-brain') ].map((brain) => getComputedStyle(brain).animationName),
    }));

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
