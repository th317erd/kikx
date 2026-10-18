'use strict';

// Real-browser coverage for the pinned per-agent "thinking" rack, per project
// convention (.codex/quirks.md: every UI update needs browser coverage).
//
// The rack replaces the old inline thinking/streaming bubble: while an agent
// streams, a fixed-size panel shows its reasoning in a scrolling window and the
// THREAD is NOT polluted with live thinking/delta/typing frames; once the
// response completes the panel disappears and only the final message remains.

import assert from 'node:assert/strict';
import test from 'node:test';

import { chromium } from 'playwright';

import {
  findChromeExecutable,
  startStagehandUIServer,
} from '../stagehand/stagehand-test-utils.mjs';

test('the thinking rack shows a fixed per-agent panel and never pollutes the thread', async (t) => {
  let chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip('real-browser coverage requires Chrome');
    return;
  }

  let fixture = await startStagehandUIServer({
    sessions: [ { id: 'session_1', title: 'Rack Session', messageCount: 0 } ],
  });

  let browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
    chromiumSandbox: false,
    args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
  });

  try {
    let page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // This harness authenticates with a seeded session token, not a magic-link
    // code: the fixture's auth stub deliberately accepts the former path.
    await page.addInitScript(() => {
      sessionStorage.setItem('kikx.auth.session', JSON.stringify({ token: 'playwright-test-token', refresh_token: 'playwright-test-refresh' }));
    });
    await page.goto(`${fixture.baseURL}/`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForSelector('kikx-session-card', { timeout: 10000 });
    await page.locator('kikx-session-card').first().locator('article.kikx-session-card').click();
    await page.waitForTimeout(500);

    let sessionID = await page.evaluate(() => document.querySelector('kikx-app')?._state?.selectedSessionID);
    assert.equal(sessionID, 'session_1');

    let inject = (frames) => page.evaluate(({ sessionID, frames }) => {
      let app = document.querySelector('kikx-app');
      for (let frame of frames)
        app._onRuntimeEvent({ data: JSON.stringify({ type: 'frame.phantom', sessionID, frame: { sessionID, ...frame } }) });
    }, { sessionID, frames });

    let snapshot = () => page.evaluate(() => {
      let panel = document.querySelector('kikx-thinking-panel');
      let box = panel?.getBoundingClientRect();
      return {
        panels: document.querySelectorAll('kikx-thinking-panel').length,
        brains: document.querySelectorAll('.kikx-thinking-brain').length,
        rackHidden: document.querySelector('kikx-thinking-rack')?.hidden === true,
        panelBox: box ? { w: Math.round(box.width), h: Math.round(box.height) } : null,
        name: document.querySelector('.kikx-thinking-tip__name')?.textContent || '',
        lines: document.querySelectorAll('.kikx-thinking-tip__line').length,
        lastLine: (() => {
          let lines = document.querySelectorAll('.kikx-thinking-tip__line');
          return lines && lines.length ? lines[lines.length - 1].textContent : '';
        })(),
        thinkingInThread: !!document.querySelector('.kikx-frame__thinking, kikx-typing-indicator'),
      };
    });

    let responseFrameID = 'resp_1';
    await inject([ { id: `${responseFrameID}:typing`, type: 'BeginTyping', phantom: true, responseFrameID, content: { agentID: 'agent_1', agentName: 'Zav' } } ]);
    await page.waitForTimeout(200);
    let box0 = (await snapshot()).panelBox;

    for (let i = 1; i <= 8; i++) {
      await inject([
        { id: `${responseFrameID}:thinking`, type: 'AgentThinking', phantom: true, responseFrameID, content: { text: Array.from({ length: i }, (_, k) => `reason ${k + 1}`).join('\n') } },
        { id: `${responseFrameID}:delta`, type: 'AgentMessageDelta', phantom: true, responseFrameID, content: { text: `answer ${i}` } },
      ]);
      await page.waitForTimeout(80);
    }

    let streaming = await snapshot();
    assert.equal(streaming.panels, 1, 'one panel per thinking agent');
    assert.equal(streaming.rackHidden, false, 'the rack is visible while an agent thinks');
    assert.equal(streaming.name, 'Zav', 'the panel names the agent');
    assert.equal(streaming.lastLine, 'answer 8', 'the newest streamed line is shown');
    assert.ok(streaming.lines >= 8, 'the agent’s reasoning lines are buffered');
    assert.equal(streaming.thinkingInThread, false, 'live frames never render in the thread');
    assert.deepEqual(streaming.panelBox, box0, 'the panel never resizes while streaming');

    // Completing the response removes the panel (the final message is a thread item).
    await inject([ { id: responseFrameID, type: 'AgentMessage', phantom: false, responseFrameID, hidden: false, deleted: false, content: { status: 'complete', text: 'Final answer.' } } ]);
    await page.waitForTimeout(300);
    let done = await snapshot();
    assert.equal(done.panels, 0, 'the panel is removed once the response completes');
    assert.equal(done.brains, 0, 'no animation node remains after completion');
    assert.equal(done.rackHidden, true, 'the rack hides when no agent is thinking');

    // An empty/silenced turn ends with EndTyping and may emit no final
    // AgentMessage. The rack must still clear instead of spinning forever.
    await inject([
      { id: 'resp_2:typing', type: 'BeginTyping', phantom: true, responseFrameID: 'resp_2', content: { agentID: 'agent_1', agentName: 'Zav' } },
      { id: 'resp_2:thinking', type: 'AgentThinking', phantom: true, responseFrameID: 'resp_2', content: { text: 'thinking before a silenced turn' } },
      { id: 'resp_2:delta', type: 'AgentMessageDelta', phantom: true, responseFrameID: 'resp_2', content: { text: 'partial answer' } },
      { id: 'resp_2:typing', type: 'EndTyping', phantom: true, responseFrameID: 'resp_2', content: { agentID: 'agent_1' } },
    ]);
    await page.waitForTimeout(300);
    let silenced = await snapshot();
    assert.equal(silenced.panels, 0, 'EndTyping clears a response with no final AgentMessage');
    assert.equal(silenced.brains, 0, 'EndTyping leaves no spinning animation');

    // Two overlapping responses from the same agent still render one brain.
    await inject([
      { id: 'resp_3:typing', type: 'BeginTyping', phantom: true, responseFrameID: 'resp_3', content: { agentID: 'agent_1', agentName: 'Zav' } },
      { id: 'resp_3:thinking', type: 'AgentThinking', phantom: true, responseFrameID: 'resp_3', content: { text: 'first response' } },
      { id: 'resp_4:typing', type: 'BeginTyping', phantom: true, responseFrameID: 'resp_4', content: { agentID: 'agent_1', agentName: 'Zav' } },
      { id: 'resp_4:thinking', type: 'AgentThinking', phantom: true, responseFrameID: 'resp_4', content: { text: 'second response' } },
    ]);
    await page.waitForTimeout(300);
    let overlapping = await snapshot();
    assert.equal(overlapping.panels, 1, 'one brain per agent even with overlapping responses');
    assert.equal(overlapping.brains, 1, 'only one brain animation node is rendered');

    await inject([ { id: 'resp_4:typing', type: 'EndTyping', phantom: true, responseFrameID: 'resp_4', content: { agentID: 'agent_1' } } ]);
    await page.waitForTimeout(300);
    assert.equal((await snapshot()).panels, 0, 'the final EndTyping clears the overlapping brain');
  } finally {
    await browser.close().catch(() => {});
    await fixture.close();
  }
});
