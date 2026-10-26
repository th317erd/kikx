'use strict';

import { renderMarkdownToElement } from '../lib/markdown-renderer.mjs';

const PROMPT_SUMMARY = 'View sent prompt';
const PROMPT_UNAVAILABLE = 'Sent prompt unavailable';
const PROMPT_MISSING_TEXT = 'No sent prompt was captured for this message.';

export class KikxUserMessageFrame extends HTMLElement {
  constructor() {
    super();
    this._frame = null;
    this._appState = null;
    this._text = null;
    this._prompt = null;
    this._promptSignature = null;
    this._textElement = null;
    this._details = null;
    this._summary = null;
    this._promptBody = null;
    this._structureReady = false;
  }

  updateFrame(frame, appState) {
    this._frame = frame || null;
    this._appState = appState || null;
    this._ensureStructure();
    this._renderText();
    this._updatePrompt();
  }

  _ensureStructure() {
    if (this._structureReady)
      return;

    this._structureReady = true;
    let root = document.createElement('div');
    root.className = 'kikx-user-message';

    this._textElement = document.createElement('div');
    this._textElement.className = 'kikx-user-message__text kikx-markdown';

    this._details = document.createElement('details');
    this._details.className = 'kikx-user-message__prompt';
    this._summary = document.createElement('summary');
    this._summary.className = 'kikx-user-message__prompt-summary';
    this._summary.textContent = PROMPT_UNAVAILABLE;
    this._promptBody = document.createElement('div');
    this._promptBody.className = 'kikx-user-message__prompt-body';
    this._details.append(this._summary, this._promptBody);
    this._details.addEventListener('toggle', () => {
      if (this._details.open)
        this._renderPrompt();
    });

    root.append(this._textElement, this._details);
    this.append(root);
  }

  _renderText() {
    let text = typeof this._frame?.content?.text === 'string' ? this._frame.content.text : '';
    if (this._text === text)
      return;

    this._text = text;
    let wake = splitQuestionWake(text);
    if (wake) {
      this._textElement.replaceChildren(
        renderWakeSection('kikx-user-message__context', wake.intro),
        renderWakeSection('kikx-user-message__answer', wake.answer),
        wake.suffix ? renderWakeSection('kikx-user-message__after', wake.suffix) : null,
      );
      return;
    }

    let rendered = renderMarkdownToElement(document, text, {
      className: 'kikx-user-message__text kikx-markdown',
    });
    this._textElement.replaceChildren(...rendered.childNodes);
  }

  _updatePrompt() {
    let prompt = readModelPrompt(this._frame);
    let signature = prompt
      ? `${prompt.capturedAt || 0}:${prompt.messages.length}:${prompt.agentID || ''}`
      : '';
    if (this._promptSignature === signature)
      return;

    this._prompt = prompt;
    this._promptSignature = signature;
    this._summary.textContent = prompt ? PROMPT_SUMMARY : PROMPT_UNAVAILABLE;
    this._promptBody.replaceChildren();
    if (this._details.open)
      this._renderPrompt();
  }

  _renderPrompt() {
    this._promptBody.replaceChildren();
    if (!this._prompt) {
      this._promptBody.appendChild(note(PROMPT_MISSING_TEXT));
      return;
    }

    let meta = document.createElement('div');
    meta.className = 'kikx-user-message__prompt-meta';
    let captured = Number(this._prompt.capturedAt);
    let parts = [ `${this._prompt.messages.length} message${this._prompt.messages.length === 1 ? '' : 's'}` ];
    if (Number.isFinite(captured) && captured > 0)
      parts.push(new Date(captured).toLocaleString());
    if (this._prompt.agentName)
      parts.push(this._prompt.agentName);
    meta.textContent = parts.join(' · ');
    this._promptBody.appendChild(meta);

    let lastUserIndex = findLastUserMessageIndex(this._prompt.messages);
    for (let [ index, message ] of this._prompt.messages.entries()) {
      let role = messageRole(message, index);
      let section = document.createElement('section');
      section.className = `kikx-user-message__prompt-message kikx-user-message__prompt-message--${roleClass(role)}`;

      let label = document.createElement('div');
      label.className = 'kikx-user-message__prompt-role';
      label.textContent = roleLabel(role, index === lastUserIndex);
      section.appendChild(label);

      let content = renderPromptContent(this._prompt, message, index === lastUserIndex);
      section.appendChild(content);
      this._promptBody.appendChild(section);
    }
  }
}

// Question answers arrive as a UserMessage containing both the agent's Q and
// the person's A. Keeping that whole exchange as one undifferentiated blob is
// what made the user's actual decision hard to find. Split the known wake shape
// so the A section can carry the operator styling and the Q/references stay
// contextual.
function splitQuestionWake(text) {
  let source = String(text || '');
  let answerMarker = source.indexOf('\nA: ');
  if (answerMarker < 0)
    return null;

  let intro = source.slice(0, answerMarker).trim();
  let rest = source.slice(answerMarker + 1).trimStart();
  let suffixMatch = /\n\n(?:References from when you asked:|Continue from here\.|If you already acted on the default|Nobody confirmed this\.|This answer arrived while you were working)/.exec(rest);
  let answer = suffixMatch ? rest.slice(0, suffixMatch.index).trim() : rest.trim();
  let suffix = suffixMatch ? rest.slice(suffixMatch.index).trim() : '';

  if (!intro.includes('\nQ: ') || !answer.startsWith('A: '))
    return null;

  return { intro, answer, suffix };
}

function renderWakeSection(className, text) {
  let section = document.createElement('div');
  section.className = className;
  let rendered = renderMarkdownToElement(document, text, {
    className: `${className} kikx-markdown`,
  });
  section.replaceChildren(...rendered.childNodes);
  return section;
}

function readModelPrompt(frame) {
  let prompt = frame?.content?.modelPrompt;
  if (!prompt || !Array.isArray(prompt.messages) || prompt.messages.length === 0)
    return null;

  return {
    capturedAt: Number(prompt.capturedAt) || 0,
    agentID: typeof prompt.agentID === 'string' ? prompt.agentID : '',
    agentName: typeof prompt.agentName === 'string' ? prompt.agentName : '',
    userText: typeof prompt.userText === 'string' ? prompt.userText : '',
    messages: prompt.messages,
  };
}

function renderPromptContent(prompt, message, isLastUser) {
  let text = messageContent(message);
  let element = renderMarkdownToElement(document, text, {
    className: 'kikx-user-message__prompt-content kikx-markdown',
  });

  if (isLastUser && prompt.userText.trim() !== '') {
    if (!highlightUserText(element, prompt.userText))
      element.classList.add('kikx-user-message__prompt-content--user-fallback');
  }

  return element;
}

function highlightUserText(root, userText) {
  let raw = userText.trim();
  if (raw === '')
    return false;

  if (wrapFirstTextMatch(root, raw))
    return true;

  // Markdown may have transformed the user's syntax (`**bold**` becomes bold
  // text). Search for the rendered plain text as a fallback.
  let probe = renderMarkdownToElement(document, raw, {
    className: 'kikx-user-message__prompt-probe',
  });
  let plain = probe.textContent.trim();
  if (!plain || plain === raw)
    return false;

  return wrapFirstTextMatch(root, plain);
}

function wrapFirstTextMatch(root, needle) {
  for (let node of collectTextNodes(root)) {
    let index = node.nodeValue.indexOf(needle);
    if (index === -1)
      continue;

    let parent = node.parentNode;
    let before = document.createTextNode(node.nodeValue.slice(0, index));
    let after = document.createTextNode(node.nodeValue.slice(index + needle.length));
    let mark = document.createElement('mark');
    mark.className = 'kikx-user-message__prompt-user-text';
    mark.textContent = needle;
    parent.insertBefore(before, node);
    parent.insertBefore(mark, node);
    parent.insertBefore(after, node);
    parent.removeChild(node);
    return true;
  }

  return false;
}

function collectTextNodes(root) {
  let nodes = [];
  for (let child of root.childNodes) {
    if (child.nodeType === 3)
      nodes.push(child);
    else if (child.childNodes?.length)
      nodes.push(...collectTextNodes(child));
  }
  return nodes;
}

function messageRole(message, index) {
  if (typeof message?.role === 'string' && message.role.trim() !== '')
    return message.role.trim().toLowerCase();
  if (typeof message?.type === 'string' && message.type !== 'message')
    return message.type.trim().toLowerCase();
  return index === 0 ? 'message' : 'message';
}

function roleClass(role) {
  if (role === 'system' || role === 'developer')
    return 'system';
  if (role === 'assistant' || role === 'model')
    return 'assistant';
  if (role === 'tool' || role === 'function')
    return 'tool';
  return 'user';
}

function roleLabel(role, isLastUser) {
  if (role === 'system')
    return 'System';
  if (role === 'developer')
    return 'Developer';
  if (role === 'assistant' || role === 'model')
    return 'Assistant';
  if (role === 'tool' || role === 'function')
    return 'Tool';
  if (role === 'user')
    return isLastUser ? 'User / prompt' : 'User';
  if (role === 'message')
    return 'Prompt';
  return role;
}

function findLastUserMessageIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messageRole(messages[index], index) === 'user')
      return index;
  }
  return -1;
}

function messageContent(message) {
  let content = message?.content;
  if (content == null && typeof message?.text === 'string')
    return message.text;
  if (typeof content === 'string')
    return content;
  if (Array.isArray(content))
    return content.map(contentPartText).filter(Boolean).join('\n');
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string')
      return content.text;
    return JSON.stringify(content, null, 2);
  }
  return String(content ?? '');
}

function contentPartText(part) {
  if (typeof part === 'string')
    return part;
  if (typeof part?.text === 'string')
    return part.text;
  if (typeof part?.content === 'string')
    return part.content;
  if (Array.isArray(part?.content))
    return part.content.map(contentPartText).filter(Boolean).join('\n');
  if (part == null)
    return '';
  return JSON.stringify(part, null, 2);
}

function note(text) {
  let element = document.createElement('p');
  element.className = 'kikx-user-message__prompt-empty';
  element.textContent = text;
  return element;
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-user-message-frame'))
  customElements.define('kikx-user-message-frame', KikxUserMessageFrame);
