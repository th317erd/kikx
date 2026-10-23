'use strict';

import {
  AgentToolUse,
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
  QuestionListUse,
  ReadFileUse,
  SessionToolUse,
  ShellToolUse,
  WebSearchUse,
  WriteFileUse,
} from './tool-use-base.mjs';
import { TodoToolUse } from './todo-tool-use.mjs';

defineToolElement('kikx-cwd-tool-use', CwdToolUse);
defineToolElement('kikx-feedback-tool-use', FeedbackToolUse);
defineToolElement('kikx-shell-tool-use', ShellToolUse);
defineToolElement('kikx-web-search-use', WebSearchUse);
defineToolElement('kikx-fetch-use', FetchUse);
defineToolElement('kikx-read-file-use', ReadFileUse);
defineToolElement('kikx-question-list-use', QuestionListUse);
defineToolElement('kikx-write-file-use', WriteFileUse);
defineToolElement('kikx-output-read-use', OutputReadUse);
defineToolElement('kikx-output-grep-use', OutputGrepUse);
defineToolElement('kikx-exec-list-use', ExecListUse);
defineToolElement('kikx-exec-status-use', ExecStatusUse);
defineToolElement('kikx-exec-read-use', ExecReadUse);
defineToolElement('kikx-exec-grep-use', ExecGrepUse);
defineToolElement('kikx-exec-kill-use', ExecKillUse);
defineToolElement('kikx-session-tool-use', SessionToolUse);
defineToolElement('kikx-agent-tool-use', AgentToolUse);
defineToolElement('kikx-todo-tool-use', TodoToolUse);

// Re-registering an existing tag is a no-op, but binding one constructor to TWO
// tag names is a hard error in `customElements.define()`. That error is not
// local: it is thrown while this module is being evaluated, so evaluation
// aborts, every `defineToolElement()` after it never runs, and — because the
// throw propagates out of the dynamic `import()` in
// `loadClientComponentDescriptors()` — the app never records ANY frame
// component descriptors. The user-visible result is not "one tool card is
// missing"; it is every Question frame rendering as bare text with no answer
// form, because `Question` was never registered. Guard the constructor reuse
// too, and never let one bad registration take the other 18 down with it.
function defineToolElement(tagName, ToolUseClass) {
  if (typeof customElements === 'undefined')
    return;

  if (customElements.get(tagName))
    return;

  try {
    customElements.define(tagName, ToolUseClass);
  } catch (error) {
    console.error(`[kikx] could not define <${tagName}>:`, error?.message || error);
  }
}

export {
  AgentToolUse,
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
  QuestionListUse,
  ReadFileUse,
  SessionToolUse,
  ShellToolUse,
  TodoToolUse,
  WebSearchUse,
  WriteFileUse,
};
