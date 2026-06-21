'use strict';

import {
  CwdToolUse,
  ExecGrepUse,
  ExecKillUse,
  ExecListUse,
  ExecReadUse,
  ExecStatusUse,
  FeedbackToolUse,
  FetchUse,
  OutputGrepUse,
  OutputReadUse,
  ReadFileUse,
  SessionToolUse,
  ShellToolUse,
  TodoToolUse,
  WebSearchUse,
  WriteFileUse,
} from './tool-use-base.mjs';

defineToolElement('kikx-cwd-tool-use', CwdToolUse);
defineToolElement('kikx-feedback-tool-use', FeedbackToolUse);
defineToolElement('kikx-shell-tool-use', ShellToolUse);
defineToolElement('kikx-web-search-use', WebSearchUse);
defineToolElement('kikx-fetch-use', FetchUse);
defineToolElement('kikx-read-file-use', ReadFileUse);
defineToolElement('kikx-write-file-use', WriteFileUse);
defineToolElement('kikx-output-read-use', OutputReadUse);
defineToolElement('kikx-output-grep-use', OutputGrepUse);
defineToolElement('kikx-exec-list-use', ExecListUse);
defineToolElement('kikx-exec-status-use', ExecStatusUse);
defineToolElement('kikx-exec-read-use', ExecReadUse);
defineToolElement('kikx-exec-grep-use', ExecGrepUse);
defineToolElement('kikx-exec-kill-use', ExecKillUse);
defineToolElement('kikx-session-tool-use', SessionToolUse);
defineToolElement('kikx-todo-tool-use', TodoToolUse);

function defineToolElement(tagName, ToolUseClass) {
  if (typeof customElements !== 'undefined' && !customElements.get(tagName))
    customElements.define(tagName, ToolUseClass);
}

export {
  CwdToolUse,
  ExecGrepUse,
  ExecKillUse,
  ExecListUse,
  ExecReadUse,
  ExecStatusUse,
  FeedbackToolUse,
  FetchUse,
  OutputGrepUse,
  OutputReadUse,
  ReadFileUse,
  SessionToolUse,
  ShellToolUse,
  TodoToolUse,
  WebSearchUse,
  WriteFileUse,
};
