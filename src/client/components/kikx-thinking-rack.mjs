'use strict';

import './kikx-thinking-panel.mjs';

// Bottom-left rack of per-agent thinking panels, stacked horizontally. Pinned in
// the "participant space" (lower left): the operator will live on the right, so
// other participants' activity reads naturally from the left edge.
export class KikxThinkingRack extends HTMLElement {
  constructor() {
    super();
    this._panels = new Map();
  }

  get thinkingIDs() {
    return [ ...this._panels.keys() ];
  }

  // `agents` is an ordered list of { id, agentID, name, text }.
  update(agents = []) {
    let list = Array.isArray(agents) ? agents : [];
    let seen = new Set();

    for (let agent of list) {
      if (!agent?.id)
        continue;

      seen.add(agent.id);
      let panel = this._panels.get(agent.id);
      if (!panel) {
        panel = document.createElement('kikx-thinking-panel');
        panel.dataset.thinkingId = agent.id;
        this._panels.set(agent.id, panel);
      }

      // appendChild both connects a new panel (so setEntry can paint) and
      // re-inserts existing ones in the current order.
      this.appendChild(panel);
      panel.setEntry({ name: agent.name, text: agent.text });
    }

    for (let [ id, panel ] of [ ...this._panels ]) {
      if (!seen.has(id)) {
        panel.remove();
        this._panels.delete(id);
      }
    }

    this.hidden = list.length === 0;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-thinking-rack'))
  customElements.define('kikx-thinking-rack', KikxThinkingRack);
