'use strict';

import { elements, cleanupBindings } from '../lib/aeor-ui.mjs';
import { OCR_IMAGE_PROXY_PREFERENCE } from '../../shared/session-preferences.mjs';
import { getSessionPreference } from '../state/kikx-state.mjs';

const { div, p, span, strong } = elements;
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;

const FALLBACK_IMAGE = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <rect width="960" height="540" fill="#11161b"/>
  <rect x="18" y="18" width="924" height="504" rx="12" fill="#171d23" stroke="#3a444e" stroke-width="2"/>
  <text x="480" y="258" text-anchor="middle" fill="#aeb8c2" font-family="system-ui,sans-serif" font-size="28">Image failed to load</text>
  <text x="480" y="296" text-anchor="middle" fill="#76818c" font-family="system-ui,sans-serif" font-size="18">The OCR frame could not retrieve this image.</text>
</svg>`)}`;

export class KikxOcrFrame extends HTMLElement {
  constructor() {
    super();
    this._frame = null;
    this._appState = null;
    this._objectURLs = [];
    this._loadToken = 0;
    this._resultText = '';
    this._resultAgent = '';
    this._resultError = '';
    this._resultLoading = false;
    this._rendered = false;
  }

  connectedCallback() {
    if (!this._rendered)
      this.render();
  }

  disconnectedCallback() {
    this._loadToken++;
    this._releaseObjectURLs();
    cleanupBindings(this);
  }

  set frame(frame) {
    this.updateFrame(frame);
  }

  get frame() {
    return this._frame;
  }

  updateFrame(frame, appState = this._appState) {
    this._frame = frame || null;
    this._appState = appState || {};
    this._rendered = true;
    this._loadToken++;
    this._releaseObjectURLs();
    this.render();
    this.loadResult(this._loadToken);
    this.loadImages(this._loadToken);
  }

  get content() {
    return this._frame?.content || {};
  }

  get input() {
    return this.content.input && typeof this.content.input === 'object' ? this.content.input : {};
  }

  get sessionID() {
    return this._frame?.sessionID || this._appState?.selectedSessionID || '';
  }

  get images() {
    return Array.isArray(this.input.images)
      ? this.input.images.filter((image) => typeof image === 'string' && image.trim() !== '')
      : [];
  }

  render() {
    cleanupBindings(this);
    let question = typeof this.input.prompt === 'string' ? this.input.prompt.trim() : '';
    let imageNodes = this.images.map((image, index) => this.renderImage(image, index));

    let asker = this._frame?.authorDisplayName || this._frame?.authorID || '';
    this.replaceChildren(
      div.class('kikx-ocr-frame')(
        div.class('kikx-ocr-frame__question')(
          div.class('kikx-ocr-frame__label')(asker ? `Question from ${asker}` : 'Question'),
          p.class('kikx-ocr-frame__question-text')(question || 'OCR request'),
        ),
        div.class('kikx-ocr-frame__images')(
          imageNodes.length > 0
            ? imageNodes
            : p.class('kikx-ocr-frame__empty')('No image path was provided.'),
        ),
        div.class('kikx-ocr-frame__response')(
          div.class('kikx-ocr-frame__label')(
            this._resultAgent ? `OCR response from ${this._resultAgent}` : 'OCR response',
          ),
          p.class('kikx-ocr-frame__response-text')(
            this._resultError
              ? this._resultError
              : this._resultLoading
                ? 'Loading OCR response…'
                : this._resultText || 'No OCR response yet.',
          ),
        ),
      ).build(document),
    );
  }

  renderImage(imagePath, index) {
    let figure = document.createElement('figure');
    figure.className = 'kikx-ocr-frame__image-card';

    let image = document.createElement('img');
    image.className = 'kikx-ocr-frame__image';
    image.alt = `OCR image ${index + 1}`;
    image.loading = 'lazy';
    image.src = FALLBACK_IMAGE;
    figure.appendChild(image);

    let caption = document.createElement('figcaption');
    caption.className = 'kikx-ocr-frame__caption';
    caption.textContent = imagePath;
    caption.title = imagePath;
    figure.appendChild(caption);
    return figure;
  }

  async loadImages(token) {
    let images = this.images;
    if (images.length === 0)
      return;

    let cards = [ ...this.querySelectorAll('.kikx-ocr-frame__image') ];
    await Promise.all(images.map(async (imagePath, index) => {
      if (token !== this._loadToken)
        return;
      let image = cards[index];
      if (!image)
        return;

      if (getSessionPreference(this._appState, this.sessionID, OCR_IMAGE_PROXY_PREFERENCE, true) === false) {
        image.src = FALLBACK_IMAGE;
        image.title = 'Image proxy disabled by session preference';
        return;
      }

      try {
        let url = new URL('/api/v1/image-proxy', globalThis.location?.origin || 'http://localhost');
        url.searchParams.set('path', imagePath);
        if (this.sessionID)
          url.searchParams.set('session_id', this.sessionID);
        let response = await fetch(url, { headers: authHeaders(this._appState) });
        if (!response.ok)
          throw new Error(`HTTP ${response.status}`);
        let blob = await response.blob();
        if (!blob.type.startsWith('image/'))
          throw new Error('Proxy did not return an image');
        if (token !== this._loadToken)
          return;
        let objectURL = URL.createObjectURL(blob);
        this._objectURLs.push(objectURL);
        image.src = objectURL;
        let status = response.headers.get('X-Kikx-Image-Proxy');
        if (status === 'disabled')
          image.title = 'Image proxy disabled by session preference';
      } catch (error) {
        if (token !== this._loadToken)
          return;
        image.src = FALLBACK_IMAGE;
        image.title = error?.message || 'Image failed to load';
      }
    }));
  }

  async loadResult(token) {
    let direct = resultFromContent(this.content);
    if (direct) {
      this.applyResult(direct);
      return;
    }

    let outputID = this.content.toolOutputID
      || this.content.retrieval?.getRange?.arguments?.id
      || this.content.retrieval?.getAll?.arguments?.id
      || '';
    if (!outputID) {
      this._resultLoading = false;
      this._resultError = this.content.error?.message || this.content.error || '';
      this.render();
      return;
    }

    this._resultLoading = true;
    this.render();
    try {
      let url = new URL(`/api/v1/tool-outputs/${encodeURIComponent(outputID)}`, globalThis.location?.origin || 'http://localhost');
      url.searchParams.set('maxBytes', String(DEFAULT_OUTPUT_BYTES));
      let response = await fetch(url, { headers: authHeaders(this._appState) });
      let body = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(body?.error?.message || `HTTP ${response.status}`);
      if (token !== this._loadToken)
        return;
      let result = resultFromOutput(body?.data?.output);
      this.applyResult(result || { text: body?.data?.output?.content || '' });
    } catch (error) {
      if (token !== this._loadToken)
        return;
      this._resultLoading = false;
      this._resultError = error?.message || 'Unable to load OCR response';
      this.render();
    }
  }

  applyResult(result = {}) {
    this._resultLoading = false;
    this._resultText = typeof result.text === 'string' ? result.text : '';
    this._resultAgent = typeof result.agentName === 'string' ? result.agentName : '';
    this._resultError = typeof result.error === 'string'
      ? result.error
      : result.error?.message || '';
    this.render();
  }

  _releaseObjectURLs() {
    for (let url of this._objectURLs) {
      try {
        URL.revokeObjectURL(url);
      } catch (_error) {}
    }
    this._objectURLs = [];
  }
}

function authHeaders(appState = {}) {
  return appState?.authToken ? { Authorization: `Bearer ${appState.authToken}` } : {};
}

function resultFromContent(content = {}) {
  if (content.result && typeof content.result === 'object')
    return normalizeResult(content.result);
  if (typeof content.preview === 'string') {
    try {
      return resultFromOutput(JSON.parse(content.preview));
    } catch (_error) {}
  }
  return null;
}

function normalizeResult(value = {}) {
  if (value?.result && typeof value.result === 'object' && !value.text)
    return value.result;
  return value;
}

function resultFromOutput(output = {}) {
  if (!output)
    return null;
  if (output.format === 'json' || typeof output.content === 'string') {
    try {
      let parsed = JSON.parse(output.content || 'null');
      return normalizeResult(parsed?.result && typeof parsed.result === 'object' ? parsed.result : parsed);
    } catch (_error) {}
  }

  return output.result && typeof output.result === 'object' ? output.result : output;
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-ocr-frame'))
  customElements.define('kikx-ocr-frame', KikxOcrFrame);
