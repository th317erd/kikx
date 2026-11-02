'use strict';

// Shell-command summary helpers kept separate from frame status/description
// vocabulary so the compact summary module stays under the source cap.

// Deliberately shallow shell prefix sanitising. This is not a shell parser; it
// just finds the first useful command token after common setup/echo/cd prefixes.
const SHELL_GROUPING_TOKENS = new Set([ '{', '}', '(', ')', '!' ]);
const SHELL_BLOCK_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi',
  'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'select', 'function',
]);
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
const SHELL_PRIVILEGE_PREFIXES = new Set([ 'sudo', 'doas', 'pkexec' ]);
const SHELL_PRIVILEGE_OPTIONS_WITH_ARGUMENT = new Map([
  [ 'sudo', new Set([
    '-u', '-g', '-p', '-C', '-T', '-h', '-r', '-t', '-U', '-D', '-R',
    '--user', '--group', '--prompt', '--close-from', '--host', '--role',
    '--type', '--other-user', '--chdir', '--chroot',
  ]) ],
  [ 'doas', new Set([ '-u', '-C' ]) ],
  [ 'pkexec', new Set([ '--user' ]) ],
]);
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
  let text = stripShellCommentLines(stripHeredocBodies(String(command || '').trim()));
  if (!text)
    return '';

  // Remove simple redirection clauses before splitting: `> file`, `2>&1`,
  // `<<EOF`. Heredoc bodies were removed above so their contents cannot be
  // mistaken for commands.
  text = text.replace(/\d*(?:>>?|<<?)[-]?\s*(?:&\d+|'[^']*'|"[^"]*"|[^\s;|&]+)?/g, ' ').trim();
  let segments = splitShellSegments(text);
  for (let segment of segments) {
    let word = firstCommandWord(segment);
    if (word && !MUNDANE_SHELL_COMMANDS.has(word))
      return commandFocusLabel(segment, word);
  }

  let word = firstCommandWord(text);
  return word ? commandFocusLabel(text, word) : 'shell';
}

function stripHeredocBodies(text) {
  let lines = text.split(/\r?\n/);
  let output = [];
  let terminator = '';

  for (let line of lines) {
    if (terminator !== '') {
      if (line.trim() === terminator)
        terminator = '';
      continue;
    }

    output.push(line);
    let match = /(?:^|\s)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (match)
      terminator = match[2];
  }

  return output.join('\n');
}

function stripShellCommentLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

function splitShellSegments(text) {
  let segments = [];
  let current = '';
  let quote = null;
  let escaped = false;
  // Each command substitution splits its contents into their own segments.
  // Remember the outer quote state so the `)` restores it; without this,
  // `echo "$(pwd)" && ...` treats the closing quote as a new opening quote and
  // swallows the rest of the command into the label.
  let substitutionQuotes = [];

  for (let index = 0; index < text.length; index++) {
    let char = text[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if (quote !== "'" && char === '$' && text[index + 1] === '(') {
      segments.push(current);
      current = '';
      substitutionQuotes.push(quote);
      quote = null;
      index += 1;
      continue;
    }

    if (char === ')' && quote === null && substitutionQuotes.length > 0) {
      segments.push(current);
      current = '';
      quote = substitutionQuotes.pop();
      continue;
    }

    if (quote !== null) {
      current += char;
      if (char === quote)
        quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === '\n' || char === ';') {
      segments.push(current);
      current = '';
      continue;
    }

    if (char === '&' || char === '|') {
      segments.push(current);
      current = '';
      if (text[index + 1] === char)
        index += 1;
      continue;
    }

    current += char;
  }

  segments.push(current);
  return segments.filter((segment) => segment.trim() !== '');
}

function commandFocusLabel(segment, command) {
  if (!SHELL_SUBCOMMAND_COMMANDS.has(command))
    return commandBasename(command);

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
  let text = String(command || '').trim();
  let words = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (let char of text) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if (quote !== null) {
      current += char;
      if (char === quote)
        quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current !== '') {
        words.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current !== '')
    words.push(current);
  return words;
}

function unquotedShellValue(value) {
  let text = String(value || '');
  if (text.length < 2)
    return '';
  let quote = text[0];
  if ((quote === '"' || quote === "'") && text.endsWith(quote))
    return text.slice(1, -1);
  return '';
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
        let quoted = unquotedShellValue(assignment[1]);
        let first = shellWords(quoted)[0] || '';
        if (quoted !== '' && /\s/.test(quoted) && isPlausibleCommandWord(first))
          inner = quoted;
      }
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
    if (SHELL_GROUPING_TOKENS.has(word))
      continue;
    if (SHELL_BLOCK_KEYWORDS.has(word))
      return '';
    if (word.startsWith('-') || word.startsWith('*') || word.startsWith('?'))
      continue;
    if (word.startsWith('$'))
      return 'shell';
    if (SHELL_PRIVILEGE_PREFIXES.has(word)) {
      let next = skipPrivilegePrefix(parts, index + 1, word);
      if (next >= parts.length)
        return word;
      index = next - 1;
      continue;
    }

    if (word === 'timeout' || word === 'command') {
      let next = skipTimeoutPrefix(parts, index + 1);
      if (next >= parts.length)
        return word;
      index = next - 1;
      continue;
    }

    return word;
  }
  return '';
}

function skipPrivilegePrefix(parts, start, command) {
  let optionsWithArgument = SHELL_PRIVILEGE_OPTIONS_WITH_ARGUMENT.get(command) || new Set();
  let index = start;
  while (index < parts.length) {
    let word = cleanShellWord(parts[index]);
    if (word === '--') {
      index += 1;
      break;
    }
    if (!word.startsWith('-'))
      break;

    let option = word.split('=', 1)[0];
    let takesArgument = !word.includes('=') && optionsWithArgument.has(option);
    index += takesArgument ? 2 : 1;
  }
  return index;
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

function isPlausibleCommandWord(value) {
  return /^(?:[a-z][A-Za-z0-9_./-]*|[./~][A-Za-z0-9_./~-]+)$/.test(String(value || ''));
}

function commandBasename(command) {
  let text = String(command || '');
  let index = text.lastIndexOf('/');
  let base = index >= 0 ? text.slice(index + 1) : text;
  return base || text;
}

function cleanShellWord(value) {
  return String(value || '')
    .replace(/^['"]|['"]$/g, '')
    .replace(/^[({!]+/, '')
    .replace(/[(){}]+$/, '');
}
