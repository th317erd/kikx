'use strict';

// Builds the native <details>/<summary> disclosure used by compact status and
// tool frames. Expansion is handled by the browser; this module only owns the
// DOM structure and in-place summary text updates.

import { elements } from '../lib/aeor-ui.mjs';
import { compactFrameBodyDescription, compactFrameSummary } from './tool-frame-summary.mjs';
import { renderMarkdownToElement } from '../lib/markdown-renderer.mjs';

const { code, details, div, pre, span, summary } = elements;

export function buildCompactFrameDisclosure(frame, bodyNodes, ownerDocument, options = {}) {
  let view = buildCompactSummary(frame, ownerDocument, options);
  let body = div.class('kikx-frame__compact-body')(...(bodyNodes || [])).build(ownerDocument);
  let element = details.class('kikx-frame__compact')(view.element, body).build(ownerDocument);

  return {
    element,
    body,
    summary: view.element,
    description: view.description,
    descriptionText: view.descriptionText,
    codeText: view.codeText,
    command: view.command,
    commandCode: view.commandCode,
    commandText: view.commandText,
  };
}

export function updateCompactSummary(view, frame, options = {}) {
  if (!view)
    return;

  let data = compactFrameSummary(frame);
  let descriptionText = compactFrameBodyDescription(frame);
  let codeText = data.code || '';

  if (view.descriptionText !== descriptionText || view.codeText !== codeText) {
    let ownerDocument = view.element.ownerDocument || document;
    renderDescription(view.description, descriptionText, codeText, ownerDocument, isMarkdownCompactSummary(frame), options);
    view.descriptionText = descriptionText;
    view.codeText = codeText;
  }

  let commandText = typeof data.command === 'string' ? data.command : '';
  if (view.commandText !== commandText) {
    if (!view.commandCode && commandText) {
      let ownerDocument = view.element.ownerDocument || document;
      let command = buildCommandBlock(commandText, ownerDocument);
      view.element.appendChild(command.pre);
      view.command = command.pre;
      view.commandCode = command.code;
    } else if (view.commandCode) {
      view.commandCode.textContent = commandText;
    }
    view.commandText = commandText;
  }

}

function buildCompactSummary(frame, ownerDocument, options = {}) {
  let data = compactFrameSummary(frame);
  let element = summary.class('kikx-frame__compact-summary').build(ownerDocument);
  let description = span.class('kikx-frame__compact-description').build(ownerDocument);
  let descriptionText = compactFrameBodyDescription(frame);

  renderDescription(description, descriptionText, data.code || '', ownerDocument, isMarkdownCompactSummary(frame), options);
  element.appendChild(description);

  let command = null;
  let commandCode = null;
  let commandText = typeof data.command === 'string' ? data.command : '';
  if (commandText) {
    let block = buildCommandBlock(commandText, ownerDocument);
    element.appendChild(block.pre);
    command = block.pre;
    commandCode = block.code;
  }

  return {
    element,
    description,
    descriptionText,
    codeText: data.code || '',
    command,
    commandCode,
    commandText,
  };
}

function isMarkdownCompactSummary(frame) {
  return frame?.type === 'AgentMessage' && frame?.content?.turnReport === true;
}

function buildCommandBlock(commandText, ownerDocument) {
  let codeNode = code.class('kikx-frame__compact-command-code language-bash').build(ownerDocument);
  codeNode.textContent = commandText;
  let preNode = pre.class('kikx-frame__compact-command').build(ownerDocument);
  preNode.appendChild(codeNode);
  return { pre: preNode, code: codeNode };
}

function renderDescription(element, description, codeText, ownerDocument, markdown = false, options = {}) {
  while (element.firstChild)
    element.removeChild(element.firstChild);

  if (!codeText) {
    if (markdown) {
      element.appendChild(renderMarkdownToElement(ownerDocument, description, {
        className: 'kikx-frame__compact-markdown kikx-markdown',
        rawMarkdown: options.rawMarkdown === true,
      }));
      return;
    }
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
