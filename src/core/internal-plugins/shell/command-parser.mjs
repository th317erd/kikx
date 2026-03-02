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

  let tokens   = parse(trimmed);
  let commands  = [];
  let current   = { command: null, arguments: [] };

  for (let token of tokens) {
    if (typeof token === 'string') {
      if (!current.command)
        current.command = token;
      else
        current.arguments.push(token);
    } else if (token && token.op) {
      // Operator: |, &, &&, ||, ;, etc.
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
