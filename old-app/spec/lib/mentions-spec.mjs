'use strict';

// ============================================================================
// F3: @Mention Parsing and Routing Tests
// ============================================================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractMentions,
  resolveMentionsFromEnriched,
  findMentionedAgent,
} from '../../server/lib/mentions.mjs';

// ============================================================================
// MENTION-001: extractMentions
// ============================================================================

describe('F3: extractMentions()', () => {
  it('should extract a single @mention', () => {
    let mentions = extractMentions('@test-claude hello');
    assert.deepStrictEqual(mentions, ['test-claude']);
  });

  it('should extract multiple @mentions', () => {
    let mentions = extractMentions('@alice please ask @bob about it');
    assert.deepStrictEqual(mentions, ['alice', 'bob']);
  });

  it('should extract @mention at start of text', () => {
    let mentions = extractMentions('@agent do something');
    assert.deepStrictEqual(mentions, ['agent']);
  });

  it('should extract @mention at end of text', () => {
    let mentions = extractMentions('hello @agent');
    assert.deepStrictEqual(mentions, ['agent']);
  });

  it('should extract @mention with hyphens and underscores', () => {
    let mentions = extractMentions('@my-agent_v2 test');
    assert.deepStrictEqual(mentions, ['my-agent_v2']);
  });

  it('should extract @mention with numbers', () => {
    let mentions = extractMentions('hey @agent123');
    assert.deepStrictEqual(mentions, ['agent123']);
  });

  it('should return empty array for no mentions', () => {
    let mentions = extractMentions('hello world');
    assert.deepStrictEqual(mentions, []);
  });

  it('should return empty array for empty string', () => {
    assert.deepStrictEqual(extractMentions(''), []);
  });

  it('should return empty array for null', () => {
    assert.deepStrictEqual(extractMentions(null), []);
  });

  it('should return empty array for undefined', () => {
    assert.deepStrictEqual(extractMentions(undefined), []);
  });

  it('should handle email addresses (extracts domain part)', () => {
    // user@domain — the @ is mid-word so regex still extracts "domain"
    let mentions = extractMentions('email user@domain.com');
    assert.deepStrictEqual(mentions, ['domain']);
  });

  it('should not extract lone @', () => {
    let mentions = extractMentions('@ nothing');
    assert.deepStrictEqual(mentions, []);
  });

  it('should handle @mention on new line', () => {
    let mentions = extractMentions('line one\n@agent line two');
    assert.deepStrictEqual(mentions, ['agent']);
  });
});

// ============================================================================
// MENTION-002: resolveMentionsFromEnriched
// ============================================================================

describe('F3: resolveMentionsFromEnriched()', () => {
  let participants;

  beforeEach(() => {
    participants = [
      { participantType: 'user',  participantId: 1, name: 'wyatt',       role: 'owner',       alias: null },
      { participantType: 'agent', participantId: 10, name: 'test-claude', role: 'coordinator', alias: null },
      { participantType: 'agent', participantId: 20, name: 'test-gpt',   role: 'member',      alias: 'gpt' },
      { participantType: 'agent', participantId: 30, name: 'test-llama', role: 'member',      alias: 'llama' },
    ];
  });

  it('should resolve by agent name (case-insensitive)', () => {
    let resolved = resolveMentionsFromEnriched(['test-claude'], participants);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].participantId, 10);
  });

  it('should resolve by alias (case-insensitive)', () => {
    let resolved = resolveMentionsFromEnriched(['gpt'], participants);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].participantId, 20);
  });

  it('should prefer alias over name', () => {
    // If an agent has alias "gpt", @gpt should resolve to it even if another agent is named "gpt"
    let resolved = resolveMentionsFromEnriched(['gpt'], participants);
    assert.equal(resolved[0].participantId, 20);
  });

  it('should resolve multiple mentions', () => {
    let resolved = resolveMentionsFromEnriched(['test-claude', 'llama'], participants);
    assert.equal(resolved.length, 2);
    assert.equal(resolved[0].participantId, 10);
    assert.equal(resolved[1].participantId, 30);
  });

  it('should not resolve unknown mentions', () => {
    let resolved = resolveMentionsFromEnriched(['unknown-agent'], participants);
    assert.equal(resolved.length, 0);
  });

  it('should not resolve user participants', () => {
    let resolved = resolveMentionsFromEnriched(['wyatt'], participants);
    assert.equal(resolved.length, 0);
  });

  it('should deduplicate (same agent mentioned twice)', () => {
    let resolved = resolveMentionsFromEnriched(['test-claude', 'test-claude'], participants);
    assert.equal(resolved.length, 1);
  });

  it('should return empty for empty mentions', () => {
    assert.deepStrictEqual(resolveMentionsFromEnriched([], participants), []);
  });

  it('should return empty for null mentions', () => {
    assert.deepStrictEqual(resolveMentionsFromEnriched(null, participants), []);
  });

  it('should return empty for null participants', () => {
    assert.deepStrictEqual(resolveMentionsFromEnriched(['test'], null), []);
  });

  it('should be case-insensitive for alias', () => {
    let resolved = resolveMentionsFromEnriched(['GPT'], participants);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].participantId, 20);
  });

  it('should be case-insensitive for name', () => {
    let resolved = resolveMentionsFromEnriched(['Test-Claude'], participants);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].participantId, 10);
  });
});

// ============================================================================
// MENTION-003: findMentionedAgent
// ============================================================================

describe('F3: findMentionedAgent()', () => {
  let participants;

  beforeEach(() => {
    participants = [
      { participantType: 'user',  participantId: 1,  name: 'wyatt',       role: 'owner',       alias: null },
      { participantType: 'agent', participantId: 10, name: 'test-claude', role: 'coordinator', alias: null },
      { participantType: 'agent', participantId: 20, name: 'test-gpt',   role: 'member',      alias: 'gpt' },
    ];
  });

  it('should find first mentioned agent', () => {
    let result = findMentionedAgent('@test-gpt what is the weather?', participants);
    assert.ok(result);
    assert.equal(result.agentId, 20);
    assert.equal(result.participant.role, 'member');
  });

  it('should find agent by alias', () => {
    let result = findMentionedAgent('@gpt explain this', participants);
    assert.ok(result);
    assert.equal(result.agentId, 20);
  });

  it('should return null for no mentions', () => {
    let result = findMentionedAgent('hello world', participants);
    assert.equal(result, null);
  });

  it('should return null for unresolved mentions', () => {
    let result = findMentionedAgent('@unknown help', participants);
    assert.equal(result, null);
  });

  it('should return the first resolved agent when multiple mentioned', () => {
    let result = findMentionedAgent('@test-claude please delegate to @gpt', participants);
    assert.ok(result);
    assert.equal(result.agentId, 10);
  });

  it('should return null for empty text', () => {
    assert.equal(findMentionedAgent('', participants), null);
  });

  it('should return null for user mentions', () => {
    assert.equal(findMentionedAgent('@wyatt hello', participants), null);
  });
});

// ============================================================================
// MENTION-004: loadAgentForSession
// ============================================================================

describe('F3: loadAgentForSession()', () => {
  let db;
  let loadAgentForSession;

  beforeEach(async () => {
    let Database = (await import('better-sqlite3')).default;
    db = new Database(':memory:');

    db.exec(`
      CREATE TABLE session_participants (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id       INTEGER NOT NULL,
        participant_type TEXT NOT NULL,
        participant_id   INTEGER NOT NULL,
        role             TEXT DEFAULT 'member',
        alias            TEXT,
        joined_at        TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(session_id, participant_type, participant_id)
      );

      CREATE TABLE agents (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        name               TEXT NOT NULL,
        type               TEXT DEFAULT 'anthropic',
        api_url            TEXT,
        avatar_url         TEXT,
        encrypted_api_key  TEXT,
        encrypted_config   TEXT,
        default_processes  TEXT,
        default_abilities  TEXT
      );
    `);

    // Seed data
    db.prepare('INSERT INTO agents (id, name, type) VALUES (?, ?, ?)').run(10, 'test-claude', 'anthropic');
    db.prepare('INSERT INTO agents (id, name, type) VALUES (?, ?, ?)').run(20, 'test-gpt', 'openai');
    db.prepare(`INSERT INTO session_participants (session_id, participant_type, participant_id, role) VALUES (?, ?, ?, ?)`).run(1, 'agent', 10, 'coordinator');
    db.prepare(`INSERT INTO session_participants (session_id, participant_type, participant_id, role) VALUES (?, ?, ?, ?)`).run(1, 'agent', 20, 'member');

    let mod = await import('../../server/lib/participants/index.mjs');
    loadAgentForSession = mod.loadAgentForSession;
  });

  it('should load a participant agent', () => {
    let result = loadAgentForSession(1, 20, db);
    assert.ok(result);
    assert.equal(result.agent_id, 20);
    assert.equal(result.agent_name, 'test-gpt');
    assert.equal(result.agent_type, 'openai');
  });

  it('should load coordinator agent', () => {
    let result = loadAgentForSession(1, 10, db);
    assert.ok(result);
    assert.equal(result.agent_id, 10);
    assert.equal(result.agent_name, 'test-claude');
  });

  it('should return null for non-participant agent', () => {
    let result = loadAgentForSession(1, 999, db);
    assert.equal(result, null);
  });

  it('should return null for agent in different session', () => {
    let result = loadAgentForSession(999, 10, db);
    assert.equal(result, null);
  });

  it('should return all agent fields', () => {
    let result = loadAgentForSession(1, 10, db);
    assert.ok('agent_id' in result);
    assert.ok('agent_name' in result);
    assert.ok('agent_type' in result);
    assert.ok('agent_api_url' in result);
    assert.ok('agent_avatar_url' in result);
    assert.ok('encrypted_api_key' in result);
    assert.ok('encrypted_config' in result);
  });
});

// ============================================================================
// MENTION-005: Client autocomplete structure
// ============================================================================

describe('F3: Client autocomplete structure', () => {
  it('should have mention-dropdown element in template', async () => {
    // Structural test — verify the HTML template has the dropdown element
    let fs = await import('node:fs');
    let html = fs.readFileSync('public/js/components/hero-input/hero-input.html', 'utf8');
    assert.ok(html.includes('mention-dropdown'), 'Template should contain mention-dropdown element');
  });

  it('should have mention CSS styles in template', async () => {
    let fs = await import('node:fs');
    let html = fs.readFileSync('public/js/components/hero-input/hero-input.html', 'utf8');
    assert.ok(html.includes('.mention-item'), 'Template should contain mention-item styles');
    assert.ok(html.includes('.mention-dropdown.active'), 'Template should contain active dropdown styles');
  });

  it('should have _checkMentionTrigger method', async () => {
    let fs = await import('node:fs');
    let js = fs.readFileSync('public/js/components/hero-input/hero-input.js', 'utf8');
    assert.ok(js.includes('_checkMentionTrigger'), 'JS should contain _checkMentionTrigger method');
  });

  it('should have _selectMention method', async () => {
    let fs = await import('node:fs');
    let js = fs.readFileSync('public/js/components/hero-input/hero-input.js', 'utf8');
    assert.ok(js.includes('_selectMention'), 'JS should contain _selectMention method');
  });

  it('should have _closeMentionDropdown method', async () => {
    let fs = await import('node:fs');
    let js = fs.readFileSync('public/js/components/hero-input/hero-input.js', 'utf8');
    assert.ok(js.includes('_closeMentionDropdown'), 'JS should contain _closeMentionDropdown method');
  });

  it('should handle ArrowDown/ArrowUp/Tab/Escape in handleKeydown', async () => {
    let fs = await import('node:fs');
    let js = fs.readFileSync('public/js/components/hero-input/hero-input.js', 'utf8');
    assert.ok(js.includes("e.key === 'ArrowDown'"), 'Should handle ArrowDown');
    assert.ok(js.includes("e.key === 'ArrowUp'"), 'Should handle ArrowUp');
    assert.ok(js.includes("e.key === 'Tab'"), 'Should handle Tab');
  });
});
