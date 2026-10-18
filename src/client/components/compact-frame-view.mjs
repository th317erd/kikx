'use strict';

// Builds the native <details>/<summary> disclosure used by compact status and
// tool frames. Expansion is handled by the browser; this module only owns the
// DOM structure and in-place summary text updates.

import { elements } from '../lib/aeor-ui.mjs';
import { setIcon } from '../lib/icons.mjs';
import { compactFrameSummary } from './tool-frame-summary.mjs';

const { code, details, div, span, summary } = elements;

export function buildCompactFrameDisclosure(frame, bodyNodes, ownerDocument) {
  let view = buildCompactSummary(frame, ownerDocument);
  let body = div.class('kikx-frame__compact-body')(...(bodyNodes || [])).build(ownerDocument);
  let element = details.class('kikx-frame__compact')(view.element, body).build(ownerDocument);

  return {
    element,
    body,
    summary: view.element,
    description: view.description,
    icon: view.icon,
    iconName: view.iconName,
    descriptionText: view.descriptionText,
    codeText: view.codeText,
  };
}

export function updateCompactSummary(view, frame) {
  if (!view)
    return;

  let data = compactFrameSummary(frame);
  let descriptionText = data.description || '';
  let codeText = data.code || '';

  if (view.descriptionText !== descriptionText || view.codeText !== codeText) {
    let ownerDocument = view.element.ownerDocument || document;
    renderDescription(view.description, descriptionText, codeText, ownerDocument);
    view.descriptionText = descriptionText;
    view.codeText = codeText;
  }

  let iconName = data.icon || 'diamond';
  if (view.iconName !== iconName) {
    setIcon(view.icon, iconName, { ownerDocument: view.element.ownerDocument || document });
    view.iconName = iconName;
  }
}

function buildCompactSummary(frame, ownerDocument) {
  let data = compactFrameSummary(frame);
  let element = summary.class('kikx-frame__compact-summary').build(ownerDocument);
  let description = span.class('kikx-frame__compact-description').build(ownerDocument);
  let icon = span.class('kikx-frame__compact-icon').build(ownerDocument);

  let iconName = data.icon || 'diamond';
  icon.setAttribute('aria-hidden', 'true');
  renderDescription(description, data.description || '', data.code || '', ownerDocument);
  setIcon(icon, iconName, { ownerDocument });

  element.appendChild(icon);
  element.appendChild(description);

  return {
    element,
    description,
    icon,
    iconName,
    descriptionText: data.description || '',
    codeText: data.code || '',
  };
}

function renderDescription(element, description, codeText, ownerDocument) {
  while (element.firstChild)
    element.removeChild(element.firstChild);

  if (!codeText) {
    element.textContent = description;
    return;
  }

  let index = description.lastIndexOf(codeText);
  if (index === -1)
    index = description.indexOf(codeText);

  if (index === -1) {
    element.textContent = description;
    return;
  }

  let before = description.slice(0, index);
  let after = description.slice(index + codeText.length);

  if (before)
    element.appendChild(ownerDocument.createTextNode(before));

  element.appendChild(code(codeText).build(ownerDocument));

  if (after)
    element.appendChild(ownerDocument.createTextNode(after));
}
