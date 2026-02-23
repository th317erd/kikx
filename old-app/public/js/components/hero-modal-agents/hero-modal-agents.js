'use strict';

/**
 * Hero Modal Agents
 * Modal for viewing and managing agents.
 */

import { HeroModal, GlobalState, escapeHtml } from '../hero-modal/hero-modal.js';

export class HeroModalAgents extends HeroModal {
  static tagName = 'hero-modal-agents';

  get modalTitle() { return 'Agents'; }

  getAdditionalStyles() {
    return `
      dialog[open] {
        min-width: min(500px, calc(100vw - 32px));
      }
    `;
  }

  async onOpen() {
    try {
      let { fetchAgents } = window;
      let agents = await fetchAgents();
      this.setGlobal('agents', agents);
    } catch (error) {
      console.error('Failed to fetch agents:', error);
    }

    this._renderContent();
    this._bindAgentEvents();
    return true;
  }

  _renderContent() {
    super._renderContent();
    this._bindAgentEvents();
  }

  _bindAgentEvents() {
    let addBtn = this.querySelector('.add-agent-button');
    if (addBtn) {
      addBtn.onclick = () => {
        document.dispatchEvent(new CustomEvent('show-modal', {
          detail: { modal: 'create-agent' },
        }));
      };
    }

    let configBtns = this.querySelectorAll('.config-agent-btn');
    for (let btn of configBtns) {
      btn.onclick = () => this._openConfig(parseInt(btn.dataset.id, 10));
    }

    let deleteBtns = this.querySelectorAll('.delete-agent-btn');
    for (let btn of deleteBtns) {
      btn.onclick = () => this._deleteAgent(parseInt(btn.dataset.id, 10));
    }
  }

  _openConfig(agentId) {
    let configModal = document.querySelector('hero-modal-agent-settings');
    if (configModal) {
      configModal._agentId = agentId;
      configModal.openModal();
    }
  }

  async _deleteAgent(id) {
    if (!confirm('Are you sure you want to delete this agent?')) return;

    try {
      let { deleteAgent, fetchAgents } = window;
      await deleteAgent(id);
      let agents = await fetchAgents();
      this.setGlobal('agents', agents);

      this._renderContent();
    } catch (error) {
      alert('Failed to delete agent: ' + error.message);
    }
  }

  getContent() {
    let agents = GlobalState.agents.valueOf() || [];

    let agentsList = (agents.length === 0)
      ? '<p class="empty-state">No agents configured. Click "Add Agent" to create one.</p>'
      : agents.map((a) => `
          <div class="agent-item">
            <div class="agent-info">
              <strong>${escapeHtml(a.name)}</strong>
              <span class="agent-type">${escapeHtml(a.type)}</span>
              ${a.model ? `<span class="agent-model">${escapeHtml(a.model)}</span>` : ''}
            </div>
            <div class="agent-actions">
              <button type="button" class="button button-secondary button-icon-action config-agent-btn" data-id="${a.id}" title="Config">⚙</button>
              <button type="button" class="button button-danger button-icon-action delete-agent-btn" data-id="${a.id}" title="Delete">🗑</button>
            </div>
          </div>
        `).join('');

    return `
      <div class="agents-content">
        <div class="agents-actions">
          <button type="button" class="button button-primary add-agent-button">Add Agent</button>
        </div>
        <div class="agents-list">${agentsList}</div>
      </div>
      <footer slot="footer">
        <button type="button" class="button button-secondary">Close</button>
      </footer>
    `;
  }

  mounted() {
    super.mounted();

    document.addEventListener('show-modal', (event) => {
      if (event.detail.modal === 'agents') {
        this.openModal();
      }
    });
  }
}

// Register component using Mythix UI pattern
HeroModalAgents.register();
