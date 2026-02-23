'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { platform, homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import {
  getConfigDir,
  ensureConfigDir,
  getDatabasePath,
  getPluginsDir,
  ensurePluginsDir,
} from '../../server/lib/config-path.mjs';

describe('Config path module', () => {
  describe('getConfigDir', () => {
    it('should return a string path', () => {
      let configDir = getConfigDir();

      assert.equal(typeof configDir, 'string');
      assert.ok(configDir.length > 0);
    });

    it('should return OS-specific path', () => {
      let configDir = getConfigDir();
      let home      = homedir();

      switch (platform()) {
        case 'darwin':
          assert.equal(configDir, join(home, 'Library', 'Application Support', 'hero'));
          break;

        case 'win32':
          assert.ok(configDir.includes('hero'));
          break;

        default:
          // Linux and others
          assert.ok(configDir.includes('.config'));
          assert.ok(configDir.includes('hero'));
          break;
      }
    });

    it('should include "hero" in the path', () => {
      let configDir = getConfigDir();

      assert.ok(configDir.includes('hero'));
    });
  });

  describe('getDatabasePath', () => {
    it('should return path ending with hero.db', () => {
      let dbPath = getDatabasePath();

      assert.match(dbPath, /hero\.db$/);
    });

    it('should be inside config directory', () => {
      let configDir = getConfigDir();
      let dbPath    = getDatabasePath();

      assert.equal(dbPath, join(configDir, 'hero.db'));
    });
  });

  describe('getPluginsDir', () => {
    it('should return path ending with plugins', () => {
      let pluginsDir = getPluginsDir();

      assert.match(pluginsDir, /plugins$/);
    });

    it('should be inside config directory', () => {
      let configDir  = getConfigDir();
      let pluginsDir = getPluginsDir();

      assert.equal(pluginsDir, join(configDir, 'plugins'));
    });
  });

  describe('ensureConfigDir', () => {
    it('should create config directory if it does not exist', () => {
      // This test is somewhat integration-y, but important
      let configDir = ensureConfigDir();

      assert.equal(existsSync(configDir), true);
    });

    it('should return the config directory path', () => {
      let result    = ensureConfigDir();
      let configDir = getConfigDir();

      assert.equal(result, configDir);
    });
  });

  describe('ensurePluginsDir', () => {
    it('should create plugins directory if it does not exist', () => {
      let pluginsDir = ensurePluginsDir();

      assert.equal(existsSync(pluginsDir), true);
    });

    it('should return the plugins directory path', () => {
      let result     = ensurePluginsDir();
      let pluginsDir = getPluginsDir();

      assert.equal(result, pluginsDir);
    });
  });
});
