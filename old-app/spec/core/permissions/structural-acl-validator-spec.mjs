'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createStructuralACLValidator, ALLOWED_TYPES, IMMUTABLE_FIELDS } from '../../../src/core/permissions/structural-acl-validator.mjs';
import { FrameManager } from '../../../src/shared/frame-manager/frame-manager.mjs';

// =============================================================================
// Structural ACL Commit Validator — Phase B Step 2
// =============================================================================

describe('Structural ACL Validator', () => {

  // ---------------------------------------------------------------------------
  // Direct validator tests (unit-level)
  // ---------------------------------------------------------------------------

  describe('type restrictions', () => {
    let validate = createStructuralACLValidator();

    it('should allow system to create any frame type', () => {
      let commit  = { changes: [{ frameID: 'f1', operation: 'create' }] };
      let frames  = [{ id: 'f1', type: 'anything-at-all' }];
      let context = { authorType: 'system', authorID: null };

      let result = validate(commit, frames, context);
      assert.equal(result.allowed, true);
    });

    it('should allow user to create user-message', () => {
      let commit  = { changes: [{ frameID: 'f1', operation: 'create' }] };
      let frames  = [{ id: 'f1', type: 'UserMessage' }];
      let context = { authorType: 'user', authorID: 'usr_1' };

      let result = validate(commit, frames, context);
      assert.equal(result.allowed, true);
    });

    it('should allow user to create hml-prompt-value', () => {
      let commit  = { changes: [{ frameID: 'f1', operation: 'create' }] };
      let frames  = [{ id: 'f1', type: 'hml-prompt-value' }];
      let context = { authorType: 'user', authorID: 'usr_1' };

      let result = validate(commit, frames, context);
      assert.equal(result.allowed, true);
    });

    it('should deny user creating message type', () => {
      let commit  = { changes: [{ frameID: 'f1', operation: 'create' }] };
      let frames  = [{ id: 'f1', type: 'Message' }];
      let context = { authorType: 'user', authorID: 'usr_1' };

      let result = validate(commit, frames, context);
      assert.equal(result.allowed, false);
      assert.ok(result.reason.includes('user'));
      assert.ok(result.reason.includes('Message'));
    });

    it('should allow agent to create message', () => {
      let commit  = { changes: [{ frameID: 'f1', operation: 'create' }] };
      let frames  = [{ id: 'f1', type: 'Message' }];
      let context = { authorType: 'agent', authorID: 'agt_1' };

      let result = validate(commit, frames, context);
      assert.equal(result.allowed, true);
    });

    it('should allow agent to create tool-call', () => {
      let commit  = { changes: [{ frameID: 'f1', operation: 'create' }] };
      let frames  = [{ id: 'f1', type: 'ToolCall' }];
      let context = { authorType: 'agent', authorID: 'agt_1' };

      let result = validate(commit, frames, context);
      assert.equal(result.allowed, true);
    });

    it('should allow agent to create reflection', () => {
      let commit  = { changes: [{ frameID: 'f1', operation: 'create' }] };
      let frames  = [{ id: 'f1', type: 'Reflection' }];
      let context = { authorType: 'agent', authorID: 'agt_1' };

      let result = validate(commit, frames, context);
      assert.equal(result.allowed, true);
    });

    it('should deny agent creating user-message', () => {
      let commit  = { changes: [{ frameID: 'f1', operation: 'create' }] };
      let frames  = [{ id: 'f1', type: 'UserMessage' }];
      let context = { authorType: 'agent', authorID: 'agt_1' };

      let result = validate(commit, frames, context);
      assert.equal(result.allowed, false);
    });

    it('should allow tool to create tool-result', () => {
      let commit  = { changes: [{ frameID: 'f1', operation: 'create' }] };
      let frames  = [{ id: 'f1', type: 'ToolResult' }];
      let context = { authorType: 'tool', authorID: null };

      let result = validate(commit, frames, context);
      assert.equal(result.allowed, true);
    });

    it('should allow tool to create tool-error', () => {
      let commit  = { changes: [{ frameID: 'f1', operation: 'create' }] };
      let frames  = [{ id: 'f1', type: 'ToolError' }];
      let context = { authorType: 'tool', authorID: null };

      let result = validate(commit, frames, context);
      assert.equal(result.allowed, true);
    });

    it('should deny tool creating message', () => {
      let commit  = { changes: [{ frameID: 'f1', operation: 'create' }] };
      let frames  = [{ id: 'f1', type: 'Message' }];
      let context = { authorType: 'tool', authorID: null };

      let result = validate(commit, frames, context);
      assert.equal(result.allowed, false);
    });

    it('should deny unknown authorType', () => {
      let commit  = { changes: [{ frameID: 'f1', operation: 'create' }] };
      let frames  = [{ id: 'f1', type: 'Message' }];
      let context = { authorType: 'hacker', authorID: null };

      let result = validate(commit, frames, context);
      assert.equal(result.allowed, false);
      assert.ok(result.reason.includes('Unknown'));
    });

    it('should deny null authorType', () => {
      let commit  = { changes: [{ frameID: 'f1', operation: 'create' }] };
      let frames  = [{ id: 'f1', type: 'Message' }];
      let context = { authorType: null, authorID: null };

      let result = validate(commit, frames, context);
      assert.equal(result.allowed, false);
    });
  });

  // ---------------------------------------------------------------------------
  // Ownership rules
  // ---------------------------------------------------------------------------

  describe('ownership', () => {
    let validate = createStructuralACLValidator();

    it('should allow system to modify any frame', () => {
      let commit  = { changes: [{ frameID: 'f1', operation: 'update' }] };
      let frames  = [{ id: 'f1', type: 'Message', authorType: 'agent', authorID: 'agt_1' }];
      let context = { authorType: 'system', authorID: null };

      let result = validate(commit, frames, context);
      assert.equal(result.allowed, true);
    });

    it('should deny agent modifying user frame', () => {
      let commit  = { changes: [{ frameID: 'f1', operation: 'update' }] };
      let frames  = [{ id: 'f1', type: 'UserMessage', authorType: 'user', authorID: 'usr_1' }];
      let context = { authorType: 'agent', authorID: 'agt_1' };

      let result = validate(commit, frames, context);
      assert.equal(result.allowed, false);
      assert.ok(result.reason.includes('modify'));
    });

    it('should deny user modifying agent frame', () => {
      let commit  = { changes: [{ frameID: 'f1', operation: 'update' }] };
      let frames  = [{ id: 'f1', type: 'Message', authorType: 'agent', authorID: 'agt_1' }];
      let context = { authorType: 'user', authorID: 'usr_1' };

      let result = validate(commit, frames, context);
      assert.equal(result.allowed, false);
    });

    it('should allow agent to modify own frame', () => {
      let commit  = { changes: [{ frameID: 'f1', operation: 'update' }] };
      let frames  = [{ id: 'f1', type: 'Message', authorType: 'agent', authorID: 'agt_1' }];
      let context = { authorType: 'agent', authorID: 'agt_1' };

      let result = validate(commit, frames, context);
      assert.equal(result.allowed, true);
    });

    it('should deny agent modifying another agent frame', () => {
      let commit  = { changes: [{ frameID: 'f1', operation: 'update' }] };
      let frames  = [{ id: 'f1', type: 'Message', authorType: 'agent', authorID: 'agt_2' }];
      let context = { authorType: 'agent', authorID: 'agt_1' };

      let result = validate(commit, frames, context);
      assert.equal(result.allowed, false);
    });
  });

  // ---------------------------------------------------------------------------
  // Integration with FrameManager
  // ---------------------------------------------------------------------------

  describe('FrameManager integration', () => {
    it('should allow valid commit through FrameManager', () => {
      let manager = new FrameManager({
        commitValidator: createStructuralACLValidator(),
      });

      let results = manager.merge(
        [{ id: 'f1', type: 'Message', content: { html: 'hello' } }],
        { authorType: 'agent', authorID: 'agt_1' },
      );

      assert.equal(results.length, 1);
      assert.ok(manager.get('f1'));
      assert.ok(manager.getLatestCommit());
    });

    it('should reject invalid commit through FrameManager and rollback', () => {
      let manager = new FrameManager({
        commitValidator: createStructuralACLValidator(),
      });

      let results = manager.merge(
        [{ id: 'f1', type: 'Message', content: { html: 'hello' } }],
        { authorType: 'user', authorID: 'usr_1' },
      );

      assert.equal(results.length, 0);
      assert.equal(manager.get('f1'), undefined);
    });

    it('should emit commit:rejected event on rejection', () => {
      let manager = new FrameManager({
        commitValidator: createStructuralACLValidator(),
      });

      let rejected = null;
      manager.on('commit:rejected', (data) => { rejected = data; });

      manager.merge(
        [{ id: 'f1', type: 'ToolCall' }],
        { authorType: 'user', authorID: 'usr_1' },
      );

      assert.ok(rejected);
      assert.ok(rejected.reason.includes('user'));
    });

    it('should allow system to create any type through FrameManager', () => {
      let manager = new FrameManager({
        commitValidator: createStructuralACLValidator(),
      });

      let results = manager.merge(
        [{ id: 'f1', type: 'HookBlocked' }, { id: 'f2', type: 'Error' }, { id: 'f3', type: 'custom-anything' }],
        { authorType: 'system' },
      );

      assert.equal(results.length, 3);
    });
  });

  // ---------------------------------------------------------------------------
  // Constants exported
  // ---------------------------------------------------------------------------

  describe('exports', () => {
    it('should export ALLOWED_TYPES with expected keys', () => {
      assert.ok(ALLOWED_TYPES.system === null);
      assert.ok(ALLOWED_TYPES.user instanceof Set);
      assert.ok(ALLOWED_TYPES.agent instanceof Set);
      assert.ok(ALLOWED_TYPES.tool instanceof Set);
    });

    it('should export IMMUTABLE_FIELDS set', () => {
      assert.ok(IMMUTABLE_FIELDS.has('type'));
      assert.ok(IMMUTABLE_FIELDS.has('authorType'));
      assert.ok(IMMUTABLE_FIELDS.has('authorID'));
    });
  });
});
