'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseShellCommands } from '../../../../src/core/internal-plugins/shell/command-parser.mjs';

// =============================================================================
// Shell Command Parser
// =============================================================================

describe('parseShellCommands', () => {
  it('should parse a simple command', () => {
    let result = parseShellCommands('ls');
    assert.deepEqual(result, [
      { command: 'ls', arguments: [] },
    ]);
  });

  it('should parse a command with arguments', () => {
    let result = parseShellCommands('ls -la /tmp');
    assert.deepEqual(result, [
      { command: 'ls', arguments: ['-la', '/tmp'] },
    ]);
  });

  it('should parse a pipe', () => {
    let result = parseShellCommands('ls | grep foo');
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { command: 'ls', arguments: [] });
    assert.deepEqual(result[1], { command: 'grep', arguments: ['foo'] });
  });

  it('should parse a background operator', () => {
    let result = parseShellCommands('cd /tmp & ls');
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { command: 'cd', arguments: ['/tmp'] });
    assert.deepEqual(result[1], { command: 'ls', arguments: [] });
  });

  it('should parse a chain (&&)', () => {
    let result = parseShellCommands('mkdir test && cd test');
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { command: 'mkdir', arguments: ['test'] });
    assert.deepEqual(result[1], { command: 'cd', arguments: ['test'] });
  });

  it('should parse semicolons', () => {
    let result = parseShellCommands('echo a; echo b');
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { command: 'echo', arguments: ['a'] });
    assert.deepEqual(result[1], { command: 'echo', arguments: ['b'] });
  });

  it('should parse complex pipelines', () => {
    let result = parseShellCommands('cd & ls | tail -n 30');
    assert.equal(result.length, 3);
    assert.deepEqual(result[0], { command: 'cd', arguments: [] });
    assert.deepEqual(result[1], { command: 'ls', arguments: [] });
    assert.deepEqual(result[2], { command: 'tail', arguments: ['-n', '30'] });
  });

  it('should handle quoted strings', () => {
    let result = parseShellCommands('echo "hello world"');
    assert.deepEqual(result, [
      { command: 'echo', arguments: ['hello world'] },
    ]);
  });

  it('should handle single-quoted strings', () => {
    let result = parseShellCommands("echo 'hello world'");
    assert.deepEqual(result, [
      { command: 'echo', arguments: ['hello world'] },
    ]);
  });

  it('should return empty array for empty string', () => {
    let result = parseShellCommands('');
    assert.deepEqual(result, []);
  });

  it('should return empty array for whitespace only', () => {
    let result = parseShellCommands('   ');
    assert.deepEqual(result, []);
  });

  it('should return empty array for null input', () => {
    assert.deepEqual(parseShellCommands(null), []);
    assert.deepEqual(parseShellCommands(undefined), []);
  });

  it('should parse or operator (||)', () => {
    let result = parseShellCommands('test -f file || echo missing');
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { command: 'test', arguments: ['-f', 'file'] });
    assert.deepEqual(result[1], { command: 'echo', arguments: ['missing'] });
  });

  it('should handle multiple flags', () => {
    let result = parseShellCommands('find . -name "*.mjs" -type f');
    assert.deepEqual(result, [
      { command: 'find', arguments: ['.', '-name', '*.mjs', '-type', 'f'] },
    ]);
  });
});
