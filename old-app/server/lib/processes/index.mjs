'use strict';

import { readdir, readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Cache for system processes (name -> { content, metadata })
const systemProcesses = new Map();

/**
 * Parse triple-quote metadata block from process content.
 *
 * Format:
 * """
 * # Description comes first
 * This is the description text.
 *
 * # Properties
 * property: value
 * another: value2
 * """
 *
 * Process content follows after the closing triple quotes.
 *
 * @param {string} raw - Raw file content
 * @returns {{ content: string, metadata: object }}
 */
export function parseProcessContent(raw) {
  let metadata = {
    description: '',
    properties:  {},
  };

  // Check for triple-quote block at start
  let tripleQuoteMatch = raw.match(/^"""\s*\n([\s\S]*?)\n"""\s*\n?([\s\S]*)$/);

  if (!tripleQuoteMatch) {
    // No metadata block, entire content is the process
    return { content: raw.trim(), metadata };
  }

  let metaBlock = tripleQuoteMatch[1];
  let content   = tripleQuoteMatch[2].trim();

  // Parse the metadata block
  let lines        = metaBlock.split('\n');
  let currentSection = 'description';
  let descriptionLines = [];

  for (let line of lines) {
    // Check for section headers
    if (line.match(/^#\s*description/i)) {
      currentSection = 'description';
      continue;
    }

    if (line.match(/^#\s*propert/i)) {
      currentSection = 'properties';
      continue;
    }

    // Skip other headers
    if (line.startsWith('#'))
      continue;

    if (currentSection === 'description') {
      descriptionLines.push(line);
    } else if (currentSection === 'properties') {
      // Parse key: value pairs
      let propMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (propMatch)
        metadata.properties[propMatch[1]] = propMatch[2].trim();
    }
  }

  metadata.description = descriptionLines.join('\n').trim();

  return { content, metadata };
}

/**
 * Load all system processes from the processes directory.
 * Markdown files are loaded as _<basename> (e.g., think.md -> _think)
 */
export async function loadSystemProcesses() {
  let entries = await readdir(__dirname);

  for (let entry of entries) {
    if (!entry.endsWith('.md'))
      continue;

    // Skip files starting with __ (startup abilities, handled separately)
    if (entry.startsWith('__'))
      continue;

    let name = '_' + basename(entry, '.md');
    let raw  = await readFile(join(__dirname, entry), 'utf8');
    let { content, metadata } = parseProcessContent(raw);

    systemProcesses.set(name, { content, metadata });
    console.log(`Loaded system process: ${name} - ${metadata.description || '(no description)'}`);
  }

  return systemProcesses;
}

/**
 * Get a system process by name.
 *
 * @param {string} name - Process name (e.g., '_think')
 * @returns {string | undefined} Process content or undefined
 */
export function getSystemProcess(name) {
  let process = systemProcesses.get(name);
  return process?.content;
}

/**
 * Get a system process with metadata.
 *
 * @param {string} name - Process name (e.g., '_think')
 * @returns {{ content: string, metadata: object } | undefined}
 */
export function getSystemProcessWithMetadata(name) {
  return systemProcesses.get(name);
}

/**
 * Get all system process names.
 *
 * @returns {string[]} Array of system process names
 */
export function getSystemProcessNames() {
  return Array.from(systemProcesses.keys());
}

/**
 * Get all system processes with metadata.
 *
 * @returns {Array<{ name: string, description: string, properties: object }>}
 */
export function getAllSystemProcesses() {
  let result = [];

  for (let [name, data] of systemProcesses) {
    result.push({
      name:        name,
      description: data.metadata.description || '',
      properties:  data.metadata.properties || {},
    });
  }

  return result;
}

/**
 * Check if a process name is a system process.
 * System processes start with a single underscore (e.g., '_think')
 *
 * @param {string} name - Process name
 * @returns {boolean}
 */
export function isSystemProcess(name) {
  return name.startsWith('_') && !name.startsWith('__');
}

/**
 * Inject processes into message content.
 * Replaces !!PROCESS_NAME!! placeholders with process content.
 *
 * @param {string} content - Message content with placeholders
 * @param {Map<string, string>} processMap - Map of process names to content
 * @returns {string} Content with placeholders replaced
 */
export function injectProcesses(content, processMap) {
  return content.replace(/!!([A-Z0-9_]+)!!/g, (match, name) => {
    let processName = name.toLowerCase();
    return processMap.get(processName) || match;
  });
}

/**
 * Build a process map from system and user processes.
 *
 * @param {string[]} processNames - List of process names to include
 * @param {Array<{name: string, content: string}>} userProcesses - User processes with decrypted content
 * @returns {Map<string, string>} Combined process map
 */
export function buildProcessMap(processNames, userProcesses = []) {
  let processMap = new Map();

  // Add requested system processes
  for (let name of processNames) {
    if (isSystemProcess(name)) {
      let content = getSystemProcess(name);
      if (content)
        processMap.set(name, content);
    }
  }

  // Add user processes
  for (let userProcess of userProcesses) {
    if (processNames.includes(userProcess.name))
      processMap.set(userProcess.name, userProcess.content);
  }

  return processMap;
}

export default {
  parseProcessContent,
  loadSystemProcesses,
  getSystemProcess,
  getSystemProcessWithMetadata,
  getSystemProcessNames,
  getAllSystemProcesses,
  isSystemProcess,
  injectProcesses,
  buildProcessMap,
};
