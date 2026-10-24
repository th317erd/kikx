'use strict';

// Compact one-line summary for non-communication frames. Kept DOM-free so the
// wording, icon and status rules can be unit-tested without a browser.

import { isToolFrame } from '../../shared/frame-manager/frame-manager.mjs';
import { moodBand } from '../../shared/mood.mjs';

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

  if (frame.type === 'AgentMessage' && frame.content?.turnReport === true)
    return true;

  return COMPACT_FRAME_TYPES.has(frame.type);
}

// Mood is recorded continuously. Only three display bands are exposed.
// AgentProgress frames default to meh for legacy data; AgentMessage frames only
// get a band when a continue-turn update actually carried a mood score.
export function frameMoodBand(frame) {
  if (frame?.type === 'AgentProgress') {
    let mood = Number(frame?.content?.mood);
    return Number.isFinite(mood) ? moodBand(mood) || 'meh' : 'meh';
  }

  if (frame?.type === 'AgentMessage' && frame?.content?.mood != null) {
    let mood = Number(frame.content.mood);
    return Number.isFinite(mood) ? moodBand(mood) : '';
  }

  return '';
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
  if (frame?.type === 'AgentMessage')
    return { label: 'Message', icon: 'chat' };

  let toolName = String(frame?.content?.toolName || '');
  let input = isPlainObject(frame?.content?.input) ? frame.content.input : {};
  let label = COMPACT_HEADER_LABELS.get(toolName);

  if (!label && toolName.startsWith('todo-')) {
    label = todoHeaderLabel(toolName, summary, input);
  } else if (!label && toolName === 'exec') {
    let word = shellCommandFocusWord(summary.command || inputField(input, 'command'));
    if (word)
      return { label: word, icon: summary.icon || 'gear', code: true };
    label = summary.description;
  } else if (!label && toolName.startsWith('exec-') && toolName !== 'exec-read') {
    label = summary.description;
  } else if (!label) {
    label = summary.description.length <= 32 ? summary.description : humanizeToolName(toolName || frame?.type);
  }

  return {
    label: label || summary.description || 'Tool',
    icon: summary.icon || 'diamond',
  };
}

function todoHeaderLabel(toolName, summary, input) {
  let title = text(input.title);
  if (!title) {
    let match = /^[^:]+:\s*(.+)$/.exec(summary.description || '');
    title = match?.[1] || '';
  }

  switch (toolName) {
    case 'todo-get':
      return 'Read Todo List';
    case 'todo-add':
      return title ? `${title} Todo List Add` : 'Todo List Add';
    case 'todo-update':
      return title ? `${title} Todo List Update` : 'Todo List Update';
    case 'todo-complete':
      return title ? `${title} Todo List Complete` : 'Todo List Complete';
    case 'todo-delete':
      return title ? `${title} Todo List Delete` : 'Todo List Delete';
    case 'todo-clear':
      return 'Clear Todo List';
    case 'todo-focus-set':
      return title ? `${title} Todo List Focus` : 'Focus Todo List';
    case 'todo-focus-clear':
      return 'Clear Todo Focus';
    default:
      return 'Todo List';
  }
}

// Deliberately shallow shell prefix sanitising. This is not a shell parser; it
// just finds the first useful command token after common setup/echo/cd prefixes.
const SHELL_SEGMENT_SEPARATOR = /\s*(?:&&|\|\||[;|]|>>?|<<?)\s*/;
const SHELL_SUBCOMMAND_COMMANDS = new Set([
  'cargo',
  'docker',
  'gh',
  'git',
  'go',
  'kubectl',
  'npm',
  'pnpm',
  'systemctl',
  'tmux',
  'yarn',
]);
const SHELL_RUN_COMMANDS = new Set([ 'npm', 'pnpm', 'yarn' ]);
const TIMEOUT_DURATION = /^\d+(?:\.\d+)?[smhd]?$/;
const MUNDANE_SHELL_COMMANDS = new Set([
  'echo',
  'printf',
  'cd',
  'pushd',
  'popd',
  'set',
  'unset',
  'export',
  'source',
  '.',
  'true',
  'false',
  ':',
  'test',
  '[',
  'exit',
  'sleep',
  'wait',
]);

export function shellCommandFocusWord(command) {
  let text = String(command || '').trim();
  if (!text)
    return '';

  // Remove simple redirection clauses before splitting: `> file`, `2>&1`,
  // `<<EOF`. We deliberately do not read heredoc bodies.
  text = text.replace(/\d*(?:>>?|<<?)[-]?\s*(?:&\d+|'[^']*'|"[^"]*"|[^\s;|&]+)?/g, ' ').trim();
  let segments = text.split(SHELL_SEGMENT_SEPARATOR).filter((segment) => segment.trim() !== '');
  for (let segment of segments) {
    let word = firstCommandWord(segment);
    if (word && !MUNDANE_SHELL_COMMANDS.has(word))
      return commandFocusLabel(segment, word);
  }

  let word = firstCommandWord(text);
  return word ? commandFocusLabel(text, word) : '';
}

function commandFocusLabel(segment, command) {
  if (!SHELL_SUBCOMMAND_COMMANDS.has(command))
    return command;

  let parts = shellWords(segment);
  let commandIndex = parts.findIndex((part) => (
    !/^[A-Za-z_][A-Za-z0-9_]*=/.test(part)
    && cleanShellWord(part) === command
  ));
  if (commandIndex < 0)
    return command;

  let subIndex = commandIndex + 1;
  let subcommand = parts[subIndex];
  if (!subcommand || subcommand.startsWith('-'))
    return command;

  let label = `${command} ${subcommand}`;
  if (SHELL_RUN_COMMANDS.has(command) && subcommand === 'run') {
    let script = parts[subIndex + 1];
    if (script && !script.startsWith('-'))
      label += ` ${script}`;
  }

  return label;
}

function shellWords(command) {
  return String(command || '').trim().split(/\s+/).filter(Boolean);
}

function firstCommandWord(command) {
  return firstCommandWordFromParts(shellWords(command));
}

function firstCommandWordFromParts(parts, start = 0) {
  for (let index = start; index < parts.length; index++) {
    let part = parts[index];
    let assignment = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(part);
    if (assignment) {
      let inner = commandSubstitutionValue(assignment[1]);
      if (inner === '') {
        // `NAME=$( <command> ... )` leaves the command in the next word.
        let next = firstCommandWordFromParts(parts, index + 1);
        if (next)
          return next;
      } else {
        let innerParts = shellWords(inner);
        if (innerParts.length > 0) {
          let word = firstCommandWordFromParts([ ...innerParts, ...parts.slice(index + 1) ]);
          if (word)
            return word;
        }
      }
      continue;
    }

    let word = cleanShellWord(part);
    if (word === 'timeout') {
      let next = skipTimeoutPrefix(parts, index + 1);
      if (next >= parts.length)
        return 'timeout';
      index = next - 1;
      continue;
    }

    return word;
  }
  return '';
}

function skipTimeoutPrefix(parts, start) {
  let index = start;
  while (index < parts.length) {
    let word = cleanShellWord(parts[index]);
    if (word.startsWith('-')) {
      index += 1;
      continue;
    }
    if (TIMEOUT_DURATION.test(word)) {
      index += 1;
      break;
    }
    break;
  }
  return index;
}

function commandSubstitutionValue(value) {
  let text = String(value || '');
  if (text.startsWith('$('))
    return text.slice(2);
  if (text.startsWith('`'))
    return text.slice(1);
  return '';
}

function cleanShellWord(value) {
  return String(value || '').replace(/^['"]|['"]$/g, '');
}

export function compactFrameBodyDescription(frame) {
  let toolName = String(frame?.content?.toolName || '');
  if (toolName === 'exec')
    return '';

  if (frame?.type === 'CommandResult')
    return commandResultBodyDescription(frame);

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
      return path ? `<- Read file ${path}` : '<- Read file';
    case 'write-file':
      return path ? `-> Write file ${path}` : '-> Write file';
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
    case 'exec-suspend':
      return processID ? `Suspend exec task ${processID}` : 'Suspend exec task';
    case 'exec-resume':
      return processID ? `Resume exec task ${processID}` : 'Resume exec task';
    case 'session-control':
      return 'Session control';
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
    case 'AgentMessage':
      return {
        description: text(frame.content?.summary) || text(frame.content?.text) || 'Turn report',
        icon: 'chat',
        status,
      };
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

function commandResultBodyDescription(frame) {
  let content = frame.content || {};
  if (text(content.command) === 'invite') {
    let invite = inviteResultDescription(content.data);
    if (invite)
      return invite;
  }

  return text(content.text) || commandResultDescription(frame);
}

function inviteResultDescription(data) {
  if (!isPlainObject(data))
    return '';

  let agentName = text(data.agentName);
  if (agentName) {
    return data.alreadyParticipant === true
      ? `${agentName} was already in this session.`
      : `${agentName} joined this session.`;
  }

  let joined = participantNames([
    ...(Array.isArray(data.invitedAgents) ? data.invitedAgents : []),
    ...(Array.isArray(data.invitedUsers) ? data.invitedUsers : []),
  ]);
  let already = participantNames(Array.isArray(data.alreadyParticipants) ? data.alreadyParticipants : []);
  let parts = [];
  if (joined.length > 0)
    parts.push(`${formatNameList(joined)} joined this session.`);
  if (already.length > 0)
    parts.push(`${formatNameList(already)} ${already.length === 1 ? 'was' : 'were'} already in this session.`);

  return parts.join(' ');
}

function participantNames(entries) {
  let names = [];
  let seen = new Set();
  for (let entry of entries) {
    let name = text(entry?.name) || text(entry?.actorID) || text(entry?.id);
    if (!name || seen.has(name))
      continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function formatNameList(names) {
  if (names.length <= 1)
    return names[0] || '';
  if (names.length === 2)
    return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
