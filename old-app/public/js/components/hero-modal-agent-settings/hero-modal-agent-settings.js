'use strict';

/**
 * Hero Modal Agent Settings
 * Modal for editing agent configuration JSON.
 */

import { HeroModal, GlobalState } from '../hero-modal/hero-modal.js';

export class HeroModalAgentSettings extends HeroModal {
  static tagName = 'hero-modal-agent-settings';

  _agentId = null;

  get modalTitle() { return 'Agent Configuration'; }

  getAdditionalStyles() {
    return `
      dialog[open] {
        min-width: min(550px, calc(100vw - 32px));
      }
    `;
  }

  onOpen() {
    if (!this._agentId) return false;

    this._renderContent();
    this._loadAgentConfig();
    return true;
  }

  _loadAgentConfig() {
    let agents = GlobalState.agents.valueOf() || [];
    let agent = agents.find((a) => a.id === this._agentId);
    if (!agent) return;

    let configJson = this.querySelector('[name="config"]');
    if (configJson) {
      configJson.value = JSON.stringify(agent.config || {}, null, 2);
    }
  }

  getContent() {
    return `
      <form autocomplete="off">
        <p class="config-description">
          This JSON is merged into every API call for this agent.
          Common fields: model, maxTokens, temperature, etc.
        </p>
        <div class="form-group">
          <label for="agent-config-json">Configuration (JSON)</label>
          <textarea id="agent-config-json" name="config" rows="10" class="config-editor" autocomplete="off"
            placeholder='{ "model": "claude-sonnet-4-20250514", "maxTokens": 4096 }'></textarea>
        </div>
      </form>
      <footer slot="footer">
        <button type="button" class="button button-secondary">Cancel</button>
        <button type="submit" class="button button-primary">Save</button>
      </footer>
    `;
  }

  async handleSubmit(event) {
    event.preventDefault();

    let form = this.querySelector('form');
    let configStr = form.querySelector('[name="config"]').value.trim();

    let config;
    try {
      config = configStr ? JSON.parse(configStr) : {};
    } catch (e) {
      this.error = 'Invalid JSON: ' + e.message;
      return;
    }

    try {
      let { updateAgentConfig, fetchAgents } = window;
      await updateAgentConfig(this._agentId, config);

      let agents = await fetchAgents();
      this.setGlobal('agents', agents);

      this.close();
    } catch (error) {
      this.error = error.message;
    }
  }

  mounted() {
    super.mounted();

    document.addEventListener('show-modal', (event) => {
      if (event.detail.modal === 'agent-settings' || event.detail.modal === 'agent-config') {
        this.openModal();
      }
    });
  }
}

// Register component using Mythix UI pattern
HeroModalAgentSettings.register();
