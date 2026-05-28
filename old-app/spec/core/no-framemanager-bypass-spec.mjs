'use strict';

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Recursively get all .mjs files under a directory
function getAllFiles(dir, ext = '.mjs') {
  let results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === 'spec') continue;
    if (statSync(full).isDirectory()) results.push(...getAllFiles(full, ext));
    else if (full.endsWith(ext)) results.push(full);
  }
  return results;
}

// Files that are ALLOWED to have .save() — these are NOT frame mutations.
// ORM model definitions, auth, user/agent/session/permission persistence, etc.
const SAVE_ALLOWLIST = new Set([
  // Auth / user / agent model saves — NOT frame mutations
  'src/server/auth/index.mjs',
  'src/server/controllers/agent-controller.mjs',
  'src/server/controllers/auth-controller.mjs',
  'src/server/controllers/dm-controller.mjs',
  'src/server/app/controllers/user-controller.mjs',
  'src/server/app/controllers/organization-controller.mjs',
  'src/server/app/commands/test-email-command.mjs',
  // ORM model internals (upsert patterns, not frame mutations)
  'src/core/models/user-model.mjs',
  'src/core/models/session-model.mjs',
  'src/core/models/agent-model.mjs',
  // Permissions — rule.save() on PermissionRule model, not frames
  'src/core/permissions/permissions-base.mjs',
  // Session/participant lifecycle — session.save(), participant.save()
  'src/core/session/index.mjs',
  // DM summarizer — agentRecord.save(), not frames
  'src/core/dm/dm-summarizer.mjs',
  // ValueStore — key/value store entries, not frames
  'src/core/lib/value-store-service.mjs',
  // Memory plugin — memory entries, not frames
  'src/core/internal-plugins/memory/index.mjs',
  // FramePersistence internals — the ONLY place that should do ORM saves on frames
  'src/core/frames/index.mjs',
  // App-level models — processable base, roles, notifications, user model
  'src/server/app/models/processable-base.mjs',
  'src/server/app/models/role-model.mjs',
  'src/server/app/models/notification-model.mjs',
  'src/server/app/models/user-model.mjs',
]);

describe('No FrameManager Bypasses', () => {
  let srcFiles;

  before(() => {
    srcFiles = getAllFiles('src');
  });

  it('no direct .save() on frame models outside allowlist', () => {
    const violations = [];

    for (const file of srcFiles) {
      const relPath = file.replace(process.cwd() + '/', '');
      if (SAVE_ALLOWLIST.has(relPath)) continue;

      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comments
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

        // Detect .save() calls — but skip known safe patterns:
        //   - Comments mentioning .save() (e.g., "no direct .save()")
        //   - Definitions of save methods (e.g., "async save()")
        if (line.includes('.save()')) {
          // Skip lines that are just documentation/comments about .save()
          if (line.includes('no direct .save()') || line.includes('No direct .save()')) continue;
          violations.push(`${relPath}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    assert.equal(violations.length, 0,
      `Found .save() calls that may bypass FrameManager. If these are NOT frame mutations, ` +
      `add the file to SAVE_ALLOWLIST in this test with a comment explaining why:\n` +
      violations.join('\n'));
  });

  it('no manual emit("commit") outside FrameManager and InteractionLoop', () => {
    const violations = [];

    for (const file of srcFiles) {
      const relPath = file.replace(process.cwd() + '/', '');
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

        if (line.includes("emit('commit'") || line.includes('emit("commit"')) {
          // Allowed: inside FrameManager (the source of truth for commits)
          if (relPath.includes('frame-manager')) continue;
          // Allowed: inside InteractionLoop (_createFrame / updateFrame wrappers)
          if (relPath.includes('interaction/index.mjs')) continue;

          violations.push(`${relPath}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    assert.equal(violations.length, 0,
      `Found manual emit('commit') outside blessed locations (FrameManager, InteractionLoop).\n` +
      `Frame commits MUST go through FrameManager.merge():\n` +
      violations.join('\n'));
  });

  it('no direct updateFrameState() calls outside its deprecated definition', () => {
    const violations = [];

    for (const file of srcFiles) {
      const relPath = file.replace(process.cwd() + '/', '');
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

        if (line.includes('updateFrameState(')) {
          // Allow the function definition itself (async updateFrameState)
          if (line.includes('async updateFrameState')) continue;
          // Allow deprecation warnings/comments
          if (line.includes('DEPRECATED')) continue;
          violations.push(`${relPath}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    assert.equal(violations.length, 0,
      `Found updateFrameState() calls — this method is DEPRECATED.\n` +
      `Use FrameManager.merge() + saveFrames() instead:\n` +
      violations.join('\n'));
  });

  it('no frame.state mutations without FrameManager (direct property assignment)', () => {
    const violations = [];

    for (const file of srcFiles) {
      const relPath = file.replace(process.cwd() + '/', '');
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      // Only check files that deal with frames
      if (!content.includes('frame') && !content.includes('Frame')) continue;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

        // Detect direct frame.state = ... or frame.state.foo = ... assignments
        // These bypass FrameManager.merge() and won't be persisted/broadcast
        //
        // We must distinguish writes (frame.state = X) from reads (typeof frame.state === 'string').
        // Only match `frame.state =` NOT followed by `==` (comparison), and exclude ternary reads.
        const isStateWrite = /frame\.state\s*=[^=]/.test(line) || /frame\.state\.\w+\s*=[^=]/.test(line);
        if (isStateWrite) {
          // Skip lines that are purely reading/parsing (typeof checks, ternary reads)
          if (/typeof\s+frame\.state/.test(line)) continue;
          // Allow inside FrameManager / frame-manager internals
          if (relPath.includes('frame-manager')) continue;
          // Allow inside FramePersistence (the ORM layer)
          if (relPath.includes('frames/index.mjs')) continue;
          // Allow inside shared spec tests
          if (relPath.includes('spec/')) continue;
          // Allow inside client-side frame rendering (read-only display state)
          if (relPath.startsWith('src/client/')) continue;
          // Allow inside frame-router (updates in-memory ref then immediately calls FrameManager.merge)
          if (relPath.includes('frame-router.mjs')) continue;

          violations.push(`${relPath}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    assert.equal(violations.length, 0,
      `Found direct frame.state mutation outside FrameManager.\n` +
      `Frame state MUST be updated via FrameManager.merge():\n` +
      violations.join('\n'));
  });
});
