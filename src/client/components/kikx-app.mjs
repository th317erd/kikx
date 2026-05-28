'use strict';

import { elements, ReactiveState, $ } from '../lib/aeor-ui.mjs';

const { div, header, main, section, h1, h2, p, span, button, form, label, textarea, ul, li, strong } = elements;
const aeorInput = elements['aeor-input'];
const aeorCheckbox = elements['aeor-checkbox'];

export class KikxApp extends HTMLElement {
  constructor() {
    super();

    this._state = new ReactiveState({
      aeordbEventsURL: '',
      draft: '',
      includeContext: true,
      status: 'Checking AeorDB event stream...',
      statusKind: 'pending',
    });

    this._onSubmit = this._onSubmit.bind(this);
  }

  connectedCallback() {
    if (this._mounted)
      return;

    this._mounted = true;
    this._render();
    this._loadAeorDBEventsURL();
  }

  _render() {
    $(this).empty();

    let tree = div.class('kikx-shell').context(this)(
      header.class('kikx-topbar')(
        div.class('kikx-brand')(
          span.class('kikx-brand__mark')('K'),
          div.class('kikx-brand__copy')(
            h1('Kikx'),
            p('Agent runner'),
          ),
        ),
        div.class.bindState((state) => `kikx-status kikx-status--${state.statusKind}`, ['statusKind'])(
          span.class('kikx-status__dot')(),
          span.textContent.bindState((state) => state.status, ['status'])(),
        ),
      ),
      main.class('kikx-main')(
        section.class('kikx-sessions')(
          h2('Sessions'),
          ul.class('kikx-session-list')(
            li.class('is-selected')(
              strong('Scratch'),
              span('No frames yet'),
            ),
          ),
        ),
        section.class('kikx-thread')(
          div.class('kikx-thread__header')(
            h2('Scratch'),
            button.type('button').class('kikx-icon-button').title('Create session').onClick(this._openCreateSession)(
              '+',
            ),
          ),
          div.class('kikx-thread__empty')(
            p('Frame queue will render here once the store lands.'),
          ),
          form.class('kikx-composer').onSubmit(this._onSubmit)(
            label.class('kikx-composer__label')('Message'),
            textarea
              .name('message')
              .placeholder('Send an HML prompt or a plain message')
              .value.bindState((state) => state.draft, ['draft'])
              .onInput(this._syncDraft)(),
            div.class('kikx-composer__actions')(
              aeorCheckbox.name('include-context').checked('').onChange(this._syncIncludeContext)(
                'Include session context',
              ),
              button.type('submit').class('kikx-send-button')('Send'),
            ),
          ),
        ),
        section.class('kikx-inspector')(
          h2('Runtime'),
          div.class('kikx-field')(
            label('AeorDB events'),
            aeorInput
              .type('text')
              .readonly('')
              .value.bindState((state) => state.aeordbEventsURL, ['aeordbEventsURL'])(),
          ),
          div.class('kikx-field')(
            label('Context'),
            span.textContent.bindState(
              (state) => state.includeContext ? 'Included' : 'Omitted',
              ['includeContext'],
            )(),
          ),
        ),
      ),
    ).build(document);

    this.appendChild(tree);
  }

  async _loadAeorDBEventsURL() {
    try {
      let response = await fetch('/api/v1/aeordb/events-url?events=entries_created,entries_updated&path_prefix=/kikx');
      let body = await response.json();
      if (!response.ok)
        throw new Error(body?.error?.message || 'Unable to load AeorDB events URL');

      this._state.aeordbEventsURL = body.data.url;
      this._state.status = 'AeorDB event stream configured';
      this._state.statusKind = 'ready';
    } catch (error) {
      this._state.status = error.message;
      this._state.statusKind = 'error';
    }
  }

  _syncDraft(event) {
    this._state.draft = event.target.value;
  }

  _syncIncludeContext(event) {
    this._state.includeContext = event.target.checked;
  }

  _onSubmit(event) {
    event.preventDefault();
    let draft = this._state.draft.trim();
    if (!draft) {
      this._state.status = 'Write a message before sending';
      this._state.statusKind = 'error';
      return;
    }

    this._state.status = 'Message queue is not wired yet';
    this._state.statusKind = 'pending';
  }

  _openCreateSession() {
    let modal = elements['aeor-modal'].title('Create session')(
      p('Session creation will connect once FrameStore lands.'),
    ).build(document);
    modal.addEventListener('close', () => modal.remove());
    modal.open();
  }
}

if (!customElements.get('kikx-app'))
  customElements.define('kikx-app', KikxApp);
