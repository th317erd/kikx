'use strict';

import { AgentCreateTool, AgentUpdateTool } from './agent-tools.mjs';
import { AskUserTool } from './ask-user-tool.mjs';
import { QuestionListTool } from './question-list-tool.mjs';
import {
  QuestionAnswerTool,
  QuestionCreateTool,
  QuestionDismissTool,
  QuestionGetTool,
} from './question-tools.mjs';
import { ExecTool } from './exec-tool.mjs';
import {
  TagCreateTool,
  TagDeleteTool,
  TagGetTool,
  TagListTool,
  TagReadTool,
  TagUpdateTool,
} from './tag-tools.mjs';
import { OcrTool } from './ocr-tool.mjs';
import { ExecScriptTool } from './exec-script-tool.mjs';
import { FeedbackReportTool } from './feedback-tool.mjs';
import {
  CwdClearTool,
  CwdGetTool,
  CwdSetTool,
} from './cwd-tools.mjs';
import {
  ExecGrepTool,
  ExecKillTool,
  ExecListTool,
  ExecReadTool,
  ExecResumeTool,
  ExecStatusTool,
  ExecSuspendTool,
} from './process-tools.mjs';
import { ReadFileTool } from './read-file-tool.mjs';
import { SessionControlTool } from './session-control-tool.mjs';
import { SessionMergeStatusTool, SessionMergeTool } from './session-merge-tools.mjs';
import {
  AgentListTool,
  SessionCreateTool,
  SessionFramesTool,
  SessionGetTool,
  SessionInviteAgentsTool,
  SessionListTool,
  SessionMessageTool,
  SessionSearchTool,
} from './session-tools.mjs';
import {
  SessionInviteTeamTool,
  TeamAddMemberTool,
  TeamCreateTool,
  TeamDeleteTool,
  TeamListTool,
  TeamRemoveMemberTool,
  TeamUpdateTool,
} from './team-tools.mjs';
import { DatabaseFetchTool, DatabaseSearchTool } from './database-tools.mjs';
import { OutputGrepTool } from './tool-output-grep-tool.mjs';
import { OutputReadTool } from './tool-output-get-tool.mjs';
import { OutputSearchTool } from './tool-output-search-tool.mjs';
import {
  TodoAddTool,
  TodoClearTool,
  TodoCompleteTool,
  TodoDeleteTool,
  TodoFocusClearTool,
  TodoFocusSetTool,
  TodoGetTool,
  TodoUpdateTool,
} from './todo-tools.mjs';
import { WebFetchTool } from './web-fetch-tool.mjs';
import { WebSearchTool } from './web-search-tool.mjs';
import { WriteFileTool } from './write-file-tool.mjs';

export const BUILT_IN_TOOLS = [
  [ 'web-search', WebSearchTool ],
  [ 'web-fetch', WebFetchTool ],
  [ 'read-file', ReadFileTool ],
  [ 'write-file', WriteFileTool ],
  [ 'exec', ExecTool ],
  [ 'exec-script', ExecScriptTool ],
  [ 'ocr', OcrTool ],
  [ 'exec-list', ExecListTool ],
  [ 'exec-status', ExecStatusTool ],
  [ 'exec-read', ExecReadTool ],
  [ 'exec-grep', ExecGrepTool ],
  [ 'exec-kill', ExecKillTool ],
  [ 'exec-suspend', ExecSuspendTool ],
  [ 'exec-resume', ExecResumeTool ],
  [ 'session-control', SessionControlTool ],
  [ 'session-merge', SessionMergeTool ],
  [ 'session-merge-status', SessionMergeStatusTool ],
  [ 'cwd-get', CwdGetTool ],
  [ 'cwd-set', CwdSetTool ],
  [ 'cwd-clear', CwdClearTool ],
  [ 'feedback-report', FeedbackReportTool ],
  [ 'database-search', DatabaseSearchTool ],
  [ 'database-fetch', DatabaseFetchTool ],
  [ 'output-read', OutputReadTool ],
  [ 'output-grep', OutputGrepTool ],
  [ 'output-search', OutputSearchTool ],
  [ 'agent-list', AgentListTool ],
  [ 'agent-create', AgentCreateTool ],
  [ 'agent-update', AgentUpdateTool ],
  [ 'session-list', SessionListTool ],
  [ 'session-create', SessionCreateTool ],
  [ 'session-invite-agents', SessionInviteAgentsTool ],
  [ 'session-invite-team', SessionInviteTeamTool ],
  [ 'session-get', SessionGetTool ],
  [ 'session-frames', SessionFramesTool ],
  [ 'session-search', SessionSearchTool ],
  [ 'session-message', SessionMessageTool ],
  [ 'team-list', TeamListTool ],
  [ 'team-create', TeamCreateTool ],
  [ 'team-update', TeamUpdateTool ],
  [ 'team-delete', TeamDeleteTool ],
  [ 'team-add-member', TeamAddMemberTool ],
  [ 'team-remove-member', TeamRemoveMemberTool ],
  [ 'question-list', QuestionListTool ],
  [ 'question-get', QuestionGetTool ],
  [ 'question-create', QuestionCreateTool ],
  [ 'question-answer', QuestionAnswerTool ],
  [ 'question-dismiss', QuestionDismissTool ],
  [ 'ask-user', AskUserTool ],
  [ 'tag-create', TagCreateTool ],
  [ 'tag-list', TagListTool ],
  [ 'tag-get', TagGetTool ],
  [ 'tag-read', TagReadTool ],
  [ 'tag-update', TagUpdateTool ],
  [ 'tag-delete', TagDeleteTool ],
  [ 'todo-get', TodoGetTool ],
  [ 'todo-add', TodoAddTool ],
  [ 'todo-update', TodoUpdateTool ],
  [ 'todo-complete', TodoCompleteTool ],
  [ 'todo-delete', TodoDeleteTool ],
  [ 'todo-clear', TodoClearTool ],
  [ 'todo-focus-set', TodoFocusSetTool ],
  [ 'todo-focus-clear', TodoFocusClearTool ],
];

const BUILT_IN_FRAME_COMPONENTS = [
  [ 'CompactionFrame', {
    tagName: 'kikx-compaction-frame',
    moduleURL: '/client/components/kikx-compaction-frame.mjs',
    displayName: 'Compaction',
  } ],
  [ 'ToolCall', {
    tagName: 'kikx-tool-call-frame',
    moduleURL: '/client/components/tool-renderers/kikx-tool-call-frame.mjs',
    displayName: 'Tool call',
  } ],
  [ 'ToolResult', {
    tagName: 'kikx-tool-result-frame',
    moduleURL: '/client/components/tool-renderers/kikx-tool-result-frame.mjs',
    displayName: 'Tool result',
  } ],
  // Ask-user questions render inline in the thread as well as in the Inbox
  // (plan §6.5). Registered here in P3, together with the module itself —
  // registering it in P1 would have pointed at a file that did not exist yet and
  // broken the whole client load (plan §17.3).
  [ 'Question', {
    tagName: 'kikx-question-frame',
    moduleURL: '/client/components/kikx-question-frame.mjs',
    displayName: 'Question',
  } ],
];

export function registerBuiltInTools(pluginRegistry) {
  if (!pluginRegistry?.registerTool)
    throw new TypeError('registerBuiltInTools() requires a plugin registry');

  for (let [name, ToolClass] of BUILT_IN_TOOLS) {
    if (!pluginRegistry.getTool?.(name))
      pluginRegistry.registerTool(name, ToolClass);
  }

  if (!pluginRegistry.registerFrameComponent)
    return;

  for (let [frameType, descriptor] of BUILT_IN_FRAME_COMPONENTS) {
    if (!pluginRegistry.getFrameComponents?.().has(frameType))
      pluginRegistry.registerFrameComponent(frameType, descriptor);
  }
}
