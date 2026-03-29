'use strict';

import { t } from '../../lib/i18n.mjs';

const TEMPLATE_HTML = `
  <style>
    kikx-edit-session-modal { display: block; }

    kikx-edit-session-modal .form-group { margin-bottom: 12px; }

    kikx-edit-session-modal .form-label {
      display: block; font-size: 1rem; font-weight: 600;
      color: var(--text-secondary, #a0a0b8); margin-bottom: 4px;
    }

    kikx-edit-session-modal .form-input {
      width: 100%; box-sizing: border-box;
      padding: 8px 12px; font-size: 1rem;
      background: var(--input-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--border-radius-small, 4px);
      color: var(--text-primary, #e8e8f0); outline: none;
      font-family: inherit;
      transition: border-color 0.2s ease;
    }

    kikx-edit-session-modal .form-input:focus {
      border-color: var(--accent-primary, #00e5ff);
      box-shadow: 0 0 8px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }

    kikx-edit-session-modal .participant-list {
      list-style: none; margin: 0; padding: 0;
      max-height: 240px; overflow-y: auto;
    }

    kikx-edit-session-modal .participant-row {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 10px;
      border-radius: var(--border-radius-small, 4px);
      background: rgba(255, 255, 255, 0.03);
      margin-bottom: 4px;
    }

    kikx-edit-session-modal .participant-row:last-child { margin-bottom: 0; }

    kikx-edit-session-modal .participant-avatar {
      width: 32px; height: 32px; flex-shrink: 0;
      border-radius: 50%;
      background: var(--accent-primary, #00e5ff);
      color: #fff; font-size: 0.75rem; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
      text-transform: uppercase; user-select: none;
    }

    kikx-edit-session-modal .participant-name {
      flex: 1; font-size: 0.95rem;
      color: var(--text-primary, #e8e8f0);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    kikx-edit-session-modal .participant-role {
      font-size: 0.75rem; font-weight: 600;
      padding: 2px 8px; border-radius: 10px;
      text-transform: lowercase; flex-shrink: 0;
    }

    kikx-edit-session-modal .participant-role.coordinator {
      background: rgba(0, 229, 255, 0.15);
      color: var(--accent-primary, #00e5ff);
    }

    kikx-edit-session-modal .participant-role.member {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-secondary, #a0a0b8);
    }

    kikx-edit-session-modal .kick-button {
      background: rgba(229, 57, 53, 0.15); color: var(--error-color, #ff4444);
      border: 1px solid rgba(229, 57, 53, 0.30);
      border-radius: var(--border-radius-small, 4px);
      padding: 4px 10px; font-size: 0.8rem; cursor: pointer;
      flex-shrink: 0; transition: background 0.2s ease;
    }

    kikx-edit-session-modal .kick-button:hover { background: rgba(229, 57, 53, 0.25); }

    kikx-edit-session-modal .invite-row {
      display: flex; gap: 8px; margin-top: 8px;
    }

    kikx-edit-session-modal .invite-input {
      flex: 1; box-sizing: border-box;
      padding: 8px 12px; font-size: 1rem;
      background: var(--input-background, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--border-radius-small, 4px);
      color: var(--text-primary, #e8e8f0); outline: none;
      font-family: inherit;
      transition: border-color 0.2s ease;
    }

    kikx-edit-session-modal .invite-input:focus {
      border-color: var(--accent-primary, #00e5ff);
      box-shadow: 0 0 8px var(--accent-glow, rgba(0, 229, 255, 0.30));
    }

    kikx-edit-session-modal .invite-button {
      background: var(--accent-primary, #00e5ff); color: #fff;
      border: none; border-radius: var(--border-radius-small, 4px);
      padding: 8px 16px; font-weight: 600; font-size: 0.9rem; cursor: pointer;
      white-space: nowrap;
    }

    kikx-edit-session-modal .invite-button:hover {
      box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.40));
    }

    kikx-edit-session-modal .participant-list::-webkit-scrollbar { width: 6px; }
    kikx-edit-session-modal .participant-list::-webkit-scrollbar-track { background: transparent; }
    kikx-edit-session-modal .participant-list::-webkit-scrollbar-thumb {
      background: var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: 3px;
    }
    kikx-edit-session-modal .participant-list::-webkit-scrollbar-button { display: none; }

    kikx-edit-session-modal .button-row {
      display: flex; gap: var(--spacing-sm, 8px); justify-content: flex-end;
      margin-top: 16px; padding-top: 12px;
      border-top: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
    }

    kikx-edit-session-modal .delete-button {
      background: rgba(229, 57, 53, 0.15); color: #ef5350;
      border: 1px solid rgba(229, 57, 53, 0.30);
      border-radius: var(--border-radius-small, 4px);
      padding: 8px 16px; font-size: 1rem; cursor: pointer;
      margin-right: auto;
    }

    kikx-edit-session-modal .delete-button:hover { background: rgba(229, 57, 53, 0.25); }

    kikx-edit-session-modal .cancel-button {
      background: none; border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      color: var(--text-secondary, #a0a0b8);
      border-radius: var(--border-radius-small, 4px);
      padding: 8px 16px; font-size: 1rem; cursor: pointer;
    }

    kikx-edit-session-modal .cancel-button:hover { background: var(--glass-hover, rgba(255, 255, 255, 0.08)); }

    kikx-edit-session-modal .save-button {
      background: var(--accent-primary, #00e5ff); color: #fff;
      border: none; border-radius: var(--border-radius-small, 4px);
      padding: 8px 20px; font-weight: 600; font-size: 1rem; cursor: pointer;
    }

    kikx-edit-session-modal .save-button:hover { box-shadow: 0 0 12px var(--accent-glow, rgba(0, 229, 255, 0.40)); }

    kikx-edit-session-modal .empty-participants {
      font-size: 0.9rem; color: var(--text-muted, #606078);
      font-style: italic; padding: 8px 0;
    }
  </style>

  <div class="form-group">
    <label class="form-label name-label"></label>
    <input class="form-input name-input" type="text" />
  </div>
  <div class="form-group">
    <label class="form-label participants-label"></label>
    <ul class="participant-list"></ul>
    <div class="invite-row">
      <input class="invite-input" type="text" />
      <button class="invite-button"></button>
    </div>
  </div>
  <div class="button-row">
    <button class="delete-button"></button>
    <button class="cancel-button"></button>
    <button class="save-button"></button>
  </div>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

function getInitials(name) {
  if (!name)
    return '?';

  let parts = name.trim().split(/\s+/);
  if (parts.length >= 2)
    return (parts[0][0] + parts[1][0]).toUpperCase();

  return parts[0].substring(0, 2).toUpperCase();
}

class KikxEditSessionModal extends HTMLElement {
  constructor() {
    super();
    this._session      = null;
    this._participants = [];
    this._confirmingDelete = false;

    this._onSaveClick    = this._onSaveClick.bind(this);
    this._onDeleteClick  = this._onDeleteClick.bind(this);
    this._onCancelClick  = this._onCancelClick.bind(this);
    this._onInviteClick  = this._onInviteClick.bind(this);
    this._onInviteKeydown = this._onInviteKeydown.bind(this);
  }

  connectedCallback() {
    if (!this._initialized) {
      this._initialized = true;
      this.appendChild(getTemplate().content.cloneNode(true));

      this._nameInput         = this.querySelector('.name-input');
      this._nameLabel         = this.querySelector('.name-label');
      this._participantsLabel = this.querySelector('.participants-label');
      this._participantList   = this.querySelector('.participant-list');
      this._inviteInput       = this.querySelector('.invite-input');
      this._inviteButton      = this.querySelector('.invite-button');
      this._saveButton        = this.querySelector('.save-button');
      this._deleteButton      = this.querySelector('.delete-button');
      this._cancelButton      = this.querySelector('.cancel-button');
    }

    this._nameLabel.textContent         = t('session.edit.nameLabel');
    this._participantsLabel.textContent = t('session.edit.participants');
    this._inviteInput.placeholder       = t('session.edit.invitePlaceholder');
    this._inviteButton.textContent      = t('session.edit.inviteButton');
    this._saveButton.textContent        = t('session.edit.saveButton');
    this._deleteButton.textContent      = t('session.edit.deleteButton');
    this._cancelButton.textContent      = t('session.edit.cancelButton');

    this._saveButton.addEventListener('click', this._onSaveClick);
    this._deleteButton.addEventListener('click', this._onDeleteClick);
    this._cancelButton.addEventListener('click', this._onCancelClick);
    this._inviteButton.addEventListener('click', this._onInviteClick);
    this._inviteInput.addEventListener('keydown', this._onInviteKeydown);
  }

  disconnectedCallback() {
    this._saveButton.removeEventListener('click', this._onSaveClick);
    this._deleteButton.removeEventListener('click', this._onDeleteClick);
    this._cancelButton.removeEventListener('click', this._onCancelClick);
    this._inviteButton.removeEventListener('click', this._onInviteClick);
    this._inviteInput.removeEventListener('keydown', this._onInviteKeydown);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  set session(value) {
    this._session      = value;
    this._participants = (value && Array.isArray(value.participants)) ? value.participants : [];
    this._confirmingDelete = false;

    if (!this._nameInput)
      return;

    this._nameInput.value = (value && value.name) || '';
    this._deleteButton.textContent = t('session.edit.deleteButton');
    this._renderParticipants();
  }

  get session() {
    return this._session;
  }

  getValues() {
    return { name: this._nameInput.value.trim() };
  }

  reset() {
    this._session      = null;
    this._participants = [];
    this._confirmingDelete = false;

    if (this._nameInput)
      this._nameInput.value = '';

    if (this._inviteInput)
      this._inviteInput.value = '';

    if (this._deleteButton)
      this._deleteButton.textContent = t('session.edit.deleteButton');

    if (this._participantList)
      this._participantList.innerHTML = '';
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  _renderParticipants() {
    if (!this._participantList)
      return;

    this._participantList.innerHTML = '';

    if (this._participants.length === 0) {
      let empty = document.createElement('li');
      empty.className   = 'empty-participants';
      empty.textContent = '--';
      this._participantList.appendChild(empty);
      return;
    }

    for (let participant of this._participants) {
      let li = document.createElement('li');
      li.className = 'participant-row';

      let avatar = document.createElement('span');
      avatar.className   = 'participant-avatar';
      avatar.textContent = getInitials(participant.name);
      li.appendChild(avatar);

      let name = document.createElement('span');
      name.className   = 'participant-name';
      name.textContent = participant.name || participant.agentID || 'Unknown';
      li.appendChild(name);

      let isCoordinator = (participant.role === 'coordinator');

      let role = document.createElement('span');
      role.className   = `participant-role ${isCoordinator ? 'coordinator' : 'member'}`;
      role.textContent = isCoordinator
        ? t('session.edit.coordinator')
        : t('session.edit.member');
      li.appendChild(role);

      if (!isCoordinator) {
        let kickBtn = document.createElement('button');
        kickBtn.className   = 'kick-button';
        kickBtn.textContent = t('session.edit.kickButton');
        kickBtn.addEventListener('click', () => {
          this.dispatchEvent(new CustomEvent('session-kick', {
            bubbles:  true,
            composed: true,
            detail: {
              sessionID:     this._session?.id,
              participantID: participant.id,
              agentID:       participant.agentID,
            },
          }));
        });
        li.appendChild(kickBtn);
      }

      this._participantList.appendChild(li);
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  _onSaveClick() {
    this.dispatchEvent(new CustomEvent('session-save', {
      bubbles:  true,
      composed: true,
      detail: {
        sessionID: this._session?.id,
        values:    this.getValues(),
      },
    }));
  }

  _onDeleteClick() {
    if (!this._confirmingDelete) {
      this._confirmingDelete = true;
      this._deleteButton.textContent = t('session.edit.deleteConfirm');
      return;
    }

    this._confirmingDelete = false;
    this._deleteButton.textContent = t('session.edit.deleteButton');

    this.dispatchEvent(new CustomEvent('session-delete', {
      bubbles:  true,
      composed: true,
      detail:   { sessionID: this._session?.id },
    }));
  }

  _onCancelClick() {
    this.dispatchEvent(new CustomEvent('session-edit-cancel', {
      bubbles:  true,
      composed: true,
    }));
  }

  _onInviteClick() {
    let agentName = this._inviteInput.value.trim();
    if (!agentName)
      return;

    this.dispatchEvent(new CustomEvent('session-invite', {
      bubbles:  true,
      composed: true,
      detail: {
        sessionID: this._session?.id,
        agentName,
      },
    }));

    this._inviteInput.value = '';
  }

  _onInviteKeydown(event) {
    if (event.key === 'Enter')
      this._onInviteClick();
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-edit-session-modal', KikxEditSessionModal);

export default KikxEditSessionModal;
