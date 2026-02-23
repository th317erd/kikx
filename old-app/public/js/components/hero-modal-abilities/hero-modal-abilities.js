'use strict';

/**
 * Hero Modal Abilities
 * Modal for viewing and managing abilities.
 */

import { HeroModal, GlobalState, escapeHtml } from '../hero-modal/hero-modal.js';

export class HeroModalAbilities extends HeroModal {
  static tagName = 'hero-modal-abilities';

  _activeTab = 'system';

  get modalTitle() { return 'Abilities'; }

  getAdditionalStyles() {
    return `
      dialog[open] {
        width: min(50vw, calc(100vw - 32px));
        min-width: min(400px, calc(100vw - 32px));
        max-width: min(600px, calc(100vw - 32px));
        height: 70vh;
        min-height: min(400px, calc(100vh - 100px));
        max-height: 80vh;
      }
    `;
  }

  async onOpen() {
    try {
      let { fetchAbilities } = window;
      let abilities = await fetchAbilities();
      this.setGlobal('abilities', abilities);
    } catch (error) {
      console.error('Failed to fetch abilities:', error);
    }

    this._renderContent();
    this._bindTabEvents();
    return true;
  }

  _renderContent() {
    super._renderContent();
    this._bindTabEvents();
  }

  _bindTabEvents() {
    let tabButtons = this.querySelectorAll('.tab-button');
    for (let button of tabButtons) {
      button.onclick = () => this._switchTab(button.dataset.tab);
    }

    let newBtn = this.querySelector('.new-ability-button');
    if (newBtn) {
      newBtn.onclick = () => {
        document.dispatchEvent(new CustomEvent('show-modal', {
          detail: { modal: 'configure-ability' },
        }));
      };
    }

    let editBtns = this.querySelectorAll('.edit-ability-btn');
    for (let btn of editBtns) {
      btn.onclick = () => this._editAbility(parseInt(btn.dataset.id, 10));
    }

    let deleteBtns = this.querySelectorAll('.delete-ability-btn');
    for (let btn of deleteBtns) {
      btn.onclick = () => this._deleteAbility(parseInt(btn.dataset.id, 10));
    }
  }

  _switchTab(tab) {
    this._activeTab = tab;

    let tabButtons = this.querySelectorAll('.tab-button');
    for (let button of tabButtons) {
      button.classList.toggle('active', button.dataset.tab === tab);
    }

    let systemTab = this.querySelector('#abilities-tab-system');
    let userTab = this.querySelector('#abilities-tab-user');
    if (systemTab) systemTab.classList.toggle('active', tab === 'system');
    if (userTab) userTab.classList.toggle('active', tab === 'user');
  }

  async _editAbility(id) {
    let abilityModal = document.querySelector('hero-modal-configure-ability');
    if (abilityModal) {
      abilityModal._editId = id;

      let abilities = GlobalState.abilities.valueOf() || { system: [], user: [] };
      let ability = abilities.user?.find((a) => a.id === id);
      if (ability) {
        abilityModal.openModal();

        requestAnimationFrame(() => {
          let form = abilityModal.querySelector('form');
          if (form) {
            form.querySelector('[name="name"]').value = ability.name || '';
            form.querySelector('[name="category"]').value = ability.category || '';
            form.querySelector('[name="description"]').value = ability.description || '';
            form.querySelector('[name="applies"]').value = ability.applies || '';
            form.querySelector('[name="content"]').value = ability.content || '';
            form.querySelector('[name="autoApprove"]').checked = ability.autoApprove || false;
            form.querySelector('[name="dangerLevel"]').value = ability.dangerLevel || 'safe';
          }
        });
      }
    }
  }

  async _deleteAbility(id) {
    if (!confirm('Are you sure you want to delete this ability?')) return;

    try {
      let { deleteAbility, fetchAbilities } = window;
      await deleteAbility(id);
      let abilities = await fetchAbilities();
      this.setGlobal('abilities', abilities);

      this._renderContent();
    } catch (error) {
      alert('Failed to delete ability: ' + error.message);
    }
  }

  getContent() {
    let abilities = GlobalState.abilities.valueOf() || { system: [], user: [] };
    let systemAbilities = abilities.system || [];
    let userAbilities = abilities.user || [];

    let systemList = (systemAbilities.length === 0)
      ? '<p class="empty-state">No system abilities loaded.</p>'
      : systemAbilities.map((a) => `
          <div class="ability-item">
            <div class="ability-info">
              <strong>${escapeHtml(a.name)}</strong>
              <span class="ability-category">${escapeHtml(a.category || 'system')}</span>
            </div>
            <p class="ability-description">${escapeHtml(a.description || '')}</p>
          </div>
        `).join('');

    let userList = (userAbilities.length === 0)
      ? '<p class="empty-state">No custom abilities yet. Click "New Ability" to create one.</p>'
      : userAbilities.map((a) => `
          <div class="ability-item">
            <div class="ability-info">
              <strong>${escapeHtml(a.name)}</strong>
              <span class="ability-category">${escapeHtml(a.category || 'custom')}</span>
              <div class="ability-actions">
                <button type="button" class="button button-secondary button-icon-action edit-ability-btn" data-id="${a.id}" title="Edit">✏</button>
                <button type="button" class="button button-danger button-icon-action delete-ability-btn" data-id="${a.id}" title="Delete">🗑</button>
              </div>
            </div>
            <p class="ability-description">${escapeHtml(a.description || '')}</p>
          </div>
        `).join('');

    return `
      <div class="modal-tabs">
        <button type="button" class="tab-button active" data-tab="system">System</button>
        <button type="button" class="tab-button" data-tab="user">My Abilities</button>
      </div>
      <div id="abilities-tab-system" class="tab-content active">
        <div class="abilities-list">${systemList}</div>
      </div>
      <div id="abilities-tab-user" class="tab-content">
        <div class="abilities-actions">
          <button type="button" class="button button-primary new-ability-button">New Ability</button>
        </div>
        <div class="abilities-list">${userList}</div>
      </div>
      <footer slot="footer">
        <button type="button" class="button button-secondary">Close</button>
      </footer>
    `;
  }

  mounted() {
    super.mounted();

    document.addEventListener('show-modal', (event) => {
      if (event.detail.modal === 'abilities') {
        this.openModal();
      }
    });
  }
}

// Register component using Mythix UI pattern
HeroModalAbilities.register();
