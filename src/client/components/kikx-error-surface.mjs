'use strict';

// S1 error surface: a compact, dismissible "N errors" chip plus an expandable
// list of the bounded recent-errors store. It is intentionally tiny and owns no
// app wiring; `kikx-app` mounts it and the boundary owns the store.

import { clearRecentErrors, listRecentErrors, subscribeToRecentErrors } from '../lib/error-boundary.mjs';

export class KikxErrorSurface extends HTMLElement {
  constructor() {
    super();
    this._expanded = false;
    this._unsubscribe = null;
  }

  connectedCallback() {
    // The host must carry the base class in every mount path (the shell's own
    // surface and the standalone first-render fallback); the stylesheet's
    // `.kikx-error-surface` rule is what makes the chip fixed and visible.
    this.classList.add('kikx-error-surface');
    // Announce the count politely; the expanded list escalates to role=alert.
    this.setAttribute('role', 'status');
    this.setAttribute('aria-live', 'polite');
    if (!this._unsubscribe)
      this._unsubscribe = subscribeToRecentErrors(() => this._render());

    this._render();
  }

  disconnectedCallback() {
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  _render() {
    let errors = listRecentErrors();
    this.textContent = '';
    this.classList.toggle('kikx-error-surface--empty', errors.length === 0);

    if (errors.length === 0)
      return;

    let header = document.createElement('div');
    header.className = 'kikx-error-surface__header';

    let chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'kikx-error-surface__chip';
    chip.setAttribute('aria-expanded', this._expanded ? 'true' : 'false');
    chip.textContent = errors.length === 1 ? '1 error' : `${errors.length} errors`;
    chip.addEventListener('click', () => {
      this._expanded = !this._expanded;
      this._render();
    });
    header.appendChild(chip);

    let dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'kikx-error-surface__dismiss';
    dismiss.title = 'Dismiss errors';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => {
      clearRecentErrors();
      this._expanded = false;
      this._render();
    });
    header.appendChild(dismiss);
    this.appendChild(header);

    if (!this._expanded)
      return;

    let list = document.createElement('ul');
    list.className = 'kikx-error-surface__list';
    list.setAttribute('role', 'alert');
    for (let error of errors) {
      let item = document.createElement('li');
      item.className = 'kikx-error-surface__item';
      item.textContent = error.count > 1 ? `${error.label}: ${error.message} (x${error.count})` : `${error.label}: ${error.message}`;
      list.appendChild(item);
    }
    this.appendChild(list);
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-error-surface'))
  customElements.define('kikx-error-surface', KikxErrorSurface);

export function createErrorSurfaceElement() {
  return document.createElement('kikx-error-surface');
}
