'use strict';

import { elements, $ } from '../lib/aeor-ui.mjs';

const { div, span, strong, p, details, summary, pre } = elements;

export class KikxCompactionFrame extends HTMLElement {
  constructor() {
    super();
    this._frame = null;
    this._appState = null;
  }

  set frame(frame) {
    this.updateFrame(frame);
  }

  get frame() {
    return this._frame;
  }

  updateFrame(frame, appState = {}) {
    this._frame = frame || null;
    this._appState = appState || {};
    this.render();
  }

  connectedCallback() {
    if (this._frame && this.childNodes.length === 0)
      this.render();
  }

  render() {
    let frame = this._frame;
    if (!frame)
      return;

    $(this).empty();
    this.className = 'kikx-tool-card kikx-compaction-card';

    let content = frame.content || {};
    let status = normalizeStatus(content.status || frame.compaction?.status);
    let frameCount = Number(content.frameCount || frame.compaction?.frameCount || 0);
    let summaryText = content.summary || '';

    this.appendChild(
      div.class('kikx-tool-card__inner')(
        div.class('kikx-tool-card__header')(
          span.class('kikx-tool-card__badge')('Compaction'),
          strong('Context compaction'),
          span.class(`kikx-tool-card__status kikx-tool-card__status--${status}`)(status),
        ),
        div.class('kikx-tool-card__summary')(summaryLine({ status, frameCount, content })),
        div.class('kikx-tool-card__facts')(
          frameCount > 0 ? span(`${frameCount} frame${frameCount === 1 ? '' : 's'}`) : null,
          content.boundaryFrameID ? span(`Boundary ${content.boundaryFrameID}`) : null,
        ),
        summaryText ? details.class('kikx-tool-card__details')(
          summary('Compacted memory'),
          pre.class('kikx-tool-card__pre')(summaryText),
        ) : null,
        status === 'error' ? p.class('kikx-tool-card__message kikx-tool-card__message--error')(content.text || 'Compaction failed.') : null,
      ).build(document),
    );
  }
}

function normalizeStatus(status) {
  if (status === 'complete' || status === 'success')
    return 'success';

  if (status === 'failed' || status === 'error')
    return 'error';

  return 'running';
}

function summaryLine({ status, frameCount, content }) {
  if (status === 'success') {
    if (frameCount > 0)
      return `Compaction complete. ${frameCount} frame${frameCount === 1 ? '' : 's'} compressed.`;

    return content.text || 'Nothing to compact.';
  }

  if (status === 'error')
    return content.text || 'Compaction failed.';

  if (frameCount > 0)
    return `Compacting session context across ${frameCount} frame${frameCount === 1 ? '' : 's'}...`;

  return content.text || 'Compacting session context...';
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-compaction-frame'))
  customElements.define('kikx-compaction-frame', KikxCompactionFrame);

