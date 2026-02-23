'use strict';

import { platform, homedir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

/**
 * Get the OS-specific configuration directory for Hero.
 *
 * - Linux: ~/.config/hero/
 * - macOS: ~/Library/Application Support/hero/
 * - Windows: %APPDATA%/hero/
 *
 * @returns {string} Absolute path to config directory
 */
export function getConfigDir() {
  let home = homedir();
  let configDir;

  switch (platform()) {
    case 'darwin':
      configDir = join(home, 'Library', 'Application Support', 'hero');
      break;

    case 'win32':
      configDir = join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'hero');
      break;

    default:
      // Linux and others - follow XDG Base Directory spec
      configDir = join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'hero');
      break;
  }

  return configDir;
}

/**
 * Ensure the config directory exists, creating it if necessary.
 *
 * @returns {string} Absolute path to config directory
 */
export function ensureConfigDir() {
  let configDir = getConfigDir();

  if (!existsSync(configDir))
    mkdirSync(configDir, { recursive: true });

  return configDir;
}

/**
 * Get the path to the SQLite database.
 *
 * @returns {string} Absolute path to hero.db
 */
export function getDatabasePath() {
  return join(getConfigDir(), 'hero.db');
}

/**
 * Get the path to the plugins directory.
 *
 * @returns {string} Absolute path to plugins directory
 */
export function getPluginsDir() {
  return join(getConfigDir(), 'plugins');
}

/**
 * Ensure the plugins directory exists, creating it if necessary.
 *
 * @returns {string} Absolute path to plugins directory
 */
export function ensurePluginsDir() {
  let pluginsDir = getPluginsDir();

  if (!existsSync(pluginsDir))
    mkdirSync(pluginsDir, { recursive: true });

  return pluginsDir;
}

/**
 * Get the path to the uploads directory.
 *
 * @returns {string} Absolute path to uploads directory
 */
export function getUploadsDir() {
  return join(getConfigDir(), 'uploads');
}

/**
 * Ensure the uploads directory exists, creating it if necessary.
 *
 * @returns {string} Absolute path to uploads directory
 */
export function ensureUploadsDir() {
  let uploadsDir = getUploadsDir();

  if (!existsSync(uploadsDir))
    mkdirSync(uploadsDir, { recursive: true });

  return uploadsDir;
}

export default {
  getConfigDir,
  ensureConfigDir,
  getDatabasePath,
  getPluginsDir,
  ensurePluginsDir,
  getUploadsDir,
  ensureUploadsDir,
};
