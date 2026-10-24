'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

const { document } = installDom();
document.addEventListener = () => {};
document.removeEventListener = () => {};
globalThis.document = document;

const { buildGridIcon } = await import('../../src/client/components/kikx-shell-builders.mjs');
const { KikxParticipantsPopup, participantsForSession } = await import('../../src/client/components/kikx-participants-popup.mjs');

function state() {
  return {
    account: { id: 'usr_1', name: 'Wyatt' },
    sessionDetailsByID: {
      ses_1: {
        id: 'ses_1',
        participantAgentIDs: [ 'agent_2', 'agent_1' ],
        participantUserIDs: [ 'usr_1' ],
        coordinatorAgentID: 'agent_1',
      },
    },
    agentDetailsByID: {
      agent_1: { id: 'agent_1', name: 'Zav' },
      agent_2: { id: 'agent_2', name: 'Reviewer' },
    },
    framesBySessionID: { ses_1: [] },
  };
}

test('the sub-session glyph is a 3x3 dot grid', () => {
  let icon = buildGridIcon();
  assert.equal(icon.querySelectorAll('rect').length, 9);
  assert.equal(icon.getAttribute('viewBox'), '0 0 10.2 10.2');
});

test('participants include the coordinator, agents, and current user exactly once', () => {
  let participants = participantsForSession(state(), 'ses_1');
  assert.deepEqual(participants.map((entry) => [ entry.kind, entry.name, entry.role ]), [
    [ 'agent', 'Zav', 'Coordinator' ],
    [ 'agent', 'Reviewer', 'Agent' ],
    [ 'user', 'Wyatt', 'You' ],
  ]);
});

test('the participants button opens a popup list and closes on outside click', () => {
  let app = { _state: state(), _participantsPopupOpen: false };
  let popup = document.createElement('kikx-participants-popup');
  popup.configure({ app, appState: app._state, sessionID: 'ses_1' });
  document.body.appendChild(popup);

  let button = popup.querySelector('.kikx-participants__button');
  assert.equal(popup.querySelector('.kikx-participants__count').textContent, '3');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(popup.querySelector('.kikx-participants__panel').hidden, true);

  button.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
  assert.equal(app._participantsPopupOpen, true);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(popup.querySelector('.kikx-participants__panel').hidden, false);
  assert.deepEqual(
    popup.querySelectorAll('.kikx-participants__name').map((node) => node.textContent),
    [ 'Zav', 'Reviewer', 'Wyatt' ],
  );

  popup._outsideHandler({ target: document.body });
  assert.equal(app._participantsPopupOpen, false);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
});
