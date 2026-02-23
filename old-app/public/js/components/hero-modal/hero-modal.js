'use strict';

/**
 * Hero Modal Base Class
 *
 * Extends MythixUIModal with dynamic shadow DOM creation.
 * All other hero-modal-* components extend this base class.
 */

import { MythixUIModal } from '@cdn/mythix-ui-modal@1';
import { DynamicProperty, Utils } from '@cdn/mythix-ui-core@1';

// ============================================================================
// Global State Access
// ============================================================================

export const GlobalState = {
  user: Utils.dynamicPropID('heroUser', null),
  sessions: Utils.dynamicPropID('heroSessions', []),
  agents: Utils.dynamicPropID('heroAgents', []),
  abilities: Utils.dynamicPropID('heroAbilities', { system: [], user: [] }),
  currentSession: Utils.dynamicPropID('heroCurrentSession', null),
  wsConnected: Utils.dynamicPropID('heroWsConnected', false),
  globalSpend: Utils.dynamicPropID('heroGlobalSpend', { cost: 0, inputTokens: 0, outputTokens: 0 }),
  showHiddenSessions: Utils.dynamicPropID('heroShowHiddenSessions', false),
};

// ============================================================================
// Helper Functions
// ============================================================================

export function escapeHtml(text) {
  if (!text) return '';
  let div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================================
// Shared Shadow DOM Styles
// ============================================================================

export const MODAL_STYLES = `
  /* Base dialog styles */
  dialog[open], dialog > * {
    position: relative;
    display: flex;
    box-sizing: border-box;
  }

  dialog > * {
    padding: var(--theme-padding, 1rem);
  }

  dialog[open] {
    flex-direction: column;
    padding: 0;
    align-items: stretch;
    overflow: hidden;
    min-width: min(400px, calc(100vw - 32px));
    max-width: min(600px, calc(100vw - 32px));
    max-height: 85vh;
    border: 1px solid var(--border-color, #2d2d2d);
    border-radius: var(--radius-lg, 8px);
    background: var(--bg-secondary, #1a1a2e);
    color: var(--text-primary, #e0e0e0);
  }

  dialog::backdrop {
    background-color: rgba(0, 0, 0, 0.7);
  }

  dialog > header {
    flex-direction: row;
    flex-shrink: 0;
    flex-grow: 0;
    user-select: none;
    border-bottom: 1px solid var(--border-color, #2d2d2d);
    background: var(--bg-tertiary, #2a2a3e);
  }

  dialog > header .caption-container {
    display: flex;
    flex-grow: 1;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
  }

  dialog > main {
    flex-direction: column;
    flex-shrink: 1;
    flex-grow: 1;
    padding-top: 0;
    padding-bottom: 0;
    overflow: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--bg-tertiary, #2a2a3e) var(--bg-primary, #0f0f1a);
  }

  dialog > main::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  dialog > main::-webkit-scrollbar-track {
    background: var(--bg-primary, #0f0f1a);
  }

  dialog > main::-webkit-scrollbar-thumb {
    background: var(--bg-tertiary, #2a2a3e);
    border-radius: 4px;
  }

  dialog > main::-webkit-scrollbar-thumb:hover {
    background: var(--accent, #e94560);
  }

  dialog > footer {
    flex-direction: row;
    flex-shrink: 0;
    flex-grow: 0;
    user-select: none;
    align-items: center;
    justify-content: flex-end;
    border-top: 1px solid var(--border-color, #2d2d2d);
    background: var(--bg-tertiary, #2a2a3e);
    gap: var(--theme-padding, 0.5em);
  }

  /* Form elements in slotted content */
  ::slotted(.error-message) {
    margin-top: 12px;
    padding: 10px;
    border-radius: var(--radius-sm, 4px);
    background: rgba(248, 113, 113, 0.1);
    color: var(--error, #f87171);
    font-size: 14px;
  }

  ::slotted(.error-message:empty) {
    display: none;
  }
`;

// ============================================================================
// HeroModal Base Class
// ============================================================================

/**
 * Base class for Hero modal components.
 * Creates shadow DOM dynamically rather than using templates.
 */
export class HeroModal extends MythixUIModal {
  static tagName = 'hero-modal';

  // Skip template lookup - we create shadow DOM dynamically
  static SKIP_TEMPLATE = true;

  _errorMessage = '';

  get error() {
    return this._errorMessage;
  }

  set error(message) {
    this._errorMessage = message;
    this._updateError();
  }

  get modalTitle() {
    return 'Modal';
  }

  /**
   * Get additional styles for this modal variant.
   * Override in subclass to add custom styles.
   */
  getAdditionalStyles() {
    return '';
  }

  /**
   * Override connectedCallback to create shadow DOM manually.
   */
  connectedCallback() {
    // Create shadow root if not exists
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
    }

    // Build shadow DOM content
    this._buildShadowDOM();

    // Set component name attribute
    this.setAttribute('data-mythix-component-name', this.sensitiveTagName || this.tagName.toLowerCase());

    // Process light DOM elements
    if (this.processElements) {
      this.processElements(this);
    }

    // Use queueMicrotask to ensure DOM is ready before mounted()
    queueMicrotask(() => {
      try {
        this.mounted();
      } catch (error) {
        console.error(`Error in mounted() for ${this.tagName}:`, error);
      }
      this.documentInitialized = true;
    });
  }

  /**
   * Build the shadow DOM content.
   */
  _buildShadowDOM() {
    let additionalStyles = this.getAdditionalStyles();

    this.shadowRoot.innerHTML = `
      <style>
        ${MODAL_STYLES}
        ${additionalStyles}
      </style>
      <dialog class="root-container" part="dialog root">
        <header part="header">
          <div class="caption-container" part="caption-container">
            <slot name="caption">
              <span part="caption">${escapeHtml(this.modalTitle)}</span>
            </slot>
          </div>
        </header>
        <main part="main">
          <slot></slot>
        </main>
        <footer part="footer">
          <slot name="footer"></slot>
        </footer>
      </dialog>
    `;
    // Note: $dialog is a getter from parent class, no need to set it
  }

  mounted() {
    // Render content into slots
    this._renderContent();

    // Handle backdrop click to close
    if (this.$dialog) {
      this.$dialog.addEventListener('click', (event) => {
        if (event.target === this.$dialog) {
          this.close();
        }
      });
    }
  }

  async openModal() {
    this._errorMessage = '';

    let onOpenResult = this.onOpen();
    if (onOpenResult instanceof Promise) {
      onOpenResult = await onOpenResult;
    }
    if (onOpenResult === false) return;

    // Re-render content before opening
    this._renderContent();

    // Update title
    let titleSpan = this.shadowRoot?.querySelector('header [part="caption"]');
    if (titleSpan) {
      titleSpan.textContent = this.modalTitle;
    }

    // Show the component
    this.style.display = '';

    // Call dialog.showModal()
    if (this.$dialog && typeof this.$dialog.showModal === 'function') {
      this.$dialog.showModal();
    }

    // Focus first input
    requestAnimationFrame(() => {
      let firstInput = this.querySelector('input, select, textarea');
      if (firstInput) firstInput.focus();
    });
  }

  close(returnValue) {
    if (this.$dialog && this.$dialog.open) {
      this.$dialog.close(returnValue);
    }
    this.style.display = 'none';
    this.onClose();
  }

  onOpen() {}
  onClose() {}

  async handleSubmit(event) {
    event.preventDefault();
  }

  _renderContent() {
    let content = this.getContent();

    let template = document.createElement('template');
    template.innerHTML = content;

    let footer = template.content.querySelector('footer[slot="footer"], [slot="footer"]');

    // Clear current content
    this.innerHTML = '';

    // Add main content (everything except footer)
    let mainContent = document.createElement('div');
    for (let child of Array.from(template.content.childNodes)) {
      if (child !== footer) {
        mainContent.appendChild(child.cloneNode(true));
      }
    }

    // Add error message container
    let errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    mainContent.appendChild(errorDiv);

    this.appendChild(mainContent);

    // Add footer if present
    if (footer) {
      let footerClone = footer.cloneNode(true);
      footerClone.setAttribute('slot', 'footer');
      this.appendChild(footerClone);
    }

    // Bind form submit
    let form = this.querySelector('form');
    if (form) {
      form.addEventListener('submit', (event) => this.handleSubmit(event));
    }

    // Bind close buttons in footer
    let closeButtons = this.querySelectorAll('[slot="footer"] button[type="button"]');
    for (let button of closeButtons) {
      button.addEventListener('click', () => this.close());
    }

    // Bind submit buttons in footer (since they're outside the form)
    let submitButtons = this.querySelectorAll('[slot="footer"] button[type="submit"]');
    for (let button of submitButtons) {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        if (form) {
          // Trigger form validation and submit
          if (form.reportValidity()) {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          }
        } else {
          // No form, call handleSubmit directly
          this.handleSubmit(event);
        }
      });
    }
  }

  _updateError() {
    let errorElement = this.querySelector('.error-message');
    if (errorElement) {
      errorElement.textContent = this._errorMessage;
    }
  }

  setGlobal(key, value) {
    if (GlobalState[key]) {
      GlobalState[key][DynamicProperty.set](value);
    }
  }

  getContent() {
    return '';
  }
}

// Export DynamicProperty for child classes
export { DynamicProperty };
