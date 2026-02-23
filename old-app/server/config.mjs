'use strict';

import { config as dotenvConfig } from 'dotenv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Load package.json for app-specific config
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

// Load .env from project root
dotenvConfig({ path: join(__dirname, '..', '.env') });

function get(key, defaultValue) {
  // Check for HERO_ prefixed version first
  let prefixedKey = `HERO_${key.toUpperCase()}`;
  if (process.env[prefixedKey] != null)
    return process.env[prefixedKey];

  // Check for plain key (case-insensitive match)
  let upperKey = key.toUpperCase();
  for (let envKey of Object.keys(process.env)) {
    if (envKey.toUpperCase() === upperKey)
      return process.env[envKey];
  }

  return defaultValue;
}

function requireEnv(key) {
  let value = get(key, null);

  if (value == null)
    throw new Error(`Required environment variable not set: ${key} (or HERO_${key.toUpperCase()})`);

  return value;
}

export const config = Object.freeze({
  // Server
  // To run on a different port: PORT=9099 node server/index.mjs
  port:     parseInt(get('PORT', '8098'), 10),
  host:     get('HOST', '0.0.0.0'),
  baseUrl:  get('BASE_URL', `http://localhost:${get('PORT', '8098')}/`),
  basePath: packageJson.hero?.basePath || '/',

  // Security
  jwtSecret:     requireEnv('JWT_SECRET'),
  encryptionKey: requireEnv('ENCRYPTION_KEY'),
  jwtExpiresIn:  get('JWT_EXPIRES_IN', '30d'),

  // Paths
  projectRoot: join(__dirname, '..'),
});

export default config;
