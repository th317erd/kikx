'use strict';

import { createIcon } from '../lib/icons.mjs';

export class KikxParticipantsPopup extends HTMLElement {
  constructor() {
    super();
    this._app = null;
    this._appState = null;
    this._sessionID = null;
    this._button = null;
    this._panel = null;
    this._outsideHandler = null;
    this._keyHandler = null;
  }

  configure({ app, appState = null, sessionID = null } = {}) {
    this._app = app || null;
    this._appState = appState || app?._state || null;
    this._sessionID = sessionID || null;
    if (this.isConnected)
      this._render();
  }

  connectedCallback() {
    this._render();
  }

  disconnectedCallback() {
    this._removeOutsideHandlers();
  }

  get isOpen() {
    return this._panel?.hidden === false;
  }

  _render() {
    if (!this._app || !this._appState || !this._sessionID)
      return;

    let participants = participantsForSession(this._appState, this._sessionID);
    let count = participants.length;

    let root = document.createElement('div');
    root.className = 'kikx-participants';

    let button = document.createElement('button');
    button.type = 'button';
    button.className = 'kikx-participants__button';
    button.title = `Show session participants (${count})`;
    button.setAttribute('aria-label', `Show session participants (${count})`);
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.appendChild(createIcon('people', { ownerDocument: document }));
    let countLabel = document.createElement('span');
    countLabel.className = 'kikx-participants__count';
    countLabel.textContent = String(count);
    button.appendChild(countLabel);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      this._toggle();
    });

    let panel = document.createElement('div');
    panel.className = 'kikx-participants__panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Session participants');
    panel.hidden = true;

    this.replaceChildren(root);
    root.append(button, panel);
    this._button = button;
    this._panel = panel;
    this._renderPanel(participants);

    if (this._app._participantsPopupOpen === true)
      this._open({ focus: false });
  }

  _renderPanel(participants) {
    if (!this._panel)
      return;

    this._panel.replaceChildren();
    let header = document.createElement('div');
    header.className = 'kikx-participants__header';
    let title = document.createElement('strong');
    title.textContent = 'Participants';
    let count = document.createElement('span');
    count.textContent = String(participants.length);
    header.append(title, count);

    let list = document.createElement('div');
    list.className = 'kikx-participants__list';
    if (participants.length === 0) {
      let empty = document.createElement('p');
      empty.className = 'kikx-participants__empty';
      empty.textContent = 'No participants recorded.';
      list.appendChild(empty);
    } else {
      for (let participant of participants)
        list.appendChild(participantRow(participant));
    }

    this._panel.append(header, list);
  }

  _toggle() {
    if (this.isOpen)
      this._close();
    else
      this._open({ focus: true });
  }

  _open({ focus = true } = {}) {
    if (!this._panel || !this._app)
      return;
    this._app._participantsPopupOpen = true;
    this._panel.hidden = false;
    this._button?.setAttribute('aria-expanded', 'true');
    this.classList.add('is-open');
    this._installOutsideHandlers();
    if (focus)
      this._panel.focus?.();
  }

  _close() {
    if (!this._panel)
      return;
    this._panel.hidden = true;
    this._button?.setAttribute('aria-expanded', 'false');
    this.classList.remove('is-open');
    if (this._app)
      this._app._participantsPopupOpen = false;
    this._removeOutsideHandlers();
  }

  _installOutsideHandlers() {
    this._removeOutsideHandlers();
    this._outsideHandler = (event) => {
      if (!this.contains(event.target))
        this._close();
    };
    this._keyHandler = (event) => {
      if (event.key !== 'Escape')
        return;
      event.preventDefault();
      this._close();
      this._button?.focus?.();
    };
    document.addEventListener('pointerdown', this._outsideHandler, true);
    document.addEventListener('keydown', this._keyHandler, true);
    this._panel?.setAttribute('tabindex', '-1');
  }

  _removeOutsideHandlers() {
    if (this._outsideHandler)
      document.removeEventListener('pointerdown', this._outsideHandler, true);
    if (this._keyHandler)
      document.removeEventListener('keydown', this._keyHandler, true);
    this._outsideHandler = null;
    this._keyHandler = null;
  }
}

export function participantsForSession(appState, sessionID) {
  let session = appState?.sessionDetailsByID?.[sessionID] || {};
  let agentIDs = Array.isArray(session.participantAgentIDs) ? session.participantAgentIDs : [];
  let userIDs = Array.isArray(session.participantUserIDs) ? session.participantUserIDs : [];
  let accountID = appState?.account?.id || '';
  let coordinatorID = session.coordinatorAgentID || '';
  let userNames = collectUserNames(appState, sessionID);
  let participants = [];
  let seen = new Set();

  for (let agentID of agentIDs) {
    if (!agentID || seen.has(`agent:${agentID}`))
      continue;
    seen.add(`agent:${agentID}`);
    let agent = appState?.agentDetailsByID?.[agentID] || {};
    participants.push({
      kind: 'agent',
      id: agentID,
      name: agent.name || agentID,
      role: agentID === coordinatorID ? 'Coordinator' : 'Agent',
      coordinator: agentID === coordinatorID,
    });
  }

  for (let userID of userIDs) {
    if (!userID || seen.has(`user:${userID}`))
      continue;
    seen.add(`user:${userID}`);
    participants.push({
      kind: 'user',
      id: userID,
      name: userDisplayName(appState, userNames, userID),
      role: userID === accountID ? 'You' : 'User',
      coordinator: false,
    });
  }

  if (accountID && !seen.has(`user:${accountID}`)) {
    // The session creator/current user is a participant even on older sessions
    // whose participantUserIDs array predates user tracking.
    participants.push({
      kind: 'user',
      id: accountID,
      name: appState.account?.name || appState.account?.username || accountID,
      role: 'You',
      coordinator: false,
    });
  }

  participants.sort((left, right) => {
    if (left.coordinator !== right.coordinator)
      return left.coordinator ? -1 : 1;
    if (left.kind !== right.kind)
      return left.kind === 'agent' ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  return participants;
}

function collectUserNames(appState, sessionID) {
  let names = new Map();
  let frames = appState?.framesBySessionID?.[sessionID] || [];
  for (let frame of frames) {
    if (frame?.authorType !== 'user' || !frame.authorID)
      continue;
    let name = typeof frame.authorDisplayName === 'string' ? frame.authorDisplayName.trim() : '';
    if (name)
      names.set(frame.authorID, name);
  }
  return names;
}

function userDisplayName(appState, names, userID) {
  if (userID === appState?.account?.id)
    return appState.account?.name || appState.account?.username || 'You';
  return names.get(userID) || `User ${shortID(userID)}`;
}

function shortID(value) {
  let text = String(value || '');
  return text.length > 8 ? text.slice(0, 8) : text;
}

function participantRow(participant) {
  let row = document.createElement('div');
  row.className = `kikx-participants__row kikx-participants__row--${participant.kind}${participant.coordinator ? ' is-coordinator' : ''}`;

  let avatar = document.createElement('span');
  avatar.className = `kikx-participants__avatar kikx-participants__avatar--${participant.kind}`;
  avatar.textContent = initialFor(participant.name);
  avatar.setAttribute('aria-hidden', 'true');

  let body = document.createElement('span');
  body.className = 'kikx-participants__body';
  let name = document.createElement('strong');
  name.className = 'kikx-participants__name';
  name.textContent = participant.name;
  let role = document.createElement('span');
  role.className = 'kikx-participants__role';
  role.textContent = participant.role;
  body.append(name, role);

  row.append(avatar, body);
  return row;
}

function initialFor(name) {
  let text = String(name || '?').trim();
  return (text[0] || '?').toUpperCase();
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-participants-popup'))
  customElements.define('kikx-participants-popup', KikxParticipantsPopup);
