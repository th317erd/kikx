'use strict';

// A plugin view surface: one labelled textarea carrying a stable focus key.
//
// It deliberately does NOT mark itself with `data-kikx-view-surface`. The shell
// sets that attribute when it creates the surface (client-view-surfaces.mjs), so
// the focus contract holds for every plugin view whether or not its author knew
// about it. A fixture that set the marker itself would prove the fixture, not the
// framework -- and would keep passing if the shell stopped emitting it.
//
// It renders once: a view that rebuilt its own inner nodes on every resolve would
// lose focus for a reason unrelated to the shell, which is not what this measures.

class FocusProbeView extends HTMLElement {
  connectedCallback() {
    if (this.childElementCount > 0)
      return;

    let label = document.createElement('label');
    label.textContent = 'Note';

    let input = document.createElement('textarea');
    input.dataset.kikxFocusKey = 'note-body';
    input.value = '';
    label.appendChild(input);

    this.appendChild(label);
  }
}

if (!customElements.get('kikx-focus-probe-view'))
  customElements.define('kikx-focus-probe-view', FocusProbeView);
