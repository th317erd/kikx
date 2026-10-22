'use strict';

// Compact one-line summary for non-communication frames. Kept DOM-free so the
// wording, icon and status rules can be unit-tested without a browser.

import { isToolFrame } from '../../shared/frame-manager/frame-manager.mjs';

const BOT_COMMUNICATION_TYPES = new Set([ 'AgentMessage', 'AgentMessageDelta', 'AgentProgress' ]);

const COMPACT_FRAME_TYPES = new Set([
  'CompactionFrame',
  'AgentError',
  'SystemNotice',
  'CommandResult',
  'FrameLoadError',
]);

const SUCCESS_STATUSES = new Set([ 'success', 'complete', 'completed', 'ok', 'saved', 'done' ]);
const ERROR_STATUSES = new Set([ 'error', 'failed', 'failure', 'fail' ]);

const TOOL_ICONS = new Map([
  [ 'read-file', 'eyeball' ],
  [ 'read', 'eyeball' ],
  [ 'exec-read', 'eyeball' ],
  [ 'output-read', 'eyeball' ],
  [ 'write-file', 'quill' ],
  [ 'exec', 'gear' ],
  [ 'exec-grep', 'search' ],
  [ 'web-search', 'search' ],
  [ 'web-fetch', 'fetch' ],
  [ 'todo-add', 'check' ],
  [ 'todo-clear', 'check' ],
  [ 'todo-complete', 'check' ],
  [ 'todo-delete', 'check' ],
  [ 'todo-focus-clear', 'check' ],
  [ 'todo-focus-set', 'check' ],
  [ 'todo-get', 'check' ],
  [ 'todo-update', 'check' ],
  [ 'feedback-report', 'mail' ],
  [ 'database-search', 'database' ],
  [ 'database-fetch', 'database' ],
  [ 'output-grep', 'search' ],
]);

export function normalizeFrameStatus(status) {
  let value = String(status ?? '').trim().toLowerCase();
  if (SUCCESS_STATUSES.has(value))
    return 'success';
  if (ERROR_STATUSES.has(value))
    return 'error';
  return 'running';
}

export function frameStatus(frame) {
  let content = frame?.content || {};
  let explicit = content.status ?? content.state?.status ?? frame?.state?.status;
  if (explicit != null && String(explicit).trim() !== '')
    return normalizeFrameStatus(explicit);

  if (frame?.type === 'FrameLoadError' || frame?.type === 'AgentError')
    return 'error';

  if (content.error)
    return 'error';

  if (content.phase === 'result' || frame?.type === 'ToolResult')
    return 'success';

  return 'running';
}

export function frameStatusClass(status) {
  return `kikx-frame--status-${normalizeFrameStatus(status)}`;
}

export function isBotCommunicationFrame(frame) {
  return BOT_COMMUNICATION_TYPES.has(frame?.type);
}

export function isCompactFrame(frame) {
  if (!frame)
    return false;

  if (isToolFrame(frame))
    return true;

  return COMPACT_FRAME_TYPES.has(frame.type);
}

export function compactFrameSummary(frame) {
  if (!frame)
    return { description: 'Frame', icon: 'diamond', status: 'running' };

  let status = frameStatus(frame);
  if (isToolFrame(frame))
    return toolFrameSummary(frame, status);

  return systemFrameSummary(frame, status);
}

const COMPACT_HEADER_LABELS = new Map([
  [ 'read-file', 'Read File' ],
  [ 'read', 'Read Output' ],
  [ 'exec-read', 'Read Output' ],
  [ 'output-read', 'Read Output' ],
  [ 'write-file', 'Write File' ],
  [ 'exec-status', 'Exec Status' ],
  [ 'exec-list', 'Exec List' ],
  [ 'exec-grep', 'Exec Search' ],
  [ 'web-search', 'Search' ],
  [ 'web-fetch', 'Fetch' ],
]);

// Compact frames put a short status/action label and the icon in the header.
// Long descriptions (usually file paths) stay in the body instead.
export function compactFrameHeader(frame) {
  let summary = compactFrameSummary(frame);
  let toolName = String(frame?.content?.toolName || '');
  let label = COMPACT_HEADER_LABELS.get(toolName);

  if (!label && toolName.startsWith('todo-'))
    label = 'Todo List';
  else if (!label && (toolName === 'exec' || (toolName.startsWith('exec-') && toolName !== 'exec-read')))
    label = summary.description;
  else if (!label)
    label = summary.description.length <= 32 ? summary.description : humanizeToolName(toolName || frame?.type);

  return {
    label: label || summary.description || 'Tool',
    icon: summary.icon || 'diamond',
  };
}

export function compactFrameBodyDescription(frame) {
  let toolName = String(frame?.content?.toolName || '');
  if (toolName === 'exec')
    return '';

  return compactFrameSummary(frame).description || '';
}

function toolFrameSummary(frame, status) {
  let content = frame.content || {};
  let toolName = String(content.toolName || 'tool');
  let input = isPlainObject(content.input) ? content.input : {};
  let command = stripInjectedCwdPrefix(inputField(input, 'command'));

  return {
    description: toolDescription(toolName, input, status, frame),
    icon: toolIcon(toolName),
    status,
    ...(toolName === 'exec' && command ? { command } : {}),
  };
}

// Read a small field from tool input. Large inputs are stored truncated as
// {truncated:true, preview:"<json>"}; recover the field from the preview when the
// top-level value is absent (the preview may be cut off, so this is best-effort).
// Exec calls are commonly wrapped as `cd <workspace> && <actual command>` so
// the shell starts in the session cwd. That wrapper is execution plumbing, not
// part of what the user needs to read; strip only a single leading `cd … &&`
// wrapper and leave every other command untouched.
export function stripInjectedCwdPrefix(command) {
  let text = String(command ?? '');
  let match = /^\s*cd\s+(?:"[^"]+"|'[^']+'|[^\s&;]+)\s*(?:&&\s*|\r?\n\s*)/.exec(text);
  if (!match)
    return text;

  let remainder = text.slice(match[0].length);
  return remainder.trim() !== '' ? remainder : text;
}

function inputField(input, field) {
  let direct = text(input[field]);
  if (direct)
    return direct;

  if (!input?.truncated || typeof input.preview !== 'string')
    return '';

  let match = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(input.preview);
  if (!match)
    return '';

  try {
    return JSON.parse(`"${match[1]}"`);
  } catch (_error) {
    return match[1];
  }
}

function toolDescription(toolName, input, status = 'running', frame = null) {
  if (toolName.startsWith('todo-'))
    return todoDescription(toolName, input, frame);
  let path = inputField(input, 'path');
  let command = inputField(input, 'command');
  let query = inputField(input, 'query');
  let url = inputField(input, 'url');
  let sessionID = text(input.session_id);
  let processID = inputField(input, 'processID');
  let cwd = inputField(input, 'cwd');
  let title = inputField(input, 'title');
  let id = inputField(input, 'id');

  switch (toolName) {
    case 'read-file':
      return path ? `Read file ${path} <-` : 'Read file <-';
    case 'write-file':
      return path ? `Write file ${path} ->` : 'Write file ->';
    case 'exec':
      return status === 'success' ? 'Command completed' : status === 'error' ? 'Command failed' : 'Running command';
    case 'web-search':
      return query ? `Search for ${query}` : 'Search the web';
    case 'web-fetch':
      return url ? `Fetch ${url}` : 'Fetch URL';
    case 'agent-list':
      return 'List agents';
    case 'agent-create':
      return inputField(input, 'name') ? `Create agent ${inputField(input, 'name')}` : 'Create agent';
    case 'agent-update':
      return inputField(input, 'agent') ? `Edit agent ${inputField(input, 'agent')}` : 'Edit agent';
    case 'session-list':
      return 'List sessions';
    case 'session-create':
      return title ? `Create session ${title}` : 'Create session';
    case 'session-invite-agents':
      return sessionID ? `Invite agents to ${sessionID}` : 'Invite agents';
    case 'session-invite-team':
      return sessionID ? `Invite team to ${sessionID}` : 'Invite team';
    case 'session-get':
      return sessionID ? `Inspect session ${sessionID}` : 'Inspect session';
    case 'session-frames':
      return sessionID ? `List frames for ${sessionID}` : 'List session frames';
    case 'session-message':
      return sessionID ? `Post message to ${sessionID}` : 'Post session message';
    case 'session-search':
      return query ? `Search sessions for ${query}` : 'Search sessions';
    case 'cwd-get':
      return 'Read shell cwd';
    case 'cwd-set':
      return cwd ? `Set shell cwd ${cwd}` : 'Set shell cwd';
    case 'cwd-clear':
      return 'Clear shell cwd';
    case 'todo-get':
      return 'Read todo list';
    case 'todo-add':
      return title ? `Add todo: ${title}` : 'Add todo';
    case 'todo-update':
      return title ? `Update todo: ${title}` : 'Update todo';
    case 'todo-complete':
      return title ? `Complete todo: ${title}` : 'Complete todo';
    case 'todo-delete':
      return title ? `Delete todo: ${title}` : 'Delete todo';
    case 'todo-clear':
      return 'Clear todo list';
    case 'todo-focus-set':
      return title ? `Focus todo: ${title}` : 'Set todo focus';
    case 'todo-focus-clear':
      return 'Clear todo focus';
    case 'feedback-report':
      return title ? `Report feedback ${title}` : 'Report feedback';
    case 'output-read':
      return id ? `Read stored output ${id}` : 'Read stored output';
    case 'output-grep':
      return id ? `Search stored output ${id}` : 'Search stored output';
    case 'exec-list':
      return 'List exec tasks';
    case 'exec-status':
      return processID ? `Check exec status ${processID}` : 'Check exec status';
    case 'exec-read':
      return processID ? `Read exec output ${processID}` : 'Read exec output';
    case 'exec-grep':
      return processID ? `Search exec output ${processID}` : 'Search exec output';
    case 'exec-kill':
      return processID ? `Kill exec task ${processID}` : 'Kill exec task';
    case 'database-search':
      return query ? `Search database for ${query}` : 'Search database';
    case 'database-fetch':
      return id ? `Fetch database record ${id}` : 'Fetch database record';
    case 'team-list':
      return 'List teams';
    case 'team-create':
      return teamDescription('Create team', input);
    case 'team-update':
      return teamDescription('Edit team', input);
    case 'team-delete':
      return teamDescription('Delete team', input);
    case 'team-add-member':
      return teamDescription('Add member to', input);
    case 'team-remove-member':
      return teamDescription('Remove member from', input);
    default:
      return genericToolDescription(toolName, input);
  }
}

function todoDescription(toolName, input, frame = null) {
  let title = inputField(input, 'title') || todoTitleFromPreview(inputField(input, 'id'), inputField(input, 'parentID'), frame?.content?.preview);
  switch (toolName) {
    case 'todo-get':
      return 'Read todo list';
    case 'todo-clear':
      return 'Clear todo list';
    case 'todo-focus-clear':
      return 'Clear todo focus';
    case 'todo-add':
      return title ? `Add todo: ${title}` : 'Add todo';
    case 'todo-update':
      return title ? `Update todo: ${title}` : 'Update todo';
    case 'todo-complete':
      return title ? `Complete todo: ${title}` : 'Complete todo';
    case 'todo-delete':
      return title ? `Delete todo: ${title}` : 'Delete todo';
    case 'todo-focus-set':
      return title ? `Focus todo: ${title}` : 'Set todo focus';
    default:
      return 'Update todo list';
  }
}

function todoTitleFromPreview(id, parentID, preview) {
  if (typeof preview !== 'string' || preview === '')
    return '';

  let parsed = null;
  try {
    parsed = JSON.parse(preview);
  } catch (_error) {
    parsed = null;
  }

  if (parsed) {
    let title = findTodoTitleInState(parsed, id, parentID);
    if (title)
      return title;
  }

  // The preview is capped at 8 KiB and may be cut off mid-JSON. Prefer the
  // title adjacent to the target id; if the target is beyond the cap, fall back
  // to the first title (still far more useful than a generic "Update todo").
  let source = String(preview);
  if (id) {
    let idIndex = source.indexOf(`\"id\": \"${id}\"`);
    if (idIndex === -1)
      idIndex = source.indexOf(`\"id\":\"${id}\"`);
    if (idIndex !== -1)
      source = source.slice(idIndex, idIndex + 4096);
  }

  let match = /\"title\"\s*:\s*\"((?:[^\"\\]|\\.)*)\"/.exec(source);
  if (!match)
    return '';

  try {
    return JSON.parse(`\"${match[1]}\"`);
  } catch (_error) {
    return match[1];
  }
}

function findTodoTitleInState(state, id, parentID) {
  let items = Array.isArray(state?.items) ? state.items : [];
  for (let item of items) {
    if (!item)
      continue;
    if (!id || item.id === id)
      return typeof item.title === 'string' ? item.title.trim() : '';
    let children = Array.isArray(item.children) ? item.children : [];
    for (let child of children) {
      if (child?.id === id)
        return typeof child.title === 'string' ? child.title.trim() : '';
    }
  }

  if (state?.deleted?.title && (!id || state.deleted.id === id))
    return String(state.deleted.title).trim();
  if (parentID) {
    for (let item of items) {
      if (item?.id === parentID)
        return typeof item.title === 'string' ? item.title.trim() : '';
    }
  }
  return '';
}

function teamDescription(verb, input) {
  let subject = inputField(input, 'name') || text(input.title) || text(input.id);
  return subject ? `${verb} ${subject}` : verb;
}

function genericToolDescription(toolName, input) {
  let base = humanizeToolName(toolName);
  let subject = text(input.title)
    || text(input.query)
    || text(input.path)
    || text(input.url)
    || text(input.session_id)
    || text(input.processID)
    || text(input.cwd)
    || text(input.id)
    || inputField(input, 'name')
    || inputField(input, 'agent')
    || text(input.command);

  return subject ? `${base} ${subject}` : base;
}

function humanizeToolName(toolName) {
  let words = String(toolName || 'tool')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));

  return words.length > 0 ? words.join(' ') : 'Tool';
}

function toolIcon(toolName) {
  let icon = TOOL_ICONS.get(toolName);
  if (icon)
    return icon;

  if (toolName.startsWith('todo-'))
    return 'check';
  if (toolName.startsWith('team-') || toolName.startsWith('session-') || toolName.startsWith('agent-'))
    return 'diamond';
  if (toolName.startsWith('exec-'))
    return 'gear';
  if (toolName.startsWith('output-'))
    return 'output';
  if (toolName.startsWith('database-'))
    return 'database';

  return 'terminal';
}

function systemFrameSummary(frame, status) {
  switch (frame.type) {
    case 'CompactionFrame':
      return compactionFrameSummary(frame, status);
    case 'AgentError':
      return { description: text(frame.content?.text) || 'Agent error', icon: 'warning', status: 'error' };
    case 'SystemNotice':
      return { description: text(frame.content?.text) || 'System notice', icon: 'info', status };
    case 'CommandResult':
      return { description: commandResultDescription(frame), icon: 'arrow-right', status };
    case 'FrameLoadError':
      return { description: 'Frame failed to load', icon: 'warning', status: 'error' };
    case 'AgentProgress':
      return { description: text(frame.content?.text) || 'Agent progress', icon: 'dots', status };
    default:
      return { description: String(frame.type || 'Frame'), icon: 'diamond', status };
  }
}

function compactionFrameSummary(frame, status) {
  let content = frame.content || {};
  let frameCount = Number(content.frameCount || frame.compaction?.frameCount || 0);
  let suffix = frameCount > 0 ? ` (${frameCount} frame${frameCount === 1 ? '' : 's'})` : '';

  if (status === 'success')
    return { description: `Compaction complete${suffix}`, icon: 'compaction', status };

  if (status === 'error')
    return { description: 'Compaction failed', icon: 'compaction', status };

  if (String(content.status || frame.compaction?.status || '').toLowerCase() === 'trimmed')
    return { description: 'Compaction trimmed context', icon: 'compaction', status };

  return { description: `Compacting context${suffix}`, icon: 'compaction', status };
}

function commandResultDescription(frame) {
  let content = frame.content || {};
  let command = text(content.command);
  if (command)
    return `Command /${command}`;

  return text(content.text) || 'Command result';
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
