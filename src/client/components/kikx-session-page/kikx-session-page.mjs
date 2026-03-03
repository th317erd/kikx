'use strict';

import { t } from '../../lib/i18n.mjs';
import { getAgents, createAgent, createSession } from '../../lib/api.mjs';
import { agents } from '../../lib/store.mjs';

const TEMPLATE_HTML = `
  <style>
    :host {
      display: grid;
      grid-template-areas:
        "topbar topbar"
        "chat sidebar"
        "statusbar statusbar";
      grid-template-columns: 1fr auto;
      grid-template-rows: auto 1fr auto;
      height: 100vh;
      overflow: hidden;
      background: var(--background-base, #0a0a1a);
      color: var(--text-primary, #e8e8f0);
    }

    kikx-top-bar {
      grid-area: topbar;
    }

    kikx-chat-view {
      grid-area: chat;
      overflow: hidden;
    }

    kikx-sidebar {
      grid-area: sidebar;
      width: 300px;
    }

    kikx-status-bar {
      grid-area: statusbar;
    }
  </style>

  <kikx-top-bar></kikx-top-bar>
  <kikx-chat-view></kikx-chat-view>
  <kikx-sidebar></kikx-sidebar>
  <kikx-status-bar></kikx-status-bar>

  <kikx-modal class="friend-modal">
    <kikx-add-friend-modal></kikx-add-friend-modal>
  </kikx-modal>
  <kikx-modal class="session-modal">
    <kikx-create-session-modal></kikx-create-session-modal>
  </kikx-modal>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class KikxSessionPage extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this._onAddFriend       = this._onAddFriend.bind(this);
    this._onAddSession      = this._onAddSession.bind(this);
    this._onFriendSave      = this._onFriendSave.bind(this);
    this._onFriendCancel    = this._onFriendCancel.bind(this);
    this._onSessionCreate   = this._onSessionCreate.bind(this);
    this._onModalClose      = this._onModalClose.bind(this);
  }

  connectedCallback() {
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    this._topBar             = this.shadowRoot.querySelector('kikx-top-bar');
    this._sidebar            = this.shadowRoot.querySelector('kikx-sidebar');
    this._friendModal        = this.shadowRoot.querySelector('.friend-modal');
    this._sessionModal       = this.shadowRoot.querySelector('.session-modal');
    this._addFriendWizard    = this.shadowRoot.querySelector('kikx-add-friend-modal');
    this._createSessionModal = this.shadowRoot.querySelector('kikx-create-session-modal');

    // Set modal titles
    this._friendModal.setAttribute('modal-title', t('friends.wizard.title'));
    this._sessionModal.setAttribute('modal-title', t('session.create.title'));

    // Set hide-back when no session active
    this._updateTopBar();

    // Event listeners
    this.shadowRoot.addEventListener('add-friend', this._onAddFriend);
    this.shadowRoot.addEventListener('add-session', this._onAddSession);
    this.shadowRoot.addEventListener('friend-save', this._onFriendSave);
    this.shadowRoot.addEventListener('friend-cancel', this._onFriendCancel);
    this.shadowRoot.addEventListener('session-create', this._onSessionCreate);
    this.shadowRoot.addEventListener('modal-close', this._onModalClose);

    this._loadAgents();
  }

  disconnectedCallback() {
    this.shadowRoot.removeEventListener('add-friend', this._onAddFriend);
    this.shadowRoot.removeEventListener('add-session', this._onAddSession);
    this.shadowRoot.removeEventListener('friend-save', this._onFriendSave);
    this.shadowRoot.removeEventListener('friend-cancel', this._onFriendCancel);
    this.shadowRoot.removeEventListener('session-create', this._onSessionCreate);
    this.shadowRoot.removeEventListener('modal-close', this._onModalClose);
  }

  get sessionId() {
    return this.getAttribute('data-id');
  }

  _updateTopBar() {
    let sessionId = this.sessionId;

    if (sessionId) {
      this._topBar.removeAttribute('hide-back');
      this._topBar.setAttribute('session-name', sessionId);
    } else {
      this._topBar.setAttribute('hide-back', '');
      this._topBar.removeAttribute('session-name');
    }
  }

  async _loadAgents() {
    try {
      let result    = await getAgents();
      let agentList = (result && result.data) ? result.data : [];

      // Store agents
      for (let agent of agentList)
        agents.addAgent(agent);

      // Map agents to friends format for the sidebar
      this._updateFriendsList(agentList);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to load agents:', error);
    }
  }

  _updateFriendsList(agentList) {
    if (!this._sidebar)
      return;

    let friends = agentList.map((agent) => ({
      id:   agent.id,
      name: agent.name,
      type: 'agent',
    }));

    this._sidebar.friends = friends;
  }

  _onAddFriend() {
    if (this._addFriendWizard && this._addFriendWizard.reset)
      this._addFriendWizard.reset();

    this._friendModal.open();
  }

  _onAddSession() {
    this._sessionModal.open();
  }

  async _onFriendSave(event) {
    let detail = event.detail;

    if (detail.type === 'agent') {
      try {
        let result = await createAgent({
          name:     detail.name,
          pluginID: detail.pluginID,
          apiKey:   detail.apiKey,
          model:    detail.model,
        });

        let newAgent = (result && result.data) ? result.data : result;
        agents.addAgent(newAgent);

        let allAgents = agents.getAllAgents();
        this._updateFriendsList(allAgents);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to create agent:', error);
      }
    }

    this._friendModal.close();
  }

  _onFriendCancel() {
    this._friendModal.close();
  }

  async _onSessionCreate(event) {
    let detail = event.detail || {};

    try {
      let result = await createSession({ name: detail.name });
      let newSession = (result && result.data) ? result.data : result;

      let { sessions } = await import('../../lib/store.mjs');
      sessions.addSession(newSession);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to create session:', error);
    }

    this._sessionModal.close();
  }

  _onModalClose() {
    // No-op: modals close themselves
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-session-page', KikxSessionPage);

export default KikxSessionPage;
