'use strict';

import { describe, it }               from 'node:test';
import assert                          from 'node:assert/strict';
import { FrameTypeBase, FRAME_PROPERTIES } from '../../../src/shared/frame-types/frame-type-base.mjs';

describe('FrameTypeBase', () => {
  // ---------------------------------------------------------------------------
  // Property getters
  // ---------------------------------------------------------------------------

  describe('property getters', () => {
    let frameData = {
      id:                    'frame-001',
      type:                  'UserMessage',
      targets:               ['target-1'],
      phantom:               false,
      content:               { text: 'hello' },
      parentID:              'parent-001',
      groupID:               'group-001',
      groupType:             'interaction',
      order:                 5,
      timestamp:             1700000000000,
      hidden:                false,
      deleted:               false,
      updatedAt:             1700000001000,
      createdAt:             1700000000000,
      authorType:            'user',
      authorID:              'user-001',
      processed:             true,
      processedAt:           1700000002000,
      state:                 'active',
      signature:             'sig-abc',
      signingKeyFingerprint: 'fp-xyz',
      interactionID:         'int-001',
    };

    it('should expose all 22 frame properties via getters', () => {
      let instance = new FrameTypeBase(frameData);

      assert.equal(instance.id, 'frame-001');
      assert.equal(instance.type, 'UserMessage');
      assert.deepEqual(instance.targets, ['target-1']);
      assert.equal(instance.phantom, false);
      assert.deepEqual(instance.content, { text: 'hello' });
      assert.equal(instance.parentID, 'parent-001');
      assert.equal(instance.groupID, 'group-001');
      assert.equal(instance.groupType, 'interaction');
      assert.equal(instance.order, 5);
      assert.equal(instance.timestamp, 1700000000000);
      assert.equal(instance.hidden, false);
      assert.equal(instance.deleted, false);
      assert.equal(instance.updatedAt, 1700000001000);
      assert.equal(instance.createdAt, 1700000000000);
      assert.equal(instance.authorType, 'user');
      assert.equal(instance.authorID, 'user-001');
      assert.equal(instance.processed, true);
      assert.equal(instance.processedAt, 1700000002000);
      assert.equal(instance.state, 'active');
      assert.equal(instance.signature, 'sig-abc');
      assert.equal(instance.signingKeyFingerprint, 'fp-xyz');
      assert.equal(instance.interactionID, 'int-001');
    });

    it('should return undefined for missing properties', () => {
      let instance = new FrameTypeBase({ id: 'f1' });

      assert.equal(instance.id, 'f1');
      assert.equal(instance.type, undefined);
      assert.equal(instance.targets, undefined);
      assert.equal(instance.authorType, undefined);
      assert.equal(instance.interactionID, undefined);
    });

    it('should have FRAME_PROPERTIES array with 22 entries', () => {
      assert.equal(FRAME_PROPERTIES.length, 22);
      assert.ok(FRAME_PROPERTIES.includes('id'));
      assert.ok(FRAME_PROPERTIES.includes('interactionID'));
      assert.ok(FRAME_PROPERTIES.includes('signingKeyFingerprint'));
    });
  });

  // ---------------------------------------------------------------------------
  // Null / missing frameData handling
  // ---------------------------------------------------------------------------

  describe('null frameData handling', () => {
    it('should handle null frameData without throwing', () => {
      let instance = new FrameTypeBase(null);

      assert.equal(instance.id, undefined);
      assert.equal(instance.type, undefined);
      assert.equal(instance.content, undefined);
    });

    it('should handle undefined frameData without throwing', () => {
      let instance = new FrameTypeBase(undefined);

      assert.equal(instance.id, undefined);
      assert.equal(instance.content, undefined);
    });

    it('should handle empty object frameData', () => {
      let instance = new FrameTypeBase({});

      assert.equal(instance.id, undefined);
      assert.equal(instance.type, undefined);
    });
  });

  // ---------------------------------------------------------------------------
  // Null / missing context handling
  // ---------------------------------------------------------------------------

  describe('null context handling', () => {
    it('should handle null context without throwing', () => {
      let instance = new FrameTypeBase({ id: 'f1' }, null);
      assert.deepEqual(instance._context, {});
    });

    it('should handle undefined context without throwing', () => {
      let instance = new FrameTypeBase({ id: 'f1' }, undefined);
      assert.deepEqual(instance._context, {});
    });

    it('should store provided context', () => {
      let context  = { registry: 'test' };
      let instance = new FrameTypeBase({ id: 'f1' }, context);
      assert.equal(instance._context.registry, 'test');
    });
  });

  // ---------------------------------------------------------------------------
  // Default method return values
  // ---------------------------------------------------------------------------

  describe('default method return values', () => {
    let instance;

    it('getContentForIndexing() — returns JSON stringified content', () => {
      instance = new FrameTypeBase({ content: { text: 'hello' } });
      let result = instance.getContentForIndexing();
      assert.deepEqual(result, [{ content_text: '{"text":"hello"}' }]);
    });

    it('getContentForIndexing() — returns empty array for null content', () => {
      instance = new FrameTypeBase({ content: null });
      assert.deepEqual(instance.getContentForIndexing(), []);
    });

    it('getContentForIndexing() — returns empty array for empty object content', () => {
      instance = new FrameTypeBase({ content: {} });
      assert.deepEqual(instance.getContentForIndexing(), []);
    });

    it('getContentForIndexing() — returns empty array when frameData has no content', () => {
      instance = new FrameTypeBase({});
      assert.deepEqual(instance.getContentForIndexing(), []);
    });

    it('toAgentMessage() — returns null', () => {
      instance = new FrameTypeBase({ content: { text: 'test' } });
      assert.equal(instance.toAgentMessage(), null);
      assert.equal(instance.toAgentMessage({}), null);
    });

    it('toMessage() — returns text from content', () => {
      instance = new FrameTypeBase({ content: { text: 'hello' } });
      assert.equal(instance.toMessage(), 'hello');
    });

    it('toMessage() — returns html from content when no text', () => {
      instance = new FrameTypeBase({ content: { html: '<b>hi</b>' } });
      assert.equal(instance.toMessage(), '<b>hi</b>');
    });

    it('toMessage() — returns JSON stringified for non-text content', () => {
      instance = new FrameTypeBase({ content: { foo: 'bar' } });
      assert.equal(instance.toMessage(), '{"foo":"bar"}');
    });

    it('toMessage() — returns string content directly', () => {
      instance = new FrameTypeBase({ content: 'raw string' });
      assert.equal(instance.toMessage(), 'raw string');
    });

    it('toMessage() — handles null content', () => {
      instance = new FrameTypeBase({});
      assert.equal(instance.toMessage(), '{}');
    });

    it('isRenderable() — returns false', () => {
      instance = new FrameTypeBase({});
      assert.equal(instance.isRenderable(), false);
    });

    it('createElement() — returns null', () => {
      instance = new FrameTypeBase({});
      assert.equal(instance.createElement({}), null);
    });

    it('getAlignment() — returns "user" for authorType user', () => {
      instance = new FrameTypeBase({ authorType: 'user' });
      assert.equal(instance.getAlignment(), 'user');
    });

    it('getAlignment() — returns "agent" for authorType agent', () => {
      instance = new FrameTypeBase({ authorType: 'agent' });
      assert.equal(instance.getAlignment(), 'agent');
    });

    it('getAlignment() — returns "system" for unknown authorType', () => {
      instance = new FrameTypeBase({ authorType: 'system' });
      assert.equal(instance.getAlignment(), 'system');
    });

    it('getAlignment() — returns "system" for null authorType', () => {
      instance = new FrameTypeBase({});
      assert.equal(instance.getAlignment(), 'system');
    });

    it('getAuthorDisplayName() — returns "System"', () => {
      instance = new FrameTypeBase({});
      assert.equal(instance.getAuthorDisplayName(), 'System');
    });

    it('showReplyButton() — returns false', () => {
      instance = new FrameTypeBase({});
      assert.equal(instance.showReplyButton(), false);
    });

    it('isIncludedInAgentContext() — returns false', () => {
      instance = new FrameTypeBase({});
      assert.equal(instance.isIncludedInAgentContext(), false);
    });

    it('getContentLength() — returns 0', () => {
      instance = new FrameTypeBase({});
      assert.equal(instance.getContentLength(), 0);
    });

    it('getToolUseID() — returns null', () => {
      instance = new FrameTypeBase({});
      assert.equal(instance.getToolUseID(), null);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('getContentForIndexing() handles circular reference gracefully', () => {
      let circular = {};
      circular.self = circular;
      let instance = new FrameTypeBase({ content: circular });
      // JSON.stringify will throw on circular — should return []
      assert.deepEqual(instance.getContentForIndexing(), []);
    });

    it('toMessage() handles circular reference gracefully', () => {
      let circular = {};
      circular.self = circular;
      let instance = new FrameTypeBase({ content: circular });
      // JSON.stringify will throw — should return ''
      assert.equal(instance.toMessage(), '');
    });

    it('constructor stores references, does not deep copy', () => {
      let data     = { id: 'f1', content: { text: 'mutable' } };
      let instance = new FrameTypeBase(data);
      data.content.text = 'changed';
      assert.equal(instance.content.text, 'changed');
    });
  });
});
