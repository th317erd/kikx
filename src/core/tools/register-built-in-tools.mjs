'use strict';

import { ExecTool } from './exec-tool.mjs';
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
  ExecStatusTool,
} from './process-tools.mjs';
import { ReadFileTool } from './read-file-tool.mjs';
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
  [ 'exec-list', ExecListTool ],
  [ 'exec-status', ExecStatusTool ],
  [ 'exec-read', ExecReadTool ],
  [ 'exec-grep', ExecGrepTool ],
  [ 'exec-kill', ExecKillTool ],
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
  [ 'session-list', SessionListTool ],
  [ 'session-create', SessionCreateTool ],
  [ 'session-invite-agents', SessionInviteAgentsTool ],
  [ 'session-get', SessionGetTool ],
  [ 'session-frames', SessionFramesTool ],
  [ 'session-search', SessionSearchTool ],
  [ 'session-message', SessionMessageTool ],
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
