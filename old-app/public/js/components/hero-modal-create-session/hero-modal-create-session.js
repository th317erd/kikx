'use strict';

/**
 * Hero Modal Create Session
 * Modal for creating new chat sessions with multi-agent support.
 *
 * The first selected agent becomes the coordinator (responds to unaddressed
 * messages). Additional agents become members (addressed via @mention).
 */

import { HeroModal, GlobalState, escapeHtml } from '../hero-modal/hero-modal.js';

export class HeroModalCreateSession extends HeroModal {
  static tagName = 'hero-modal-create-session';

  get modalTitle() { return 'New Session'; }

  onOpen() {
    let agents = GlobalState.agents.valueOf() || [];
    if (agents.length === 0) {
      document.dispatchEvent(new CustomEvent('show-modal', {
        detail: { modal: 'create-agent' },
      }));
      return false;
    }
    return true;
  }

  getContent() {
    let agents = GlobalState.agents.valueOf() || [];

    let agentOptions = '<option value="">Select coordinator agent...</option>';
    for (let agent of agents) {
      agentOptions += `<option value="${agent.id}">${escapeHtml(agent.name)} (${agent.type})</option>`;
    }

    let memberCheckboxes = '';
    if (agents.length > 1) {
      memberCheckboxes = `
        <div class="form-group">
          <label>Additional Agents <span class="label-hint">(optional)</span></label>
          <div class="agent-checkboxes" id="member-agents">
            ${agents.map((agent) => `
              <label class="checkbox-label agent-checkbox" data-agent-id="${agent.id}">
                <input type="checkbox" name="memberAgent" value="${agent.id}">
                <span>${escapeHtml(agent.name)} <span class="agent-type">(${agent.type})</span></span>
              </label>
            `).join('')}
          </div>
        </div>
      `;
    }

    return `
      <form autocomplete="off">
        <div class="form-group">
          <label for="session-name">Session Name</label>
          <input type="text" id="session-name" name="name" required placeholder="e.g., project-x" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="session-agent">Coordinator Agent</label>
          <select id="session-agent" name="agentId" required>
            ${agentOptions}
          </select>
        </div>
        ${memberCheckboxes}
        <div class="form-group">
          <label for="session-prompt">System Prompt <span class="label-hint">(optional)</span></label>
          <textarea id="session-prompt" name="systemPrompt" rows="3" placeholder="Instructions for the AI agent..."></textarea>
        </div>
      </form>
      <footer slot="footer">
        <button type="button" class="button button-secondary">Cancel</button>
        <button type="submit" class="button button-primary">Create</button>
      </footer>
    `;
  }

  async handleSubmit(event) {
    event.preventDefault();

    let form         = this.querySelector('form');
    let name         = form.querySelector('[name="name"]').value.trim();
    let coordinatorId = parseInt(form.querySelector('[name="agentId"]').value, 10);
    let systemPrompt = form.querySelector('[name="systemPrompt"]').value.trim() || null;

    if (!name || !coordinatorId) {
      this.error = 'Please fill in all required fields';
      return;
    }

    // Build agentIds array: coordinator first, then checked members
    let agentIds = [coordinatorId];
    let memberCheckboxes = form.querySelectorAll('[name="memberAgent"]:checked');
    for (let checkbox of memberCheckboxes) {
      let memberId = parseInt(checkbox.value, 10);
      if (memberId !== coordinatorId)
        agentIds.push(memberId);
    }

    try {
      let { createSession } = window;
      let session = await createSession(name, agentIds, systemPrompt);

      this.close();

      this.dispatchEvent(new CustomEvent('hero:navigate', {
        detail: { path: `/sessions/${session.id}` },
        bubbles:  true,
        composed: true,
      }));
    } catch (error) {
      this.error = error.message;
    }
  }

  mounted() {
    super.mounted();

    document.addEventListener('show-modal', (event) => {
      if (event.detail.modal === 'create-session' || event.detail.modal === 'new-session') {
        this.openModal();
      }
    });
  }
}

// Register component using Mythix UI pattern
HeroModalCreateSession.register();
