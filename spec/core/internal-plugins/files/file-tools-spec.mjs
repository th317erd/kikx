'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert           from 'node:assert/strict';
import fs               from 'node:fs/promises';
import path             from 'node:path';
import os               from 'node:os';
import { PluginInterface } from '../../../../src/core/plugin-loader/plugin-interface.mjs';
import { PluginRegistry }  from '../../../../src/core/plugin-loader/registry.mjs';
import { setup as filesSetup } from '../../../../src/core/internal-plugins/files/index.mjs';

// =============================================================================
// Helpers
// =============================================================================

function createFileTools() {
  let registry = new PluginRegistry();
  let context  = { getProperty: () => null };

  filesSetup({
    registerTool:    (name, cls) => registry.registerTool(name, cls),
    PluginInterface,
    context,
  });

  let ReadClass  = registry.getTool('files:read');
  let WriteClass = registry.getTool('files:write');
  let EditClass  = registry.getTool('files:edit');

  return {
    readTool:  new ReadClass(context),
    writeTool: new WriteClass(context),
    editTool:  new EditClass(context),
    registry,
    ReadClass,
    WriteClass,
    EditClass,
  };
}

let testDir;

async function createTestDir() {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-file-tools-'));
  return testDir;
}

async function cleanupTestDir() {
  if (testDir) {
    await fs.rm(testDir, { recursive: true, force: true });
    testDir = null;
  }
}

// =============================================================================
// Registration
// =============================================================================

describe('Files plugin registration', () => {
  it('registers files:read tool', () => {
    let { ReadClass } = createFileTools();
    assert.ok(ReadClass, 'files:read should be registered');
  });

  it('registers files:write tool', () => {
    let { WriteClass } = createFileTools();
    assert.ok(WriteClass, 'files:write should be registered');
  });

  it('registers files:edit tool', () => {
    let { EditClass } = createFileTools();
    assert.ok(EditClass, 'files:edit should be registered');
  });

  it('all tools extend PluginInterface', () => {
    let { readTool, writeTool, editTool } = createFileTools();
    assert.ok(readTool instanceof PluginInterface);
    assert.ok(writeTool instanceof PluginInterface);
    assert.ok(editTool instanceof PluginInterface);
  });

  it('all tools have riskLevel high', () => {
    let { ReadClass, WriteClass, EditClass } = createFileTools();
    assert.equal(ReadClass.riskLevel, 'high');
    assert.equal(WriteClass.riskLevel, 'high');
    assert.equal(EditClass.riskLevel, 'high');
  });
});

// =============================================================================
// files:read
// =============================================================================

describe('files:read', () => {
  beforeEach(async () => { await createTestDir(); });
  afterEach(async () => { await cleanupTestDir(); });

  it('reads a file and returns numbered content', async () => {
    let { readTool } = createFileTools();
    let filePath     = path.join(testDir, 'test.txt');
    await fs.writeFile(filePath, 'line1\nline2\nline3\n', 'utf8');

    let result = await readTool.execute({ filePath });

    assert.equal(result.lineCount, 3);
    assert.equal(result.totalLines, 3);
    assert.equal(result.filePath, filePath);
    assert.equal(result.truncated, false);
    assert.ok(result.content.includes('line1'));
    assert.ok(result.content.includes('line2'));
    assert.ok(result.content.includes('line3'));
  });

  it('includes _renderHint with renderType file-read', async () => {
    let { readTool } = createFileTools();
    let filePath     = path.join(testDir, 'test.mjs');
    await fs.writeFile(filePath, 'let x = 1;\n', 'utf8');

    let result = await readTool.execute({ filePath });

    assert.ok(result._renderHint, '_renderHint should be present');
    assert.equal(result._renderHint.renderType, 'file-read');
    assert.equal(result._renderHint.renderData.filePath, filePath);
    assert.equal(result._renderHint.renderData.language, 'javascript');
    assert.equal(result._renderHint.renderData.lineCount, 1);
  });

  it('respects offset and limit', async () => {
    let { readTool } = createFileTools();
    let filePath     = path.join(testDir, 'long.txt');
    let lines        = [];
    for (let i = 1; i <= 100; i++)
      lines.push(`line ${i}`);

    await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf8');

    let result = await readTool.execute({ filePath, offset: 10, limit: 5 });

    assert.equal(result.lineCount, 5);
    assert.equal(result.totalLines, 100);
    assert.equal(result.truncated, true);
    assert.ok(result.content.includes('line 11'));
    assert.ok(result.content.includes('line 15'));
    assert.ok(!result.content.includes('line 16'));
  });

  it('throws for non-existent file', async () => {
    let { readTool } = createFileTools();

    await assert.rejects(
      () => readTool.execute({ filePath: path.join(testDir, 'nonexistent.txt') }),
      (error) => error.message.includes('File not found'),
    );
  });

  it('throws for directory path', async () => {
    let { readTool } = createFileTools();

    await assert.rejects(
      () => readTool.execute({ filePath: testDir }),
      (error) => error.message.includes('directory'),
    );
  });

  it('throws for binary file', async () => {
    let { readTool } = createFileTools();
    let filePath     = path.join(testDir, 'binary.bin');

    // Write a buffer with null bytes
    let buffer = Buffer.alloc(256);
    buffer[0]  = 0x89;
    buffer[10] = 0x00;  // null byte
    await fs.writeFile(filePath, buffer);

    await assert.rejects(
      () => readTool.execute({ filePath }),
      (error) => error.message.includes('binary'),
    );
  });

  it('throws if filePath is missing', async () => {
    let { readTool } = createFileTools();

    await assert.rejects(
      () => readTool.execute({}),
      (error) => error.message.includes('filePath is required'),
    );
  });

  it('caps lines at MAX_LINES (2000)', async () => {
    let { readTool } = createFileTools();
    let filePath     = path.join(testDir, 'huge.txt');
    let lines        = [];
    for (let i = 1; i <= 3000; i++)
      lines.push(`line ${i}`);

    await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf8');

    let result = await readTool.execute({ filePath });

    assert.equal(result.lineCount, 2000);
    assert.equal(result.totalLines, 3000);
    assert.equal(result.truncated, true);
  });

  it('handles empty file', async () => {
    let { readTool } = createFileTools();
    let filePath     = path.join(testDir, 'empty.txt');
    await fs.writeFile(filePath, '', 'utf8');

    let result = await readTool.execute({ filePath });

    assert.equal(result.lineCount, 0);
    assert.equal(result.truncated, false);
  });

  it('detects language from extension', async () => {
    let { readTool } = createFileTools();
    let filePath     = path.join(testDir, 'test.py');
    await fs.writeFile(filePath, 'print("hi")\n', 'utf8');

    let result = await readTool.execute({ filePath });

    assert.equal(result._renderHint.renderData.language, 'python');
  });
});

// =============================================================================
// files:write
// =============================================================================

describe('files:write', () => {
  beforeEach(async () => { await createTestDir(); });
  afterEach(async () => { await cleanupTestDir(); });

  it('creates a new file', async () => {
    let { writeTool } = createFileTools();
    let filePath      = path.join(testDir, 'new.txt');

    let result = await writeTool.execute({ filePath, content: 'hello world\n' });

    assert.equal(result.created, true);
    assert.ok(result.message.includes('Created'));

    let written = await fs.readFile(filePath, 'utf8');
    assert.equal(written, 'hello world\n');
  });

  it('overwrites an existing file', async () => {
    let { writeTool } = createFileTools();
    let filePath      = path.join(testDir, 'existing.txt');
    await fs.writeFile(filePath, 'old content\n', 'utf8');

    let result = await writeTool.execute({ filePath, content: 'new content\n' });

    assert.equal(result.created, false);
    assert.ok(result.message.includes('Updated'));

    let written = await fs.readFile(filePath, 'utf8');
    assert.equal(written, 'new content\n');
  });

  it('includes _renderHint with diff data', async () => {
    let { writeTool } = createFileTools();
    let filePath      = path.join(testDir, 'diffed.txt');
    await fs.writeFile(filePath, 'aaa\nbbb\nccc\n', 'utf8');

    let result = await writeTool.execute({ filePath, content: 'aaa\nBBB\nccc\n' });

    assert.ok(result._renderHint);
    assert.equal(result._renderHint.renderType, 'file-write');
    assert.ok(result._renderHint.renderData.diff);
    assert.equal(result._renderHint.renderData.diff.additions, 1);
    assert.equal(result._renderHint.renderData.diff.removals, 1);
  });

  it('creates parent directories when requested', async () => {
    let { writeTool } = createFileTools();
    let filePath      = path.join(testDir, 'nested', 'deep', 'file.txt');

    let result = await writeTool.execute({ filePath, content: 'nested\n', createDirectories: true });

    assert.equal(result.created, true);

    let written = await fs.readFile(filePath, 'utf8');
    assert.equal(written, 'nested\n');
  });

  it('throws if filePath is missing', async () => {
    let { writeTool } = createFileTools();

    await assert.rejects(
      () => writeTool.execute({ content: 'hello' }),
      (error) => error.message.includes('filePath is required'),
    );
  });

  it('throws if content is missing', async () => {
    let { writeTool } = createFileTools();

    await assert.rejects(
      () => writeTool.execute({ filePath: path.join(testDir, 'x.txt') }),
      (error) => error.message.includes('content is required'),
    );
  });

  it('throws when writing to a directory path', async () => {
    let { writeTool } = createFileTools();

    await assert.rejects(
      () => writeTool.execute({ filePath: testDir, content: 'nope' }),
      (error) => error.message.includes('directory'),
    );
  });

  it('handles writing empty content', async () => {
    let { writeTool } = createFileTools();
    let filePath      = path.join(testDir, 'empty-write.txt');

    let result = await writeTool.execute({ filePath, content: '' });
    assert.equal(result.created, true);

    let written = await fs.readFile(filePath, 'utf8');
    assert.equal(written, '');
  });
});

// =============================================================================
// files:edit
// =============================================================================

describe('files:edit', () => {
  beforeEach(async () => { await createTestDir(); });
  afterEach(async () => { await cleanupTestDir(); });

  it('replaces a unique string in a file', async () => {
    let { editTool } = createFileTools();
    let filePath     = path.join(testDir, 'edit.txt');
    await fs.writeFile(filePath, 'hello world\ngoodbye world\n', 'utf8');

    let result = await editTool.execute({
      filePath,
      oldString: 'hello world',
      newString: 'HELLO WORLD',
    });

    assert.ok(result.message.includes('Edited'));

    let content = await fs.readFile(filePath, 'utf8');
    assert.ok(content.includes('HELLO WORLD'));
    assert.ok(content.includes('goodbye world'));
  });

  it('includes _renderHint with diff data', async () => {
    let { editTool } = createFileTools();
    let filePath     = path.join(testDir, 'edit-hint.txt');
    await fs.writeFile(filePath, 'foo\nbar\nbaz\n', 'utf8');

    let result = await editTool.execute({
      filePath,
      oldString: 'bar',
      newString: 'BAR',
    });

    assert.ok(result._renderHint);
    assert.equal(result._renderHint.renderType, 'file-write');
    assert.ok(result._renderHint.renderData.diff);
    assert.equal(result._renderHint.renderData.created, false);
  });

  it('throws if oldString is not found', async () => {
    let { editTool } = createFileTools();
    let filePath     = path.join(testDir, 'no-match.txt');
    await fs.writeFile(filePath, 'hello world\n', 'utf8');

    await assert.rejects(
      () => editTool.execute({ filePath, oldString: 'DOES NOT EXIST', newString: 'x' }),
      (error) => error.message.includes('not found'),
    );
  });

  it('throws if oldString is not unique', async () => {
    let { editTool } = createFileTools();
    let filePath     = path.join(testDir, 'duplicate.txt');
    await fs.writeFile(filePath, 'abc\nabc\nabc\n', 'utf8');

    await assert.rejects(
      () => editTool.execute({ filePath, oldString: 'abc', newString: 'xyz' }),
      (error) => error.message.includes('not unique'),
    );
  });

  it('throws if oldString equals newString', async () => {
    let { editTool } = createFileTools();
    let filePath     = path.join(testDir, 'same.txt');
    await fs.writeFile(filePath, 'hello\n', 'utf8');

    await assert.rejects(
      () => editTool.execute({ filePath, oldString: 'hello', newString: 'hello' }),
      (error) => error.message.includes('identical'),
    );
  });

  it('throws for non-existent file', async () => {
    let { editTool } = createFileTools();

    await assert.rejects(
      () => editTool.execute({
        filePath:  path.join(testDir, 'ghost.txt'),
        oldString: 'a',
        newString: 'b',
      }),
      (error) => error.message.includes('File not found'),
    );
  });

  it('throws if filePath is missing', async () => {
    let { editTool } = createFileTools();

    await assert.rejects(
      () => editTool.execute({ oldString: 'a', newString: 'b' }),
      (error) => error.message.includes('filePath is required'),
    );
  });

  it('throws if oldString is missing', async () => {
    let { editTool } = createFileTools();

    await assert.rejects(
      () => editTool.execute({ filePath: path.join(testDir, 'x.txt'), newString: 'b' }),
      (error) => error.message.includes('oldString is required'),
    );
  });

  it('throws if newString is missing', async () => {
    let { editTool } = createFileTools();

    await assert.rejects(
      () => editTool.execute({ filePath: path.join(testDir, 'x.txt'), oldString: 'a' }),
      (error) => error.message.includes('newString is required'),
    );
  });

  it('handles multi-line replacements', async () => {
    let { editTool } = createFileTools();
    let filePath     = path.join(testDir, 'multiline.txt');
    await fs.writeFile(filePath, 'start\nold line 1\nold line 2\nend\n', 'utf8');

    let result = await editTool.execute({
      filePath,
      oldString: 'old line 1\nold line 2',
      newString: 'new line 1\nnew line 2\nnew line 3',
    });

    let content = await fs.readFile(filePath, 'utf8');
    assert.ok(content.includes('new line 1'));
    assert.ok(content.includes('new line 2'));
    assert.ok(content.includes('new line 3'));
    assert.ok(!content.includes('old line'));
  });
});

// =============================================================================
// Integration — auto-load via KikxCore
// =============================================================================

describe('Files plugin integration', () => {
  let core;

  beforeEach(async () => {
    let { createKikxCore } = await import('../../../../src/core/index.mjs');
    core = createKikxCore();
    await core.start();
  });

  afterEach(async () => {
    if (core && core.isStarted())
      await core.stop();
  });

  it('auto-loads files:read as internal plugin', () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('files:read');
    assert.ok(ToolClass, 'files:read should be auto-loaded');
  });

  it('auto-loads files:write as internal plugin', () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('files:write');
    assert.ok(ToolClass, 'files:write should be auto-loaded');
  });

  it('auto-loads files:edit as internal plugin', () => {
    let registry  = core.getPluginRegistry();
    let ToolClass = registry.getTool('files:edit');
    assert.ok(ToolClass, 'files:edit should be auto-loaded');
  });
});
