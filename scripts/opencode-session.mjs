#!/usr/bin/env node
'use strict';

// Read previous OpenCode sessions out of OpenCode's SQLite store.
//
// OpenCode (the harness we are migrating off of) can fail to compact, which
// means a session cannot continue once it hits the context wall. This tool is
// the recovery path: it reconstructs a session transcript directly from the
// database so a fresh session can reorient by reading the tail of the old one.
//
// Usage:
//   node scripts/opencode-session.mjs                          # list recent sessions for cwd
//   node scripts/opencode-session.mjs --list --all             # list recent sessions everywhere
//   node scripts/opencode-session.mjs <id|prefix|title>        # tail of that session
//   node scripts/opencode-session.mjs <id> --tail 80           # last 80 messages
//   node scripts/opencode-session.mjs <id> --head 20           # first 20 messages
//   node scripts/opencode-session.mjs <id> --since 2026-09-30T08:00 --full
//
// Options:
//   --db <path>        OpenCode database (default ~/.local/share/opencode/opencode.db)
//   --list             Force session listing even when an id is given
//   --all              With --list, do not filter by current directory
//   --limit N          With --list, number of sessions (default 25)
//   --tail N           Show last N messages (default 40 when no --head/--since)
//   --head N           Show first N messages
//   --since <iso>      Only messages at/after this local time
//   --until <iso>      Only messages before this local time
//   --full             Do not truncate text or tool output
//   --text N           Max text characters (default 2000)
//   --tool N           Max tool output characters (default 1200)
//   --no-thinking      Omit reasoning/thinking parts
//   --no-tools         Omit tool parts
//   --json             Emit structured JSON instead of a transcript

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// node:sqlite is experimental; Node emits an ExperimentalWarning during module
// evaluation, before any handler registered afterwards can run. Register the
// filter first, then import dynamically so the warning is swallowed here rather
// than leaking into stderr and polluting transcript output.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message))
    return;
  console.error(`${warning.name}: ${warning.message}`);
});

const { DatabaseSync } = await import('node:sqlite');

const DEFAULT_DB = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

function parseArgs(argv) {
  let options = {
    db: DEFAULT_DB,
    list: false,
    all: false,
    limit: 25,
    tail: null,
    head: null,
    since: null,
    until: null,
    full: false,
    text: 2000,
    tool: 1200,
    thinking: true,
    tools: true,
    json: false,
    target: null,
  };

  for (let index = 0; index < argv.length; index++) {
    let arg = argv[index];
    let next = () => argv[++index];

    switch (arg) {
      case '--db': options.db = next(); break;
      case '--list': options.list = true; break;
      case '--all': options.all = true; break;
      case '--limit': options.limit = Number(next()); break;
      case '--tail': options.tail = Number(next()); break;
      case '--head': options.head = Number(next()); break;
      case '--since': options.since = next(); break;
      case '--until': options.until = next(); break;
      case '--full': options.full = true; break;
      case '--text': options.text = Number(next()); break;
      case '--tool': options.tool = Number(next()); break;
      case '--no-thinking': options.thinking = false; break;
      case '--no-tools': options.tools = false; break;
      case '--json': options.json = true; break;
      case '--help': case '-h': options.help = true; break;
      default:
        if (arg.startsWith('--'))
          throw new Error(`Unknown option: ${arg}`);
        options.target = arg;
    }
  }

  if (options.full) {
    options.text = Infinity;
    options.tool = Infinity;
  }

  return options;
}

function printHelp() {
  let lines = [
    'Usage: node scripts/opencode-session.mjs [options] [id|prefix|title]',
    '',
    'Reads previous OpenCode sessions from its SQLite database.',
    '',
    'Options:',
    '  --db <path>     Database path (default ~/.local/share/opencode/opencode.db)',
    '  --list          List sessions instead of reading one',
    '  --all           With --list, do not filter by current directory',
    '  --limit N       List size (default 25)',
    '  --tail N        Last N messages (default 40)',
    '  --head N        First N messages',
    '  --since <iso>   Messages at/after local time',
    '  --until <iso>   Messages before local time',
    '  --full          No truncation',
    '  --text N        Text truncation length (default 2000)',
    '  --tool N        Tool output truncation length (default 1200)',
    '  --no-thinking   Omit reasoning parts',
    '  --no-tools      Omit tool parts',
    '  --json          Structured output',
  ];
  console.log(lines.join('\n'));
}

function localTime(ms) {
  if (ms == null)
    return '';
  return new Date(Number(ms)).toLocaleString('sv-SE', { hour12: false });
}

function openDatabase(dbPath) {
  if (!fs.existsSync(dbPath))
    throw new Error(`OpenCode database not found at ${dbPath}`);
  return new DatabaseSync(dbPath, { readOnly: true });
}

function listSessions(db, options) {
  let params = [];
  let where = '';

  if (!options.all) {
    where = 'WHERE s.directory = ?';
    params.push(process.cwd());
  }

  let rows = db.prepare(`
    SELECT s.id, s.slug, s.title, s.directory, s.parent_id, s.agent, s.model,
           s.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning,
           s.time_created, s.time_updated,
           (SELECT count(*) FROM message m WHERE m.session_id = s.id) AS message_count
    FROM session s
    ${where}
    ORDER BY s.time_updated DESC
    LIMIT ?
  `).all(...params, options.limit);

  return rows;
}

function resolveSession(db, target) {
  let exact = db.prepare('SELECT * FROM session WHERE id = ?').get(target);
  if (exact)
    return exact;

  let prefix = db.prepare('SELECT * FROM session WHERE id LIKE ? ORDER BY time_updated DESC').all(`${target}%`);
  if (prefix.length === 1)
    return prefix[0];
  if (prefix.length > 1)
    throw new Error(`Ambiguous session prefix "${target}" matches ${prefix.length} sessions; be more specific.`);

  let slug = db.prepare('SELECT * FROM session WHERE slug = ? OR slug LIKE ? ORDER BY time_updated DESC').all(target, `${target}%`);
  if (slug.length === 1)
    return slug[0];

  let exactTitle = db.prepare('SELECT * FROM session WHERE title = ? ORDER BY time_updated DESC').all(target);
  if (exactTitle.length >= 1)
    return exactTitle[0];

  let title = db.prepare('SELECT * FROM session WHERE title LIKE ? ORDER BY time_updated DESC LIMIT 5').all(`%${target}%`);
  if (title.length === 1)
    return title[0];
  if (title.length > 1) {
    let ids = title.map((row) => `${row.id} (${row.title})`).join('\n  ');
    throw new Error(`Ambiguous title "${target}"; candidates:\n  ${ids}`);
  }

  throw new Error(`No session found for "${target}".`);
}

function loadMessages(db, sessionID, options) {
  let order = 'ASC';
  let limit = '';

  if (options.head != null)
    order = 'ASC';
  else if (options.tail != null || options.since == null)
    order = 'DESC';

  let rows;

  if (options.since != null || options.until != null) {
    let clauses = [ 'session_id = ?' ];
    let params = [ sessionID ];
    if (options.since != null) {
      clauses.push('time_created >= ?');
      params.push(Date.parse(options.since));
    }
    if (options.until != null) {
      clauses.push('time_created < ?');
      params.push(Date.parse(options.until));
    }
    rows = db.prepare(`SELECT * FROM message WHERE ${clauses.join(' AND ')} ORDER BY time_created ASC, id ASC`).all(...params);
    return decorateMessages(db, rows, options);
  }

  if (options.head != null) {
    rows = db.prepare('SELECT * FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC LIMIT ?').all(sessionID, options.head);
    return decorateMessages(db, rows, options);
  }

  let tailSize = options.tail ?? 40;
  let inner = db.prepare('SELECT * FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?').all(sessionID, tailSize);
  inner.reverse();
  return decorateMessages(db, inner, options);
}

function decorateMessages(db, rows, options) {
  let messages = [];

  for (let row of rows) {
    let data = safeJSON(row.data);
    let parts = db.prepare('SELECT * FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC').all(row.id);

    let decorated = [];
    for (let part of parts) {
      let partData = safeJSON(part.data);
      let rendered = renderPart(partData, options);
      if (rendered)
        decorated.push(rendered);
    }

    messages.push({
      id: row.id,
      role: data.role || 'unknown',
      agent: data.agent || null,
      model: data.model ? `${data.model.providerID}/${data.model.modelID}` : null,
      time: Number(row.time_created),
      summary: data.summary || null,
      error: data.error || null,
      parts: decorated,
    });
  }

  return messages;
}

function renderPart(part, options) {
  if (!part || typeof part !== 'object')
    return null;

  switch (part.type) {
    case 'text':
      return { type: 'text', text: truncate(part.text || '', options.text) };
    case 'reasoning':
      if (!options.thinking)
        return null;
      return { type: 'thinking', text: truncate(part.text || '', options.text) };
    case 'tool':
      if (!options.tools)
        return null;
      return { type: 'tool', ...renderTool(part, options) };
    case 'file':
      return { type: 'file', path: part.source?.path || part.path || '', text: truncate(part.source?.text?.value || '', options.tool) };
    case 'patch':
      return { type: 'patch', files: part.files || [] };
    case 'compaction':
      return { type: 'compaction', auto: !!part.auto, overflow: !!part.overflow };
    case 'step-start':
    case 'step-finish':
      return null;
    default:
      return { type: part.type || 'unknown', text: truncate(part.text || '', options.text) };
  }
}

function renderTool(part, options) {
  let state = part.state || {};
  let input = state.input || {};
  let output = state.output || '';
  let meta = {
    tool: part.tool || 'unknown',
    status: state.status || '',
    title: state.title || '',
    input: summarizeInput(part.tool, input, options),
    output: truncate(String(output), options.tool),
  };
  return meta;
}

function summarizeInput(tool, input, options) {
  if (!input || typeof input !== 'object')
    return '';

  switch (tool) {
    case 'bash':
      return input.command || '';
    case 'write':
      return `${input.filePath || ''}\n${truncate(input.content || '', options.tool)}`;
    case 'edit':
      return `${input.filePath || ''}\n- ${truncate(input.oldString || '', 400)}\n+ ${truncate(input.newString || '', 400)}`;
    case 'read':
    case 'glob':
    case 'grep':
      return JSON.stringify(input);
    default:
      return truncate(JSON.stringify(input), options.tool);
  }
}

function truncate(text, max) {
  text = String(text ?? '');
  if (max === Infinity || text.length <= max)
    return text;
  let omitted = text.length - max;
  return `${text.slice(0, max)}\n... [truncated ${omitted} chars]`;
}

function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return { raw: text };
  }
}

function renderTranscript(session, messages, options) {
  let lines = [];
  lines.push('='.repeat(78));
  lines.push(`SESSION ${session.id}`);
  lines.push(`title:     ${session.title}`);
  lines.push(`directory: ${session.directory}`);
  if (session.parent_id)
    lines.push(`parent:    ${session.parent_id}`);
  lines.push(`created:   ${localTime(session.time_created)}   updated: ${localTime(session.time_updated)}`);
  lines.push(`tokens:    input=${session.tokens_input} output=${session.tokens_output} reasoning=${session.tokens_reasoning} cost=${session.cost}`);
  lines.push(`messages:  ${messages.length} shown`);
  lines.push('='.repeat(78));

  for (let message of messages) {
    let header = `\n### [${message.role}] ${localTime(message.time)}`;
    if (message.agent)
      header += ` (${message.agent})`;
    if (message.model)
      header += ` <${message.model}>`;
    lines.push(header);

    if (message.error) {
      let error = message.error;
      let messageText = error.data?.message || error.name || JSON.stringify(error);
      lines.push(`  [error] ${messageText}`);
    }

    if (message.parts.length === 0)
      lines.push('  (no rendered parts)');

    for (let part of message.parts) {
      switch (part.type) {
        case 'text':
          lines.push(indent(part.text.trim(), 2));
          break;
        case 'thinking':
          lines.push(indent('~ thinking ~\n' + part.text.trim(), 2));
          break;
        case 'tool':
          lines.push(indent(`$ ${part.tool} [${part.status}] ${part.title}`.trimEnd(), 2));
          if (part.input)
            lines.push(indent(part.input, 4));
          if (part.output)
            lines.push(indent(part.output, 4));
          break;
        case 'file':
          lines.push(indent(`[file] ${part.path}`, 2));
          if (part.text)
            lines.push(indent(part.text, 4));
          break;
        case 'patch':
          lines.push(indent(`[patch] ${part.files.join(', ')}`, 2));
          break;
        case 'compaction':
          lines.push(indent(`[compaction] auto=${part.auto} overflow=${part.overflow}`, 2));
          break;
        default:
          if (part.text)
            lines.push(indent(`[${part.type}]\n${part.text}`, 2));
      }
    }
  }

  return lines.join('\n');
}

function indent(text, spaces) {
  let prefix = ' '.repeat(spaces);
  return String(text).split('\n').map((line) => prefix + line).join('\n');
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  if (options.help) {
    printHelp();
    return;
  }

  let db;
  try {
    db = openDatabase(options.db);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  if (options.list || !options.target) {
    let sessions = listSessions(db, options);
    if (options.json) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }
    if (sessions.length === 0) {
      console.log(options.all ? 'No sessions found.' : `No sessions for ${process.cwd()}. Use --all to list everywhere.`);
      return;
    }
    for (let session of sessions) {
      let parent = session.parent_id ? ' \u21b3sub' : '';
      console.log(`${session.id}  ${localTime(session.time_updated)}  msgs=${String(session.message_count).padStart(4)}  ${session.title}${parent}`);
      console.log(`    ${session.directory}`);
    }
    return;
  }

  let session;
  try {
    session = resolveSession(db, options.target);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  let messages = loadMessages(db, session.id, options);

  if (options.json) {
    console.log(JSON.stringify({ session, messages }, null, 2));
    return;
  }

  console.log(renderTranscript(session, messages, options));
}

main();
