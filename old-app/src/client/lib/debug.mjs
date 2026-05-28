'use strict';

// Client-side debug mode for inspecting interaction frame metadata.
// Stores per-element metadata in a WeakMap keyed by interaction elements.
// Usage: __kikxDebug.enable() in browser console, then interact, then __kikxDebug.list()

let _enabled          = false;
const _elementMeta    = new WeakMap();   // HTMLElement -> metadata object
const _interactionMap = new Map();       // interactionID -> HTMLElement[]

export function init() {
  try {
    let stored = localStorage.getItem('kikx_debug');
    if (stored === 'true')
      _enabled = true;
  } catch (_error) {
    // localStorage unavailable
  }
}

export function enable() {
  _enabled = true;

  try {
    localStorage.setItem('kikx_debug', 'true');
  } catch (_error) {
    // localStorage unavailable
  }
}

export function disable() {
  _enabled = false;

  try {
    localStorage.removeItem('kikx_debug');
  } catch (_error) {
    // localStorage unavailable
  }
}

export function isEnabled() {
  return _enabled;
}

export function trackElement(interactionID, element) {
  if (!_enabled)
    return;

  let metadata = {
    interactionID,
    frames:         [],
    streamingHTML:   '',
    reflectionText: '',
    composedHTML:    '',
    composedAt:     null,
    createdAt:      new Date().toISOString(),
  };

  _elementMeta.set(element, metadata);

  let elements = _interactionMap.get(interactionID);
  if (!elements) {
    elements = [];
    _interactionMap.set(interactionID, elements);
  }

  elements.push(element);
}

export function pushFrame(interactionID, frame) {
  if (!_enabled)
    return;

  let elements = _interactionMap.get(interactionID);
  if (!elements)
    return;

  let cloned = structuredClone(frame);

  for (let element of elements) {
    let metadata = _elementMeta.get(element);
    if (metadata)
      metadata.frames.push(cloned);
  }
}

export function setStreamDelta(interactionID, html) {
  if (!_enabled)
    return;

  let elements = _interactionMap.get(interactionID);
  if (!elements)
    return;

  for (let element of elements) {
    let metadata = _elementMeta.get(element);
    if (metadata)
      metadata.streamingHTML = html;
  }
}

export function setReflectionDelta(interactionID, text) {
  if (!_enabled)
    return;

  let elements = _interactionMap.get(interactionID);
  if (!elements)
    return;

  for (let element of elements) {
    let metadata = _elementMeta.get(element);
    if (metadata)
      metadata.reflectionText = text;
  }
}

export function snapshotComposed(interactionID) {
  if (!_enabled)
    return;

  let elements = _interactionMap.get(interactionID);
  if (!elements)
    return;

  let timestamp = new Date().toISOString();

  for (let element of elements) {
    let metadata = _elementMeta.get(element);
    if (metadata) {
      metadata.composedHTML = element.innerHTML || '';
      metadata.composedAt  = timestamp;
    }
  }
}

export function getMetadata(element) {
  return _elementMeta.get(element) || null;
}

export function getByInteractionID(interactionID) {
  let elements = _interactionMap.get(interactionID);
  if (!elements)
    return [];

  let results = [];

  for (let element of elements) {
    let metadata = _elementMeta.get(element);
    if (metadata)
      results.push({ element, metadata });
  }

  return results;
}

export function getAllTracked() {
  let results = [];

  for (let [interactionID, elements] of _interactionMap) {
    for (let element of elements) {
      let metadata = _elementMeta.get(element);
      if (metadata)
        results.push({ interactionID, element, metadata });
    }
  }

  return results;
}

export function reset() {
  _enabled = false;
  _interactionMap.clear();
  // WeakMap has no clear() — entries are GC'd when elements are dereferenced
}

// Always expose global so devs can enable from console at any time
if (typeof window !== 'undefined') {
  window.__kikxDebug = {
    enable,
    disable,
    isEnabled,
    get:     getMetadata,
    getByID: getByInteractionID,
    list:    getAllTracked,
  };
}
