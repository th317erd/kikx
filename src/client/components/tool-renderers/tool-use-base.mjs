'use strict';

import { elements, ReactiveState, $ } from '../../lib/aeor-ui.mjs';

const { div, span, strong, p, pre, code, details, summary } = elements;
const DEFAULT_OUTPUT_READ_BYTES = 128 * 1024;

export class ToolUse extends HTMLElement {
  constructor() {
    super();
    this._frame = null;
    this._appState = null;
    this._loadPromise = null;
    this.state = new ReactiveState({
      toolName: '',
      status: '',
      outputID: '',
      sizeLabel: '',
      expanded: false,
      loading: false,
      loaded: false,
      error: '',
      output: null,
    });
  }

  set frame(frame) {
    this.updateFrame(frame);
  }

  get frame() {
    return this._frame;
  }

  updateFrame(frame, appState = {}) {
    let previousOutputID = this.state.outputID;
    this._frame = frame || null;
    this._appState = appState || {};
    this.state.toolName = this.toolName;
    this.state.status = this.status;
    this.state.outputID = this.outputID;
    this.state.sizeLabel = formatBytes(this.content.sizeBytes);

    if (previousOutputID !== this.state.outputID) {
      this._loadPromise = null;
      this.state.loaded = false;
      this.state.loading = false;
      this.state.error = '';
      this.state.output = null;
    }

    this.render();
  }

  connectedCallback() {
    if (this._frame && this.childNodes.length === 0)
      this.render();
  }

  disconnectedCallback() {
    cleanupReactiveBindings(this);
  }

  get content() {
    return this._frame?.content || {};
  }

  get input() {
    let input = this.content.input;
    return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  }

  get toolName() {
    return this.content.toolName || this.constructor.toolName || 'tool';
  }

  get status() {
    return this.content.status || this._frame?.state?.status || (this.isResultFrame ? 'success' : 'running');
  }

  get outputID() {
    return this.content.toolOutputID
      || this.content.retrieval?.getRange?.arguments?.id
      || this.content.retrieval?.getAll?.arguments?.id
      || '';
  }

  get isResultFrame() {
    return this.content.phase === 'result' || this._frame?.type === 'ToolResult';
  }

  render() {
    cleanupReactiveBindings(this);
    $(this).empty();
    this.className = `kikx-tool-card ${this.cardClassName}`;

    this.appendChild(
      div.class('kikx-tool-card__inner').context(this)(
        this.renderHeader(),
        div.class('kikx-tool-card__summary')(this.renderSummaryText()),
        this.renderFacts(),
        this.isResultFrame ? this.renderResultDetails() : this.renderArgumentsDetails(),
      ).build(document),
    );
  }

  get cardClassName() {
    return this.isResultFrame ? 'kikx-tool-card--result' : 'kikx-tool-card--call';
  }

  renderHeader() {
    return div.class('kikx-tool-card__header')(
      span.class('kikx-tool-card__badge')(this.isResultFrame ? 'Result' : 'Tool'),
      strong(this.displayName()),
      span.class(`kikx-tool-card__status kikx-tool-card__status--${this.status}`)(this.status),
    ).build(document);
  }

  renderSummaryText() {
    return this.isResultFrame ? this.resultSummary() : this.callSummary();
  }

  displayName() {
    return this.toolName;
  }

  callSummary() {
    return `Calling ${this.toolName}...`;
  }

  resultSummary() {
    return `${this.displayName()} ${this.status === 'error' ? 'failed' : 'completed'}.`;
  }

  renderFacts() {
    return div.class('kikx-tool-card__facts')(
      this.outputID ? span(`Output ${this.outputID}`) : null,
      this.state.sizeLabel ? span(this.state.sizeLabel) : null,
    ).build(document);
  }

  renderArgumentsDetails() {
    return details.class('kikx-tool-card__details')(
      summary('Arguments'),
      pre(code(formatJSON(this.input))),
    ).build(document);
  }

  renderResultDetails() {
    let detailsNode = details.class('kikx-tool-card__details kikx-tool-card__output-details')(
      summary('Output'),
      this.renderResultBody(),
    ).build(document);

    detailsNode.open = this.state.expanded === true;
    detailsNode.addEventListener('toggle', () => {
      this.state.expanded = detailsNode.open;
      if (detailsNode.open)
        this.loadOutput();
    });

    return detailsNode;
  }

  renderResultBody() {
    if (this.state.loading)
      return p.class('kikx-tool-card__message')('Loading output...').build(document);

    if (this.state.error)
      return p.class('kikx-tool-card__message kikx-tool-card__message--error')(this.state.error).build(document);

    if (!this.state.loaded && this.outputID)
      return p.class('kikx-tool-card__message')('Expand to load the stored output.').build(document);

    let output = this.state.output || this.previewOutput();
    if (!output)
      return p.class('kikx-tool-card__message')('No stored output is available for this tool result.').build(document);

    return this.renderOutput(output);
  }

  previewOutput() {
    if (!this.content.preview)
      return null;

    return {
      format: this.content.format || 'text',
      content: this.content.preview,
      sizeBytes: this.content.sizeBytes || this.content.preview.length,
      start: 0,
      end: this.content.preview.length,
      returnedBytes: this.content.preview.length,
      truncated: true,
    };
  }

  async loadOutput() {
    if (!this.outputID || this.state.loaded || this.state.loading)
      return this._loadPromise;

    this.state.loading = true;
    this.state.error = '';
    this.render();

    this._loadPromise = (async () => {
      try {
        let url = new URL(`/api/v1/tool-outputs/${encodeURIComponent(this.outputID)}`, window.location.origin);
        url.searchParams.set('maxBytes', String(DEFAULT_OUTPUT_READ_BYTES));
        let response = await fetch(url);
        let body = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(body?.error?.message || `HTTP ${response.status}`);

        this.state.output = body?.data?.output || null;
        this.state.loaded = true;
      } catch (error) {
        this.state.error = error?.message || 'Failed to load tool output';
      } finally {
        this.state.loading = false;
        this.render();
      }
    })();

    return this._loadPromise;
  }

  renderOutput(output) {
    let content = parseToolOutput(output);
    return this.renderPlainOutput(typeof content === 'string' ? content : formatJSON(content), output);
  }

  renderPlainOutput(text, output) {
    return div.class('kikx-tool-output')(
      pre.class('kikx-tool-card__preview')(code(String(text ?? ''))),
      this.renderTruncationNotice(output),
    ).build(document);
  }

  renderOutputSection(label, text) {
    return div.class('kikx-tool-output__section')(
      div.class('kikx-tool-output__section-label')(label),
      pre.class('kikx-tool-card__preview')(code(String(text ?? ''))),
    ).build(document);
  }

  renderTruncationNotice(output) {
    if (!output?.truncated)
      return null;

    let range = `${output.start || 0}-${output.end || output.returnedBytes || 0}`;
    return p.class('kikx-tool-card__retrieval')(`Showing bytes ${range} of ${output.sizeBytes}.`).build(document);
  }
}

export class GenericToolUse extends ToolUse {}

export class ShellToolUse extends ToolUse {
  static toolName = 'exec';

  displayName() {
    return 'Shell';
  }

  callSummary() {
    return this.input.command ? `Running command: ${this.input.command}` : 'Running command...';
  }

  resultSummary() {
    let outcome = this.status === 'error' ? 'failed' : 'completed';
    return this.input.command ? `Command ${outcome}: ${this.input.command}` : `Command ${outcome}.`;
  }

  renderOutput(output) {
    let content = parseToolOutput(output);
    let result = content?.result && typeof content.result === 'object' ? content.result : content;
    if (!result || typeof result !== 'object')
      return this.renderPlainOutput(String(content ?? ''), output);

    let stdout = typeof result.stdout === 'string' ? result.stdout : '';
    let stderr = typeof result.stderr === 'string' ? result.stderr : '';
    let meta = [
      result.command ? `Command: ${result.command}` : '',
      result.cwd ? `cwd: ${result.cwd}` : '',
      result.exitCode != null ? `exit: ${result.exitCode}` : '',
      result.signal ? `signal: ${result.signal}` : '',
      result.durationMs != null ? `${result.durationMs}ms` : '',
    ].filter(Boolean).join(' | ');

    return div.class('kikx-tool-output kikx-tool-output--exec')(
      meta ? p.class('kikx-tool-output__meta')(meta) : null,
      this.renderOutputSection('stdout', stdout || '(stdout empty)'),
      stderr ? this.renderOutputSection('stderr', stderr) : null,
      this.renderTruncationNotice(output),
    ).build(document);
  }
}

export class WebSearchUse extends ToolUse {
  static toolName = 'web-search';

  displayName() {
    return 'Web search';
  }

  callSummary() {
    return this.input.query ? `Searching for ${this.input.query}...` : 'Searching the web...';
  }

  resultSummary() {
    let outcome = this.status === 'error' ? 'failed' : 'completed';
    return this.input.query ? `Search ${outcome} for ${this.input.query}.` : `Search ${outcome}.`;
  }

  renderOutput(output) {
    let content = parseToolOutput(output);
    let result = content?.result && typeof content.result === 'object' ? content.result : content;
    let results = Array.isArray(result?.results) ? result.results : [];
    let list = document.createElement('ol');
    list.className = 'kikx-tool-output__results';

    for (let searchResult of results) {
      let item = document.createElement('li');
      let title = document.createElement(searchResult.url ? 'a' : 'strong');
      title.textContent = searchResult.title || searchResult.url || searchResult.text || 'Result';
      if (searchResult.url) {
        title.href = searchResult.url;
        title.target = '_blank';
        title.rel = 'noreferrer';
      }
      item.appendChild(title);

      if (searchResult.text) {
        let text = document.createElement('p');
        text.textContent = searchResult.text;
        item.appendChild(text);
      }

      if (searchResult.source || searchResult.url) {
        let source = document.createElement('span');
        source.className = 'kikx-tool-output__source';
        source.textContent = searchResult.source || searchResult.url;
        item.appendChild(source);
      }

      list.appendChild(item);
    }

    let query = result?.query || this.input.query || '';

    return div.class('kikx-tool-output kikx-tool-output--search')(
      p.class('kikx-tool-output__meta')(query ? `Query: ${query}` : 'Search results'),
      results.length > 0 ? list : p.class('kikx-tool-card__message')('No search results were returned.'),
      this.renderTruncationNotice(output),
    ).build(document);
  }
}

export class FetchUse extends ToolUse {
  static toolName = 'web-fetch';

  displayName() {
    return 'Fetch';
  }

  callSummary() {
    return this.input.url ? `Fetching URL: ${this.input.url}...` : 'Fetching URL...';
  }

  resultSummary() {
    let outcome = this.status === 'error' ? 'failed' : 'completed';
    return this.input.url ? `Fetch ${outcome}: ${this.input.url}` : `Fetch ${outcome}.`;
  }

  renderOutput(output) {
    let content = parseToolOutput(output);
    let result = content?.result && typeof content.result === 'object' ? content.result : content;
    let meta = [
      result?.title ? `Title: ${result.title}` : '',
      result?.finalURL || result?.requestedURL || this.input.url ? `URL: ${result?.finalURL || result?.requestedURL || this.input.url}` : '',
      result?.status != null ? `HTTP ${result.status}` : '',
    ].filter(Boolean).join('\n');

    return div.class('kikx-tool-output kikx-tool-output--fetch')(
      meta ? pre.class('kikx-tool-output__meta-block')(code(meta)) : null,
      this.renderOutputSection('text', result?.text || '(no page text returned)'),
      this.renderTruncationNotice(output),
    ).build(document);
  }
}

export class ReadFileUse extends ToolUse {
  static toolName = 'read-file';

  displayName() {
    return 'Read file';
  }

  callSummary() {
    return this.input.path ? `Reading file: ${this.input.path}` : 'Reading file...';
  }

  resultSummary() {
    let outcome = this.status === 'error' ? 'failed' : 'completed';
    return this.input.path ? `Read ${outcome}: ${this.input.path}` : `Read ${outcome}.`;
  }
}

export class WriteFileUse extends ToolUse {
  static toolName = 'write-file';

  displayName() {
    return 'Write file';
  }

  callSummary() {
    return this.input.path ? `Writing file: ${this.input.path}` : 'Writing file...';
  }

  resultSummary() {
    let outcome = this.status === 'error' ? 'failed' : 'completed';
    return this.input.path ? `Write ${outcome}: ${this.input.path}` : `Write ${outcome}.`;
  }
}

export class StoredOutputUse extends ToolUse {
  displayName() {
    return this.toolName === 'output-grep' ? 'Search stored output' : 'Read stored output';
  }

  callSummary() {
    if (this.toolName === 'output-grep')
      return this.input.id ? `Searching stored tool output: ${this.input.id}` : 'Searching stored tool output...';

    return this.input.id ? `Reading stored tool output: ${this.input.id}` : 'Reading stored tool output...';
  }

  resultSummary() {
    let outcome = this.status === 'error' ? 'failed' : 'completed';
    return this.input.id ? `${this.displayName()} ${outcome}: ${this.input.id}` : `${this.displayName()} ${outcome}.`;
  }

  renderOutput(output) {
    let content = parseToolOutput(output);
    let result = content?.result && typeof content.result === 'object' ? content.result : content;
    if (typeof result?.content === 'string')
      return this.renderPlainOutput(result.content, output);

    return this.renderPlainOutput(typeof result === 'string' ? result : formatJSON(result), output);
  }
}

export class OutputReadUse extends StoredOutputUse {}

export class OutputGrepUse extends StoredOutputUse {}

export class ProcessToolUse extends ToolUse {
  displayName() {
    return this.toolName;
  }

  callSummary() {
    let processID = this.input.processID || '';
    if (this.toolName === 'exec-read')
      return processID ? `Reading exec output: ${processID}` : 'Reading exec output...';
    if (this.toolName === 'exec-grep')
      return processID ? `Searching exec output: ${processID}` : 'Searching exec output...';
    if (this.toolName === 'exec-kill')
      return processID ? `Killing exec task: ${processID}` : 'Killing exec task...';
    if (this.toolName === 'exec-status')
      return processID ? `Checking exec status: ${processID}` : 'Checking exec status...';
    return 'Listing exec tasks...';
  }
}

export class SessionToolUse extends ToolUse {
  displayName() {
    return 'Session';
  }

  callSummary() {
    if (this.toolName === 'agent-list')
      return 'Listing agents...';
    if (this.toolName === 'session-list')
      return 'Listing sessions...';
    if (this.toolName === 'session-create')
      return this.input.title ? `Creating session: ${this.input.title}` : 'Creating session...';
    if (this.toolName === 'session-invite-agents')
      return this.input.session_id ? `Inviting agents to session: ${this.input.session_id}` : 'Inviting agents...';
    if (this.toolName === 'session-get')
      return this.input.session_id ? `Inspecting session: ${this.input.session_id}` : 'Inspecting session...';
    if (this.toolName === 'session-frames')
      return this.input.session_id ? `Listing frames for session: ${this.input.session_id}` : 'Listing session frames...';
    if (this.toolName === 'session-message')
      return this.input.session_id ? `Posting message to session: ${this.input.session_id}` : 'Posting session message...';

    return `${this.toolName}...`;
  }

  resultSummary() {
    let outcome = this.status === 'error' ? 'failed' : 'completed';
    return `${this.toolName} ${outcome}.`;
  }
}

export class CwdToolUse extends ToolUse {
  displayName() {
    return 'Shell cwd';
  }

  callSummary() {
    if (this.toolName === 'cwd-get')
      return 'Reading shell cwd...';
    if (this.toolName === 'cwd-set')
      return this.input.cwd ? `Changing shell cwd: ${this.input.cwd}` : 'Changing shell cwd...';
    if (this.toolName === 'cwd-clear')
      return 'Clearing shell cwd...';

    return `${this.toolName}...`;
  }

  resultSummary() {
    let outcome = this.status === 'error' ? 'failed' : 'completed';
    return `${this.toolName} ${outcome}.`;
  }
}

export class FeedbackToolUse extends ToolUse {
  displayName() {
    return 'Feedback';
  }

  callSummary() {
    return this.input.title ? `Reporting feedback: ${this.input.title}` : 'Reporting Kikx feedback...';
  }

  resultSummary() {
    let outcome = this.status === 'error' ? 'failed' : 'saved';
    return this.input.title ? `Feedback ${outcome}: ${this.input.title}` : `Feedback ${outcome}.`;
  }
}

export class TodoToolUse extends ToolUse {
  displayName() {
    return 'Todo';
  }

  callSummary() {
    if (this.toolName === 'todo-get')
      return 'Reading todo list...';
    if (this.toolName === 'todo-add')
      return this.input.title ? `Adding todo: ${this.input.title}` : 'Adding todo...';
    if (this.toolName === 'todo-update')
      return this.input.id ? `Updating todo: ${this.input.id}` : 'Updating todo...';
    if (this.toolName === 'todo-complete')
      return this.input.id ? `Completing todo: ${this.input.id}` : 'Completing todo...';
    if (this.toolName === 'todo-delete')
      return this.input.id ? `Deleting todo: ${this.input.id}` : 'Deleting todo...';
    if (this.toolName === 'todo-clear')
      return 'Clearing todo list...';
    if (this.toolName === 'todo-focus-set')
      return this.input.id ? `Focusing todo: ${this.input.id}` : 'Setting todo focus...';
    if (this.toolName === 'todo-focus-clear')
      return 'Clearing todo focus...';

    return `${this.toolName}...`;
  }

  resultSummary() {
    let outcome = this.status === 'error' ? 'failed' : 'completed';
    return `${this.toolName} ${outcome}.`;
  }
}

export class ExecListUse extends ProcessToolUse {}

export class ExecStatusUse extends ProcessToolUse {}

export class ExecReadUse extends ProcessToolUse {}

export class ExecGrepUse extends ProcessToolUse {}

export class ExecKillUse extends ProcessToolUse {}

function parseToolOutput(output = {}) {
  if (output.format !== 'json')
    return output.content || '';

  try {
    return JSON.parse(output.content || 'null');
  } catch (_error) {
    return output.content || '';
  }
}

function formatJSON(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch (_error) {
    return String(value);
  }
}

function formatBytes(value) {
  let bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0)
    return '';

  if (bytes < 1024)
    return `${Math.trunc(bytes)} B`;

  let units = [ 'KB', 'MB', 'GB' ];
  let current = bytes;
  let unit = 'B';
  for (let candidate of units) {
    current /= 1024;
    unit = candidate;
    if (current < 1024)
      break;
  }

  return `${current.toFixed(current < 10 ? 1 : 0)} ${unit}`;
}

function cleanupReactiveBindings(root) {
  let nodes = [ root, ...root.querySelectorAll('*') ];
  for (let node of nodes) {
    if (!Array.isArray(node.__bindings))
      continue;

    for (let cleanup of node.__bindings)
      cleanup?.();

    node.__bindings = [];
  }
}
