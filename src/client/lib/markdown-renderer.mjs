'use strict';

const TOKEN_PREFIX = '\u0000KIKX_MD_';
const TOKEN_SUFFIX = '\u0000';
const SAFE_INLINE_TAGS = new Set([
  'strong', 'em', 'b', 'i', 'u', 's', 'del', 'code', 'kbd', 'mark', 'sub', 'sup',
]);
const SAFE_BLOCK_TAGS = new Set([
  'div', 'span', 'ul', 'ol', 'li', 'blockquote', 'pre',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);
const ALLOWED_RENDERED_TAGS = new Set([
  ...SAFE_INLINE_TAGS,
  ...SAFE_BLOCK_TAGS,
  'a', 'br', 'hr',
]);
const DANGEROUS_TAGS = new Set([
  'script', 'iframe', 'object', 'embed', 'applet',
  'form', 'input', 'textarea', 'select', 'button',
  'style', 'link', 'meta', 'base',
]);

export function markdownToHTML(input) {
  if (typeof input !== 'string' || input.length === 0)
    return '';

  let lines = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let output = [];

  for (let index = 0; index < lines.length;) {
    if (isBlank(lines[index])) {
      index++;
      continue;
    }

    let codeBlock = readFencedCodeBlock(lines, index);
    if (codeBlock) {
      output.push(renderCodeBlock(codeBlock));
      index = codeBlock.nextIndex;
      continue;
    }

    let heading = parseHeading(lines[index]);
    if (heading) {
      output.push(`<h${heading.level}>${renderInline(heading.text)}</h${heading.level}>`);
      index++;
      continue;
    }

    if (isHorizontalRule(lines[index])) {
      output.push('<hr>');
      index++;
      continue;
    }

    let table = readTable(lines, index);
    if (table) {
      output.push(renderTable(table));
      index = table.nextIndex;
      continue;
    }

    let list = readList(lines, index);
    if (list) {
      output.push(renderList(list));
      index = list.nextIndex;
      continue;
    }

    let quote = readBlockquote(lines, index);
    if (quote) {
      output.push(`<blockquote>${quote.lines.map((line) => renderInline(line)).join('<br>')}</blockquote>`);
      index = quote.nextIndex;
      continue;
    }

    let textBlock = readTextBlock(lines, index);
    output.push(renderTextBlock(textBlock.lines));
    index = textBlock.nextIndex;
  }

  return output.join('\n');
}

export function renderMarkdownToElement(ownerDocument, input, options = {}) {
  let element = ownerDocument.createElement('div');
  element.className = options.className || 'kikx-frame__content kikx-markdown';
  element.appendChild(parseHTMLFragment(ownerDocument, markdownToHTML(input)));
  return element;
}

function parseHTMLFragment(ownerDocument, html) {
  let template = ownerDocument.createElement('template');
  template.innerHTML = html;
  sanitizeRenderedNode(template.content);
  return template.content.cloneNode(true);
}

function readFencedCodeBlock(lines, index) {
  let open = /^```([A-Za-z0-9_-]*)\s*$/.exec(lines[index]);
  if (!open)
    return null;

  let content = [];
  let cursor = index + 1;
  while (cursor < lines.length) {
    if (/^```\s*$/.test(lines[cursor]))
      return {
        language: open[1] || '',
        content: content.join('\n'),
        closed: true,
        nextIndex: cursor + 1,
      };

    content.push(lines[cursor]);
    cursor++;
  }

  return {
    language: open[1] || '',
    content: content.join('\n'),
    closed: false,
    nextIndex: cursor,
  };
}

function renderCodeBlock(block) {
  let className = block.language ? ` class="language-${escapeAttribute(block.language)}"` : '';
  return `<pre><code${className}>${escapeHTML(block.content)}</code></pre>`;
}

function parseHeading(line) {
  let match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  if (!match)
    return null;

  return {
    level: match[1].length,
    text: match[2],
  };
}

function isHorizontalRule(line) {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function readTable(lines, index) {
  if (!lines[index]?.includes('|') || !lines[index + 1]?.includes('|'))
    return null;

  let header = splitTableRow(lines[index]);
  let divider = splitTableRow(lines[index + 1]);
  if (header.length === 0 || divider.length !== header.length || !divider.every((cell) => /^:?-{3,}:?$/.test(cell)))
    return null;

  let rows = [];
  let cursor = index + 2;
  while (cursor < lines.length && lines[cursor].includes('|') && !isBlank(lines[cursor])) {
    let cells = splitTableRow(lines[cursor]);
    rows.push(normalizeTableCells(cells, header.length));
    cursor++;
  }

  return {
    header,
    rows,
    nextIndex: cursor,
  };
}

function renderTable(table) {
  let header = table.header
    .map((cell) => `<th>${renderInline(cell)}</th>`)
    .join('');
  let rows = table.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
    .join('');

  return `<table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
}

function splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|'))
    trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|'))
    trimmed = trimmed.slice(0, -1);

  return trimmed.split('|').map((cell) => cell.trim());
}

function normalizeTableCells(cells, count) {
  let output = cells.slice(0, count);
  while (output.length < count)
    output.push('');

  return output;
}

function readList(lines, index) {
  let first = parseListItem(lines[index]);
  if (!first)
    return null;

  let items = [];
  let cursor = index;
  while (cursor < lines.length) {
    let item = parseListItem(lines[cursor]);
    if (!item || item.ordered !== first.ordered)
      break;

    items.push(item.text);
    cursor++;
  }

  return {
    ordered: first.ordered,
    items,
    nextIndex: cursor,
  };
}

function parseListItem(line) {
  let unordered = /^\s{0,3}[-*+]\s+(.+)$/.exec(line);
  if (unordered)
    return { ordered: false, text: unordered[1] };

  let ordered = /^\s{0,3}\d+[.)]\s+(.+)$/.exec(line);
  if (ordered)
    return { ordered: true, text: ordered[1] };

  return null;
}

function renderList(list) {
  let tagName = list.ordered ? 'ol' : 'ul';
  let items = list.items.map((item) => `<li>${renderInline(item)}</li>`).join('');
  return `<${tagName}>${items}</${tagName}>`;
}

function readBlockquote(lines, index) {
  if (!/^\s{0,3}>\s?/.test(lines[index]))
    return null;

  let quoteLines = [];
  let cursor = index;
  while (cursor < lines.length && /^\s{0,3}>\s?/.test(lines[cursor])) {
    quoteLines.push(lines[cursor].replace(/^\s{0,3}>\s?/, ''));
    cursor++;
  }

  return {
    lines: quoteLines,
    nextIndex: cursor,
  };
}

function readTextBlock(lines, index) {
  let blockLines = [];
  let cursor = index;
  while (cursor < lines.length) {
    let line = lines[cursor];
    if (
      isBlank(line)
      || readFencedCodeBlock(lines, cursor)
      || parseHeading(line)
      || isHorizontalRule(line)
      || readTable(lines, cursor)
      || readList(lines, cursor)
      || readBlockquote(lines, cursor)
    ) {
      break;
    }

    blockLines.push(line);
    cursor++;
  }

  return {
    lines: blockLines,
    nextIndex: cursor,
  };
}

function renderTextBlock(lines) {
  return `<div class="kikx-markdown__text">${lines.map((line) => renderInline(line)).join('<br>')}</div>`;
}

function renderInline(input) {
  if (input == null)
    return '';

  let tokens = [];
  let text = String(input);
  text = replaceCodeSpans(text, tokens);
  text = replaceLinks(text, tokens);
  text = escapeHTMLAllowingSafeTags(text);
  text = applyInlineEmphasis(text);
  return restoreTokens(text, tokens);
}

function replaceCodeSpans(text, tokens) {
  return text.replace(/`([^`\n]+)`/g, (_match, code) => createToken(tokens, `<code>${escapeHTML(code)}</code>`));
}

function replaceLinks(text, tokens) {
  return text.replace(/(!?)\[([^\]\n]+)\]\(((?:[^()\s]|\([^)]*\))+)(?:\s+"[^"]*")?\)/g, (match, imageMarker, label, url) => {
    if (imageMarker)
      return label;

    let href = normalizeSafeURL(url);
    let renderedLabel = applyInlineEmphasis(escapeHTMLAllowingSafeTags(label));
    if (!href)
      return renderedLabel;

    return createToken(tokens, `<a href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">${renderedLabel}</a>`);
  });
}

function applyInlineEmphasis(text) {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^\*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}

function createToken(tokens, html) {
  let index = tokens.length;
  tokens.push(html);
  return `${TOKEN_PREFIX}${index}${TOKEN_SUFFIX}`;
}

function restoreTokens(text, tokens) {
  return text.replace(new RegExp(`${TOKEN_PREFIX}(\\d+)${TOKEN_SUFFIX}`, 'g'), (_match, index) => tokens[Number(index)] || '');
}

function escapeHTMLAllowingSafeTags(text) {
  let output = '';
  let index = 0;

  while (index < text.length) {
    let tagStart = text.indexOf('<', index);
    if (tagStart < 0) {
      output += escapeHTML(text.slice(index));
      break;
    }

    output += escapeHTML(text.slice(index, tagStart));
    let tagEnd = text.indexOf('>', tagStart + 1);
    if (tagEnd < 0) {
      output += '&lt;';
      index = tagStart + 1;
      continue;
    }

    let tag = text.slice(tagStart, tagEnd + 1);
    let sanitized = sanitizeSafeTag(tag);
    output += sanitized == null ? escapeHTML(tag) : sanitized;
    index = tagEnd + 1;
  }

  return output;
}

function sanitizeSafeTag(tag) {
  let match = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9-]*)\b([^>]*)>$/.exec(tag);
  if (!match)
    return null;

  let closing = match[1] === '/';
  let tagName = match[2].toLowerCase();
  let attrs = match[3] || '';

  if (DANGEROUS_TAGS.has(tagName))
    return null;

  if (tagName === 'p')
    return '';

  if (closing)
    return isSafeTagName(tagName) ? `</${tagName}>` : null;

  if (tagName === 'br')
    return '<br>';

  if (tagName === 'hr')
    return '<hr>';

  if (tagName === 'a') {
    let href = normalizeSafeURL(readAttribute(attrs, 'href'));
    return href
      ? `<a href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">`
      : '<a>';
  }

  if (!isSafeTagName(tagName))
    return null;

  return `<${tagName}>`;
}

function isSafeTagName(tagName) {
  return SAFE_INLINE_TAGS.has(tagName) || SAFE_BLOCK_TAGS.has(tagName) || tagName === 'a' || tagName === 'hr';
}

function readAttribute(attrs, name) {
  let pattern = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  let match = pattern.exec(attrs || '');
  return match ? (match[1] || match[2] || match[3] || '') : '';
}

function normalizeSafeURL(value) {
  if (typeof value !== 'string' || value.trim() === '')
    return '';

  let url = value.trim();
  if (url.startsWith('#') || url.startsWith('/'))
    return url;

  try {
    let parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:')
      ? parsed.href
      : '';
  } catch (_error) {
    return '';
  }
}

function sanitizeRenderedNode(root) {
  let nodeConstants = root.ownerDocument.defaultView?.Node || {
    TEXT_NODE: 3,
    COMMENT_NODE: 8,
    ELEMENT_NODE: 1,
  };

  for (let child of Array.from(root.childNodes)) {
    if (child.nodeType === nodeConstants.TEXT_NODE)
      continue;

    if (child.nodeType === nodeConstants.COMMENT_NODE) {
      child.remove();
      continue;
    }

    if (child.nodeType !== nodeConstants.ELEMENT_NODE) {
      child.remove();
      continue;
    }

    let tagName = child.tagName.toLowerCase();
    if (DANGEROUS_TAGS.has(tagName)) {
      child.remove();
      continue;
    }

    if (tagName === 'p') {
      sanitizeRenderedNode(child);
      unwrapNode(child);
      continue;
    }

    if (!ALLOWED_RENDERED_TAGS.has(tagName)) {
      sanitizeRenderedNode(child);
      unwrapNode(child);
      continue;
    }

    for (let attr of Array.from(child.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) {
        child.removeAttribute(attr.name);
        continue;
      }

      if (!isAllowedAttribute(tagName, attr.name, attr.value)) {
        child.removeAttribute(attr.name);
        continue;
      }

      if (attr.name === 'href') {
        let href = normalizeSafeURL(attr.value);
        if (href)
          child.setAttribute('href', href);
        else
          child.removeAttribute(attr.name);
      }
    }

    if (tagName === 'a') {
      child.setAttribute('target', '_blank');
      child.setAttribute('rel', 'noopener noreferrer');
    }

    sanitizeRenderedNode(child);
  }
}

function unwrapNode(node) {
  let parent = node.parentNode;
  if (!parent)
    return;

  while (node.firstChild)
    parent.insertBefore(node.firstChild, node);

  node.remove();
}

function isAllowedAttribute(tagName, name, value) {
  let normalizedName = String(name || '').toLowerCase();

  if (normalizedName.startsWith('on'))
    return false;

  if (tagName === 'a')
    return normalizedName === 'href' && Boolean(normalizeSafeURL(value));

  if (tagName === 'code' && normalizedName === 'class')
    return /^language-[A-Za-z0-9_-]+$/.test(String(value || ''));

  if (tagName === 'div' && normalizedName === 'class')
    return value === 'kikx-markdown__text';

  return false;
}

function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isBlank(line) {
  return !line || /^\s*$/.test(line);
}
