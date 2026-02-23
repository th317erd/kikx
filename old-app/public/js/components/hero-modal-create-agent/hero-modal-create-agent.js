'use strict';

/**
 * Hero Modal Create Agent
 * Modal for creating new AI agents.
 */

import { HeroModal, GlobalState, escapeHtml } from '../hero-modal/hero-modal.js';

export class HeroModalCreateAgent extends HeroModal {
  static tagName = 'hero-modal-create-agent';

  get modalTitle() { return 'New Agent'; }

  getContent() {
    let abilities = GlobalState.abilities.valueOf() || { system: [], user: [] };
    let allAbilities = [...(abilities.system || []), ...(abilities.user || [])];

    let abilitiesHtml = allAbilities.map((ability) => `
      <label class="checkbox-item">
        <input type="checkbox" name="abilities" value="${escapeHtml(ability.name)}" checked>
        ${escapeHtml(ability.name)}
      </label>
    `).join('');

    let selectAllHtml = (allAbilities.length > 0) ? `
      <label class="checkbox-item checkbox-select-all">
        <input type="checkbox" id="abilities-select-all" checked>
        <strong>Select All</strong>
      </label>
      <hr class="checkbox-divider">
    ` : '';

    return `
      <form autocomplete="off">
        <div class="form-row">
          <div class="form-group form-group-half">
            <label for="agent-name">Agent Name</label>
            <input type="text" id="agent-name" name="name" required placeholder="e.g., My Claude" autocomplete="off">
          </div>
          <div class="form-group form-group-half">
            <label for="agent-type">Base Type</label>
            <select id="agent-type" name="type" required>
              <option value="claude">Claude (Anthropic)</option>
              <option value="openai">OpenAI</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group form-group-half">
            <label for="agent-model">Model</label>
            <select id="agent-model" name="model">
              <option value="">Default</option>
              <optgroup label="Claude" id="claude-models">
                <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
                <option value="claude-opus-4-20250514">Claude Opus 4</option>
                <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</option>
                <option value="claude-3-5-haiku-20241022">Claude 3.5 Haiku</option>
              </optgroup>
              <optgroup label="OpenAI" id="openai-models" style="display:none">
                <option value="gpt-4o">GPT-4o</option>
                <option value="gpt-4-turbo">GPT-4 Turbo</option>
                <option value="gpt-4">GPT-4</option>
                <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
              </optgroup>
            </select>
          </div>
          <div class="form-group form-group-half">
            <label for="agent-api-url">API URL (optional)</label>
            <input type="url" id="agent-api-url" name="apiUrl" placeholder="Custom endpoint..." autocomplete="off">
          </div>
        </div>
        <div class="form-group">
          <label for="agent-api-key">API Key</label>
          <input type="password" id="agent-api-key" name="apiKey" required placeholder="sk-..." autocomplete="off">
        </div>
        <div class="form-group">
          <label>Enabled Abilities</label>
          <div id="agent-abilities-list" class="checkbox-list">
            ${selectAllHtml}${abilitiesHtml || '<em>No abilities available</em>'}
          </div>
        </div>
      </form>
      <footer slot="footer">
        <button type="button" class="button button-secondary">Cancel</button>
        <button type="submit" class="button button-primary">Add Agent</button>
      </footer>
    `;
  }

  mounted() {
    super.mounted();

    document.addEventListener('show-modal', (event) => {
      if (event.detail.modal === 'create-agent' || event.detail.modal === 'new-agent') {
        this.openModal();
      }
    });
  }

  _renderContent() {
    super._renderContent();

    let typeSelect = this.querySelector('[name="type"]');
    if (typeSelect) {
      typeSelect.addEventListener('change', () => this._filterModels());
    }

    // Bind select all checkbox
    let selectAllCheckbox = this.querySelector('#abilities-select-all');
    if (selectAllCheckbox) {
      selectAllCheckbox.addEventListener('change', () => this._toggleAllAbilities());
    }
  }

  _toggleAllAbilities() {
    let selectAll = this.querySelector('#abilities-select-all');
    let checkboxes = this.querySelectorAll('[name="abilities"]');

    for (let checkbox of checkboxes) {
      checkbox.checked = selectAll.checked;
    }
  }

  _filterModels() {
    let type = this.querySelector('[name="type"]')?.value;
    let claudeGroup = this.querySelector('#claude-models');
    let openaiGroup = this.querySelector('#openai-models');

    if (claudeGroup) claudeGroup.style.display = (type === 'claude') ? '' : 'none';
    if (openaiGroup) openaiGroup.style.display = (type === 'openai') ? '' : 'none';
  }

  async handleSubmit(event) {
    event.preventDefault();

    let form = this.querySelector('form');
    let name = form.querySelector('[name="name"]').value.trim();
    let type = form.querySelector('[name="type"]').value;
    let model = form.querySelector('[name="model"]').value;
    let apiKey = form.querySelector('[name="apiKey"]').value;
    let apiUrl = form.querySelector('[name="apiUrl"]').value.trim() || null;

    let abilities = Array.from(form.querySelectorAll('[name="abilities"]:checked'))
      .map((checkbox) => checkbox.value);

    if (!name || !type || !apiKey) {
      this.error = 'Please fill in all required fields';
      return;
    }

    let config = {};
    if (model) config.model = model;

    try {
      let { createAgent, fetchAgents } = window;
      await createAgent(name, type, apiKey, apiUrl, abilities, config);

      let agents = await fetchAgents();
      this.setGlobal('agents', agents);

      this.close();
    } catch (error) {
      this.error = error.message;
    }
  }
}

// Register component using Mythix UI pattern
HeroModalCreateAgent.register();
