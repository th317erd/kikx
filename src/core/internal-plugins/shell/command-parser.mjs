'use strict';

import { parse } from 'shell-quote';

// =============================================================================
// Command Parser
// =============================================================================
// Parses a shell command string into individual commands using shell-quote.
// Handles pipes, chains (&&, ||), semicolons, and background operators.
//
// Example:
//   parseShellCommands('cd /tmp & ls | tail -n 30')
//   => [
//     { command: 'cd', arguments: ['/tmp'] },
//     { command: 'ls', arguments: [] },
//     { command: 'tail', arguments: ['-n', '30'] },
//   ]
// =============================================================================

export function parseShellCommands(input) {
  if (!input || typeof input !== 'string')
    return [];

  let trimmed = input.trim();
  if (!trimmed)
    return [];

  let tokens    = parse(trimmed);
  let commands  = [];
  let current   = { command: null, arguments: [] };

  // Track heredoc state: shell-quote splits << into two { op: '<' } tokens.
  // When we detect that pattern, consume all remaining tokens until the
  // delimiter appears again, treating everything as part of the current command.
  let heredocDelimiter = null;
  let lastWasRedirect  = false;

  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i];

    // Inside a heredoc — consume tokens until we see the closing delimiter
    if (heredocDelimiter) {
      if (typeof token === 'string' && token === heredocDelimiter)
        heredocDelimiter = null; // Heredoc closed, resume normal parsing

      // Either way, skip heredoc body tokens (they're content, not commands)
      continue;
    }

    if (typeof token === 'string') {
      if (lastWasRedirect) {
        // This string follows << — it's the heredoc delimiter
        // Strip leading - (<<-WORD strips tabs) and quotes
        heredocDelimiter = token.replace(/^-/, '').replace(/^['"]|['"]$/g, '');
        lastWasRedirect  = false;
        continue;
      }

      if (!current.command)
        current.command = token;
      else
        current.arguments.push(token);
    } else if (token && token.op) {
      // Detect << (heredoc): shell-quote emits two consecutive { op: '<' }
      if (token.op === '<') {
        let next = tokens[i + 1];
        if (next && next.op === '<') {
          lastWasRedirect = true;
          i++; // Skip the second '<'
          continue;
        }
      }

      // Redirections (< , >) are part of the current command, not separators.
      if (token.op === '<' || token.op === '>') {
        // Next token is the filename — consume it as an argument
        let next = tokens[i + 1];
        if (next && typeof next === 'string') {
          current.arguments.push(next);
          i++;
        }

        continue;
      }

      // Command separator: |, &, &&, ||, ;, etc.
      if (current.command)
        commands.push({ ...current });

      current = { command: null, arguments: [] };
    }
  }

  // Push final command
  if (current.command)
    commands.push(current);

  return commands;
}
