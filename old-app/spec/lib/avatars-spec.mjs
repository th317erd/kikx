'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Environment Setup
// ============================================================================

let testDir = mkdtempSync(join(tmpdir(), 'hero-avatars-test-'));

process.env.HERO_JWT_SECRET     = 'test-secret-key-for-testing';
process.env.HERO_ENCRYPTION_KEY = 'test-encryption-key-32chars!!';
process.env.XDG_CONFIG_HOME     = testDir;

let avatars;

async function loadModules() {
  avatars = await import('../../server/lib/avatars.mjs');
}

describe('Avatar Generation', async () => {
  await loadModules();

  // ===========================================================================
  // getInitials
  // ===========================================================================
  describe('getInitials()', () => {
    it('should return single initial for single-word name', () => {
      assert.strictEqual(avatars.getInitials('Claude'), 'C');
    });

    it('should return two initials for multi-word name', () => {
      assert.strictEqual(avatars.getInitials('Test Claude'), 'TC');
    });

    it('should handle hyphenated names', () => {
      assert.strictEqual(avatars.getInitials('test-claude'), 'TC');
    });

    it('should handle underscore names', () => {
      assert.strictEqual(avatars.getInitials('test_agent'), 'TA');
    });

    it('should handle empty string', () => {
      assert.strictEqual(avatars.getInitials(''), '?');
    });

    it('should handle null', () => {
      assert.strictEqual(avatars.getInitials(null), '?');
    });

    it('should handle undefined', () => {
      assert.strictEqual(avatars.getInitials(undefined), '?');
    });

    it('should uppercase initials', () => {
      assert.strictEqual(avatars.getInitials('foo bar'), 'FB');
    });

    it('should use first and last for three-word names', () => {
      assert.strictEqual(avatars.getInitials('one two three'), 'OT');
    });
  });

  // ===========================================================================
  // getColor
  // ===========================================================================
  describe('getColor()', () => {
    it('should return a hex color string', () => {
      let color = avatars.getColor('test');
      assert.ok(/^#[0-9A-Fa-f]{6}$/.test(color));
    });

    it('should be deterministic (same name → same color)', () => {
      let color1 = avatars.getColor('Claude');
      let color2 = avatars.getColor('Claude');
      assert.strictEqual(color1, color2);
    });

    it('should produce different colors for different names', () => {
      let color1 = avatars.getColor('Claude');
      let color2 = avatars.getColor('GPT-4');
      // Not guaranteed but very likely
      assert.notStrictEqual(color1, color2);
    });

    it('should handle empty name', () => {
      let color = avatars.getColor('');
      assert.ok(/^#[0-9A-Fa-f]{6}$/.test(color));
    });
  });

  // ===========================================================================
  // generateAvatar
  // ===========================================================================
  describe('generateAvatar()', () => {
    it('should return a data URI SVG', () => {
      let avatar = avatars.generateAvatar('Claude');
      assert.ok(avatar.startsWith('data:image/svg+xml;base64,'));
    });

    it('should be deterministic', () => {
      let avatar1 = avatars.generateAvatar('Claude');
      let avatar2 = avatars.generateAvatar('Claude');
      assert.strictEqual(avatar1, avatar2);
    });

    it('should produce different avatars for different names', () => {
      let avatar1 = avatars.generateAvatar('Claude');
      let avatar2 = avatars.generateAvatar('GPT-4');
      assert.notStrictEqual(avatar1, avatar2);
    });

    it('should contain initials in SVG', () => {
      let avatar = avatars.generateAvatar('Test Agent');
      let decoded = Buffer.from(avatar.split(',')[1], 'base64').toString();
      assert.ok(decoded.includes('TA'));
    });

    it('should respect custom size', () => {
      let avatar = avatars.generateAvatar('Claude', 64);
      let decoded = Buffer.from(avatar.split(',')[1], 'base64').toString();
      assert.ok(decoded.includes('width="64"'));
      assert.ok(decoded.includes('height="64"'));
    });
  });

  // ===========================================================================
  // getAgentAvatar
  // ===========================================================================
  describe('getAgentAvatar()', () => {
    it('should return custom avatar_url if set', () => {
      let agent = { name: 'Claude', avatar_url: 'https://example.com/avatar.png' };
      assert.strictEqual(avatars.getAgentAvatar(agent), 'https://example.com/avatar.png');
    });

    it('should generate avatar if no avatar_url', () => {
      let agent = { name: 'Claude', avatar_url: null };
      let avatar = avatars.getAgentAvatar(agent);
      assert.ok(avatar.startsWith('data:image/svg+xml;base64,'));
    });

    it('should generate avatar if avatar_url is empty', () => {
      let agent = { name: 'Claude' };
      let avatar = avatars.getAgentAvatar(agent);
      assert.ok(avatar.startsWith('data:image/svg+xml;base64,'));
    });
  });

  // ===========================================================================
  // getUserAvatar
  // ===========================================================================
  describe('getUserAvatar()', () => {
    it('should use display_name if available', () => {
      let user    = { display_name: 'Wyatt', username: 'wyatt' };
      let avatar  = avatars.getUserAvatar(user);
      let decoded = Buffer.from(avatar.split(',')[1], 'base64').toString();
      assert.ok(decoded.includes('>W<'));
    });

    it('should fall back to username', () => {
      let user    = { username: 'claude' };
      let avatar  = avatars.getUserAvatar(user);
      let decoded = Buffer.from(avatar.split(',')[1], 'base64').toString();
      assert.ok(decoded.includes('>C<'));
    });

    it('should handle missing fields', () => {
      let avatar = avatars.getUserAvatar({});
      assert.ok(avatar.startsWith('data:image/svg+xml;base64,'));
    });
  });
});
