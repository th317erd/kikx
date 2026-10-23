'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ReadFileTool, WriteFileTool } from '../../../src/core/tools/index.mjs';
import { LocalFileAccessService } from '../../../src/core/tools/local-file-access-service.mjs';

/**
 * write-file must not be able to overwrite a file the caller has not proven it
 * read. The mechanism is an If-Match content hash: read-file returns one, and
 * write-file refuses anything else.
 *
 * These tests are written against the real tools end to end (read → hash →
 * write) rather than the helper in isolation, because the thing that can break
 * is the contract between the two tools returning and accepting the same value.
 */

test('read-file returns a contentHash of the whole file, even for a ranged read', async () => {
  let dir = await mkdtemp('kikx-hash-read-');
  let filePath = path.join(dir, 'sample.txt');
  await fs.writeFile(filePath, 'one\ntwo\nthree\n', 'utf8');

  let tool = createReadTool(dir);

  let whole = await tool.execute({ path: 'sample.txt' });
  assert.match(whole.contentHash, /^[0-9a-f]{64}$/);

  // A range read must report the SAME hash: the hash is a property of the file,
  // not of the slice. Otherwise a bot that read lines 1-2 would hold a value
  // nothing could ever match and every write would fail.
  let ranged = await tool.execute({ path: 'sample.txt', startLine: 1, endLine: 2 });
  assert.equal(ranged.content, 'one\ntwo\n');
  assert.equal(ranged.contentHash, whole.contentHash);
});

test('write-file refuses to overwrite a file when no hash is supplied', async () => {
  let dir = await mkdtemp('kikx-hash-missing-');
  let filePath = path.join(dir, 'sample.txt');
  await fs.writeFile(filePath, 'original\n', 'utf8');

  let tool = createWriteTool(dir);

  await assert.rejects(
    () => tool.execute({ path: 'sample.txt', content: 'clobbered\n' }),
    /requires expectedContentHash.*read-file/s,
  );

  assert.equal(await fs.readFile(filePath, 'utf8'), 'original\n');
});

test('write-file refuses a hash that no longer matches, naming the remedy', async () => {
  let dir = await mkdtemp('kikx-hash-stale-');
  let filePath = path.join(dir, 'sample.txt');
  await fs.writeFile(filePath, 'original\n', 'utf8');

  let read = createReadTool(dir);
  let write = createWriteTool(dir);
  let observed = await read.execute({ path: 'sample.txt' });

  // Someone else changes the file between the read and the write.
  await fs.writeFile(filePath, 'changed underneath you\n', 'utf8');

  await assert.rejects(
    () => write.execute({
      path: 'sample.txt',
      content: 'clobbered\n',
      expectedContentHash: observed.contentHash,
    }),
    /File has changed since last read\. Please read it again, and provide the correct write content hash/s,
  );

  assert.equal(await fs.readFile(filePath, 'utf8'), 'changed underneath you\n');
});

test('write-file succeeds when the hash proves the read', async () => {
  let dir = await mkdtemp('kikx-hash-ok-');
  let filePath = path.join(dir, 'sample.txt');
  await fs.writeFile(filePath, 'original\n', 'utf8');

  let read = createReadTool(dir);
  let write = createWriteTool(dir);
  let observed = await read.execute({ path: 'sample.txt' });

  let result = await write.execute({
    path: 'sample.txt',
    content: 'replaced\n',
    expectedContentHash: observed.contentHash,
  });

  assert.equal(result.created, false);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'replaced\n');
});

test('a file that appeared since the read cannot be written without its hash', async () => {
  let dir = await mkdtemp('kikx-hash-created-');
  let filePath = path.join(dir, 'new.txt');

  let write = createWriteTool(dir);

  // The caller believes the file does not exist, and for a moment it did not —
  // but it appears before the write. This is the case the user called out: it
  // must fail, not silently overwrite.
  assert.equal(await exists(filePath), false);
  await fs.writeFile(filePath, 'someone else got here first\n', 'utf8');

  await assert.rejects(
    () => write.execute({ path: 'new.txt', content: 'mine\n' }),
    /requires expectedContentHash.*read-file/s,
  );

  assert.equal(await fs.readFile(filePath, 'utf8'), 'someone else got here first\n');
});

test('a genuinely new file needs no hash', async () => {
  let dir = await mkdtemp('kikx-hash-new-');
  let tool = createWriteTool(dir);

  let result = await tool.execute({ path: 'fresh.txt', content: 'hello\n' });
  assert.equal(result.created, true);
  assert.equal(await fs.readFile(path.join(dir, 'fresh.txt'), 'utf8'), 'hello\n');
});

test('append still demands the current hash', async () => {
  let dir = await mkdtemp('kikx-hash-append-');
  let filePath = path.join(dir, 'log.txt');
  await fs.writeFile(filePath, 'one\n', 'utf8');

  let read = createReadTool(dir);
  let write = createWriteTool(dir);

  await assert.rejects(
    () => write.execute({ path: 'log.txt', content: 'two\n', mode: 'append' }),
    /requires expectedContentHash/s,
  );

  let observed = await read.execute({ path: 'log.txt' });
  let result = await write.execute({
    path: 'log.txt',
    content: 'two\n',
    mode: 'append',
    expectedContentHash: observed.contentHash,
  });

  assert.equal(result.appended, true);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'one\ntwo\n');
});

test('a hashed write to a file that vanished is refused rather than silently recreated', async () => {
  let dir = await mkdtemp('kikx-hash-vanished-');
  let filePath = path.join(dir, 'gone.txt');
  await fs.writeFile(filePath, 'here\n', 'utf8');

  let read = createReadTool(dir);
  let write = createWriteTool(dir);
  let observed = await read.execute({ path: 'gone.txt' });

  await fs.rm(filePath);

  // The caller proved it read a file that no longer exists; guessing what that
  // means for `create` vs `overwrite` is worse than making it re-read.
  await assert.rejects(
    () => write.execute({
      path: 'gone.txt',
      content: 'back\n',
      expectedContentHash: observed.contentHash,
    }),
    /expected an existing file to overwrite, but it no longer exists/s,
  );

  assert.equal(await exists(filePath), false);
});

test('a malformed hash is rejected as a type error, not treated as absent', async () => {
  let dir = await mkdtemp('kikx-hash-malformed-');
  await fs.writeFile(path.join(dir, 'sample.txt'), 'x\n', 'utf8');

  let tool = createWriteTool(dir);

  await assert.rejects(
    () => tool.execute({ path: 'sample.txt', content: 'y\n', expectedContentHash: 'not-a-hash' }),
    /must be a 64-character sha256 hex digest/s,
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createReadTool(cwd) {
  return new ReadFileTool({ services: { fileAccess: new LocalFileAccessService({ cwd }) } });
}

function createWriteTool(cwd) {
  return new WriteFileTool({ services: { fileAccess: new LocalFileAccessService({ cwd }) } });
}

async function mkdtemp(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function exists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT')
      return false;

    throw error;
  }
}
