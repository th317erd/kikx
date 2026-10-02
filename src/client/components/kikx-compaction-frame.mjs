'use strict';

import { elements, $ } from '../lib/aeor-ui.mjs';
import { postJSON } from './kikx-data.mjs';
import {
  compactionCardClass,
  compactionErrors,
  compactionRetryable,
  compactionRetryURL,
  compactionStatusClass,
  compactionSummaryLine,
  compactionWarnings,
  normalizeCompactionStatus,
} from './kikx-compaction-frame-helpers.mjs';

const { div, span, strong, p, details, summary, pre, ul, li, button } = elements;

export class KikxCompactionFrame extends HTMLElement {
  constructor() {
    super();
    this._frame = null;
    this._appState = null;
    this._retrying = false;
    this._retryError = '';
  }

  set frame(frame) {
    this.updateFrame(frame);
  }

  get frame() {
    return this._frame;
  }

  set appState(appState) {
    this._appState = appState || {};
  }

  get appState() {
    return this._appState;
  }

  updateFrame(frame, appState = {}) {
    this._frame = frame || null;
    this._appState = appState || {};
    // A repaint (for example the retry's `frame.updated`) clears the busy state;
    // the new frame is the authoritative result.
    this._retrying = false;
    this._retryError = '';
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

    let content = frame.content || {};
    let rawStatus = content.status || frame.compaction?.status;
    let status = normalizeCompactionStatus(rawStatus);
    let frameCount = Number(content.frameCount || frame.compaction?.frameCount || 0);
    let summaryText = content.summary || '';
    let warnings = compactionWarnings(content);
    let errors = compactionErrors(content);
    let hasDetails = summaryText !== '' || warnings.length > 0 || errors.length > 0;

    $(this).empty();
    this.className = compactionCardClass(rawStatus);

    this.appendChild(
      div.class('kikx-tool-card__inner')(
        div.class('kikx-tool-card__header')(
          span.class('kikx-tool-card__badge')('Compaction'),
          strong('Context compaction'),
          span.class(`kikx-tool-card__status ${compactionStatusClass(rawStatus)}`)(status),
        ),
        div.class('kikx-tool-card__summary')(compactionSummaryLine({ status: rawStatus, frameCount, content })),
        div.class('kikx-tool-card__facts')(
          frameCount > 0 ? span(`${frameCount} frame${frameCount === 1 ? '' : 's'}`) : null,
          content.boundaryFrameID ? span(`Boundary ${content.boundaryFrameID}`) : null,
        ),
        status === 'error' && errors.length === 0
          ? p.class('kikx-tool-card__message kikx-tool-card__message--error')(content.text || 'Compaction failed.')
          : null,
        hasDetails ? details.class('kikx-tool-card__details')(
          summary(status === 'success' ? 'Compacted memory' : 'Details'),
          warnings.length > 0
            ? ul.class('kikx-compaction-card__issues kikx-compaction-card__issues--warning')(
              ...warnings.map((warning) => li(warning.message)),
            )
            : null,
          errors.length > 0
            ? ul.class('kikx-compaction-card__issues kikx-compaction-card__issues--error')(
              ...errors.map((error) => li(error.message)),
            )
            : null,
          summaryText ? pre.class('kikx-tool-card__pre')(summaryText) : null,
        ) : null,
        this._buildRetryRow(rawStatus, frame),
      ).build(document),
    );
  }

  _buildRetryRow(rawStatus, frame) {
    if (!compactionRetryable(rawStatus))
      return null;

    return div.class('kikx-compaction-card__actions')(
      this._retryError
        ? span.class('kikx-compaction-card__retry-error')(this._retryError)
        : null,
      button
        .type('button')
        .class('kikx-inline-action kikx-compaction-card__retry')
        .disabled(this._retrying)
        .onClick(() => this._retry(frame))(
          this._retrying ? 'Retrying...' : 'Retry compaction',
        ),
    );
  }

  async _retry(frame) {
    if (this._retrying)
      return;

    let sessionID = frame.sessionID || this._appState?.selectedSessionID;
    if (!sessionID)
      return;

    this._retrying = true;
    this._retryError = '';
    this.render();

    try {
      await postJSON({ _state: this._appState || {} }, compactionRetryURL(sessionID, frame.id), {});
      // Success: the server emits `frame.updated` for the same frame id and the
      // normal runtime path repaints this bubble in place. If no event arrives
      // the button returns to its idle state on the next render.
      this._retrying = false;
      this.render();
    } catch (error) {
      this._retrying = false;
      this._retryError = error?.message || 'Retry failed.';
      this.render();
    }
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-compaction-frame'))
  customElements.define('kikx-compaction-frame', KikxCompactionFrame);
