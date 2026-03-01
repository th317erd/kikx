'use strict';

const TEMPLATE_HTML = `
  <style>
    :host {
      display: none;
    }
  </style>
`;

let cachedTemplate = null;

function getTemplate() {
  if (!cachedTemplate) {
    cachedTemplate = document.createElement('template');
    cachedTemplate.innerHTML = TEMPLATE_HTML;
  }

  return cachedTemplate;
}

class KikxWebsocketManager extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this._url              = '';
    this._connected        = false;
    this._reconnectDelay   = 1000;
    this._maxReconnectDelay = 30000;
    this._currentDelay     = this._reconnectDelay;
    this._reconnectTimer   = null;
    this._socket           = null;
  }

  // ---------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------

  get url() {
    return this._url;
  }

  set url(value) {
    let previousUrl = this._url;
    this._url = value;

    if (this._connected && value !== previousUrl)
      this.connect();
  }

  get connected() {
    return this._connected;
  }

  get reconnectDelay() {
    return this._reconnectDelay;
  }

  set reconnectDelay(value) {
    this._reconnectDelay = value;
    this._currentDelay   = value;
  }

  get maxReconnectDelay() {
    return this._maxReconnectDelay;
  }

  set maxReconnectDelay(value) {
    this._maxReconnectDelay = value;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  connectedCallback() {
    this.shadowRoot.appendChild(getTemplate().content.cloneNode(true));

    if (this._url)
      this.connect();
  }

  disconnectedCallback() {
    this.disconnect();
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  connect() {
    if (this._socket)
      this.disconnect();

    let socket = new WebSocket(this._url);

    socket.onopen = () => {
      this._connected  = true;
      this._currentDelay = this._reconnectDelay;

      this.dispatchEvent(new CustomEvent('ws-open', {
        bubbles:  true,
        composed: true,
      }));
    };

    socket.onclose = (event) => {
      this._connected = false;

      this.dispatchEvent(new CustomEvent('ws-close', {
        bubbles:  true,
        composed: true,
        detail:   { code: event.code },
      }));

      this._scheduleReconnect();
    };

    socket.onerror = (error) => {
      this.dispatchEvent(new CustomEvent('ws-error', {
        bubbles:  true,
        composed: true,
        detail:   { error },
      }));
    };

    socket.onmessage = (event) => {
      let parsedData;

      try {
        parsedData = JSON.parse(event.data);
      } catch (_error) {
        parsedData = event.data;
      }

      this.dispatchEvent(new CustomEvent('ws-message', {
        bubbles:  true,
        composed: true,
        detail:   { data: parsedData },
      }));
    };

    this._socket = socket;
  }

  disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this._socket) {
      this._socket.onopen    = null;
      this._socket.onclose   = null;
      this._socket.onerror   = null;
      this._socket.onmessage = null;
      this._socket.close();
      this._socket = null;
    }

    this._connected    = false;
    this._currentDelay = this._reconnectDelay;
  }

  send(data) {
    if (!this._connected || !this._socket)
      return;

    this._socket.send(JSON.stringify(data));
  }

  // ---------------------------------------------------------------------------
  // Reconnection (exponential backoff)
  // ---------------------------------------------------------------------------

  _scheduleReconnect() {
    if (this._reconnectTimer)
      clearTimeout(this._reconnectTimer);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, this._currentDelay);

    this._currentDelay = Math.min(this._currentDelay * 2, this._maxReconnectDelay);
  }
}

if (typeof customElements !== 'undefined')
  customElements.define('kikx-websocket-manager', KikxWebsocketManager);

export default KikxWebsocketManager;
