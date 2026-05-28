'use strict';

import { HelpIndex } from '../../help/help-index.mjs';

// =============================================================================
// Help Plugin
// =============================================================================
// Registers a tool (for agent use) and a command (for user /help).
// Uses HelpIndex to aggregate and search all registered tools and commands.
// =============================================================================

// ---------------------------------------------------------------------------
// HTML builders for /help command output
// ---------------------------------------------------------------------------

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  if (!text)
    return '';

  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {import('../../types').JSONSchema | null} inputSchema
 * @returns {string}
 */
function buildParameterRows(inputSchema) {
  if (!inputSchema || !inputSchema.properties)
    return '';

  let required = new Set(inputSchema.required || []);
  let rows     = [];

  for (let [paramName, paramDef] of Object.entries(inputSchema.properties)) {
    let isRequired = required.has(paramName);
    let badge      = (isRequired) ? '<em>(required)</em>' : '<em>(optional)</em>';
    let type       = paramDef.type || 'any';
    let desc       = escapeHtml(paramDef.description) || '';

    rows.push(`<li><code>${escapeHtml(paramName)}</code> (${type}) ${badge} — ${desc}</li>`);
  }

  return (rows.length > 0) ? `<ul>${rows.join('')}</ul>` : '';
}

/**
 * @param {Array<{ name: string, required?: boolean, description?: string }> | null} parameters
 * @returns {string}
 */
function buildParameterList(parameters) {
  if (!parameters || parameters.length === 0)
    return '';

  let rows = parameters.map((param) => {
    let badge = (param.required) ? '<em>(required)</em>' : '<em>(optional)</em>';
    let desc  = escapeHtml(param.description) || '';

    return `<li><code>${escapeHtml(param.name)}</code> ${badge} — ${desc}</li>`;
  });

  return `<ul>${rows.join('')}</ul>`;
}

/**
 * @param {Array<{ description?: string, input?: string, query?: string, command?: string, url?: string }> | null} examples
 * @returns {string}
 */
function buildExamples(examples) {
  if (!examples || examples.length === 0)
    return '';

  let items = examples.map((example) => {
    let desc  = escapeHtml(example.description) || '';
    let input = example.input || example.query || example.command || example.url || '';

    if (input)
      return `<li><code>${escapeHtml(input)}</code> — ${desc}</li>`;

    return `<li>${desc}</li>`;
  });

  return `<ul>${items.join('')}</ul>`;
}

/**
 * @param {{ name: string, description?: string, usage?: string, inputSchema?: import('../../types').JSONSchema, examples?: any[], riskLevel?: string }} entry
 * @returns {string}
 */
function buildToolSection(entry) {
  let parts = [];

  parts.push(`<h3><code>${escapeHtml(entry.name)}</code></h3>`);

  if (entry.description)
    parts.push(`<p>${escapeHtml(entry.description)}</p>`);

  if (entry.usage)
    parts.push(`<p><strong>Usage:</strong> <code>${escapeHtml(entry.usage)}</code></p>`);

  // Parameters from inputSchema
  let paramHtml = buildParameterRows(entry.inputSchema);
  if (paramHtml)
    parts.push(`<p><strong>Parameters:</strong></p>${paramHtml}`);

  // Examples
  let exampleHtml = buildExamples(entry.examples);
  if (exampleHtml)
    parts.push(`<p><strong>Examples:</strong></p>${exampleHtml}`);

  // Risk level
  if (entry.riskLevel)
    parts.push(`<p><strong>Risk level:</strong> ${escapeHtml(entry.riskLevel)}</p>`);

  return parts.join('');
}

/**
 * @param {{ name: string, description?: string, usage?: string, parameters?: any[], examples?: any[] }} entry
 * @returns {string}
 */
function buildCommandSection(entry) {
  let parts = [];

  parts.push(`<h3><code>${escapeHtml(entry.name)}</code></h3>`);

  if (entry.description)
    parts.push(`<p>${escapeHtml(entry.description)}</p>`);

  if (entry.usage)
    parts.push(`<p><strong>Usage:</strong> <code>${escapeHtml(entry.usage)}</code></p>`);

  // Parameters from help metadata
  let paramHtml = buildParameterList(entry.parameters);
  if (paramHtml)
    parts.push(`<p><strong>Parameters:</strong></p>${paramHtml}`);

  // Examples
  let exampleHtml = buildExamples(entry.examples);
  if (exampleHtml)
    parts.push(`<p><strong>Examples:</strong></p>${exampleHtml}`);

  return parts.join('');
}

/**
 * @param {Array<{ category: string, name: string, [key: string]: any }>} entries
 * @returns {string}
 */
function buildHelpHtml(entries) {
  let commands = entries.filter((entry) => entry.category === 'command');
  let tools    = entries.filter((entry) => entry.category === 'tool');

  let sections = [];

  if (commands.length > 0) {
    let commandHtml = commands.map(buildCommandSection).join('<hr>');
    sections.push(`<h2>Commands</h2><p>Type these in the chat input:</p>${commandHtml}`);
  }

  if (tools.length > 0) {
    let toolHtml = tools.map(buildToolSection).join('<hr>');
    sections.push(`<h2>Tools</h2><p>Agent-invokable tools (the AI agent can call these):</p>${toolHtml}`);
  }

  // HML Prompt reference
  sections.push(buildHmlPromptReference());

  if (sections.length === 0)
    return '<p>No tools or commands registered.</p>';

  return sections.join('');
}

/**
 * @returns {string}
 */
function buildHmlPromptReference() {
  return [
    '<h2>Interactive Prompts (<code>&lt;kikx-hml-prompt&gt;</code>)</h2>',
    '<p>Agents can embed interactive form elements in their HTML responses to collect structured input from users. All configuration is done via HTML attributes.</p>',
    '<p><strong>Attributes:</strong></p>',
    '<ul>',
    '<li><code>name</code> — Unique identifier for the prompt (required)</li>',
    '<li><code>type</code> — Input type: <code>text</code>, <code>textarea</code>, <code>select</code>, <code>checkbox</code>, <code>radio</code>, <code>number</code>, <code>range</code>, <code>color</code>, <code>date</code>, <code>time</code></li>',
    '<li><code>label</code> — Display label</li>',
    '<li><code>placeholder</code> — Placeholder text (text/textarea)</li>',
    '<li><code>value</code> — Default value</li>',
    '<li><code>options</code> — Comma-separated choices for select/radio</li>',
    '<li><code>min</code>, <code>max</code>, <code>step</code> — Constraints for number/range</li>',
    '<li><code>required</code> — Mark as required (boolean attribute)</li>',
    '</ul>',
    '<p><strong>For select/radio with label/value pairs, use child elements:</strong></p>',
    '<pre><code>',
    escapeHtml('<kikx-hml-prompt name="size" type="select" label="Size">'),
    '\n  ',
    escapeHtml('<kikx-hml-option value="s" label="Small"></kikx-hml-option>'),
    '\n  ',
    escapeHtml('<kikx-hml-option value="l" label="Large"></kikx-hml-option>'),
    '\n',
    escapeHtml('</kikx-hml-prompt>'),
    '</code></pre>',
    '<p><strong>Examples:</strong></p>',
    '<pre><code>',
    escapeHtml('<kikx-hml-prompt name="project" type="text" label="Project Name" placeholder="Enter name..."></kikx-hml-prompt>'),
    '\n\n',
    escapeHtml('<kikx-hml-prompt name="framework" type="select" label="Framework" options="React,Vue,Svelte"></kikx-hml-prompt>'),
    '\n\n',
    escapeHtml('<kikx-hml-prompt name="agree" type="checkbox" label="I agree to the terms" value="false"></kikx-hml-prompt>'),
    '\n\n',
    escapeHtml('<kikx-hml-prompt name="rating" type="range" label="Rating" min="1" max="10" step="1" value="5"></kikx-hml-prompt>'),
    '</code></pre>',
  ].join('');
}

// ---------------------------------------------------------------------------
// Plugin setup
// ---------------------------------------------------------------------------

/**
 * @param {(cb: (ctx: { registry: any, context: import('../../types').CascadingContext }) => void) => void} provide
 */
export function setup(provide) {
  provide(({ registry, context }) => {
    let PluginInterface = registry.getClass('PluginInterface');

    class HelpTool extends PluginInterface {
      static pluginID    = 'help';
      static featureName = 'search';
      static displayName = 'Help';
      static description = 'Search available tools, commands, and interactive prompt types';
      static riskLevel   = 'none';
      static inputSchema = {
        type:       'object',
        properties: {
          query: { type: 'string', description: 'Optional search query to filter tools and commands' },
        },
      };

      /**
       * @param {{ query?: string }} params
       * @returns {Promise<{ entries: any[] }>}
       */
      async _execute({ query }) {
        let registry  = context.getProperty('pluginRegistry');
        let helpIndex = new HelpIndex(registry);
        let entries   = (query) ? helpIndex.search(query) : helpIndex.getEntries();

        // Include HML prompt reference as a synthetic entry when no query or when searching for "prompt"
        if (!query || 'prompt'.includes(query.toLowerCase()) || 'hml'.includes(query.toLowerCase()))
          entries.push(this._getHmlPromptEntry());

        return { entries };
      }

      _getHmlPromptEntry() {
        return {
          category:    'reference',
          name:        'kikx-hml-prompt',
          displayName: 'Interactive Prompts',
          description: 'Embed interactive form elements in HTML responses to collect structured user input. ' +
            'All configuration via HTML attributes — NO JSON config blobs. ' +
            'Attributes: name (required, unique id), type (text|textarea|select|checkbox|radio|number|range|color|date|time), ' +
            'label, placeholder, value (default), options (comma-separated for select/radio), min, max, step, required. ' +
            'For select/radio with label/value pairs, use child <kikx-hml-option value="..." label="..."> elements. ' +
            'Checkbox value should be "true" or "false".',
          usage: '<kikx-hml-prompt name="unique-id" type="text" label="..." placeholder="..."></kikx-hml-prompt>',
          examples: [
            { input: '<kikx-hml-prompt name="username" type="text" label="Your Name" placeholder="Enter name"></kikx-hml-prompt>',    description: 'Text input' },
            { input: '<kikx-hml-prompt name="color" type="select" label="Pick a Color" options="Red,Blue,Green"></kikx-hml-prompt>',  description: 'Dropdown select' },
            { input: '<kikx-hml-prompt name="agree" type="checkbox" label="I agree to the terms" value="false"></kikx-hml-prompt>',   description: 'Checkbox (boolean)' },
            { input: '<kikx-hml-prompt name="rating" type="range" label="Rating" min="1" max="10" step="1" value="5"></kikx-hml-prompt>', description: 'Range slider' },
          ],
        };
      }

      getHelp() {
        return {
          ...super.getHelp(),
          usage:   'help:search { query: "shell" }',
          examples: [
            { query: '',        description: 'List all available tools, commands, and prompt types' },
            { query: 'shell',   description: 'Search for shell-related tools' },
            { query: 'prompt',  description: 'Get interactive prompt (hml-prompt) documentation' },
            { query: 'invite',  description: 'Search for the invite command' },
          ],
        };
      }
    }

    registry.registerTool('help:search', HelpTool);

    // /help command — user-facing slash command
    registry.registerCommand('help', async ({ arguments: query }) => {
      let reg       = context.getProperty('pluginRegistry');
      let helpIndex = new HelpIndex(reg);
      let entries   = (query) ? helpIndex.search(query) : helpIndex.getEntries();

      if (entries.length === 0)
        return { content: { html: '<p>No matching tools or commands found.</p>' } };

      let html = buildHelpHtml(entries);
      return { content: { html } };
    }, {
      description: 'Show available commands, tools, and interactive prompt types with detailed usage information.',
      usage:       '/help [query]',
      parameters:  [
        { name: 'query', required: false, description: 'Optional search term to filter results' },
      ],
      examples: [
        { input: '/help',       description: 'Show all available commands and tools' },
        { input: '/help shell', description: 'Show help for shell-related features' },
        { input: '/help prompt', description: 'Show interactive prompt documentation' },
      ],
    });

    // Register instructions so the agent knows about the help system and hml-prompts
    registry.registerInstructions(
      'help',
      'Use the help:search tool to discover all available tools, commands, and interactive prompt types. ' +
      'Call it with no query to list everything, or with a query string to filter. ' +
      'When you need structured input from the user, use <kikx-hml-prompt> elements inline in your HTML. ' +
      'Configure via attributes: name, type, label, placeholder, value, options, min, max, step. ' +
      'Example: <kikx-hml-prompt name="color" type="select" label="Color" options="Red,Blue,Green"></kikx-hml-prompt>',
      { priority: 50 },
    );
  });

  return () => {};
}
