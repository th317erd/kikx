'use strict';

// ============================================================================
// Permission Engine
// ============================================================================
// Default-deny permission engine. Every command, tool, and ability action
// is evaluated against a set of rules. Resolution uses specificity-based
// matching: the most specific matching rule wins. When no rule matches,
// the default action is 'prompt' (ask the user).
//
// Specificity tiers (highest to lowest):
//   1. Exact subject + exact resource + session-scoped
//   2. Exact subject + exact resource
//   3. Exact subject + wildcard resource
//   4. Wildcard subject + exact resource
//   5. Wildcard subject + wildcard resource (global default)
//
// At equal specificity, explicit 'deny' beats 'allow'.
// Priority field is a tiebreaker within the same specificity tier.

import { getDatabase } from '../../database.mjs';
import { audit, AuditEvent } from '../audit.mjs';

// ============================================================================
// Constants
// ============================================================================

export const SubjectType = Object.freeze({
  USER:   'user',
  AGENT:  'agent',
  PLUGIN: 'plugin',
  ANY:    '*',
});

export const ResourceType = Object.freeze({
  COMMAND:  'command',
  TOOL:     'tool',
  ABILITY:  'ability',
  ANY:      '*',
});

export const Action = Object.freeze({
  ALLOW:  'allow',
  DENY:   'deny',
  PROMPT: 'prompt',
});

export const Scope = Object.freeze({
  ONCE:      'once',
  SESSION:   'session',
  PERMANENT: 'permanent',
});

// Default action when no rules match
export const DEFAULT_ACTION = Action.PROMPT;

// ============================================================================
// Rule CRUD
// ============================================================================

/**
 * Create a permission rule.
 *
 * @param {object} rule
 * @param {number|null} rule.ownerId       - User who owns this rule (null = system-wide)
 * @param {number|null} rule.sessionId     - Session scope (null = all sessions)
 * @param {string}      rule.subjectType   - 'user' | 'agent' | 'plugin' | '*'
 * @param {number|null} rule.subjectId     - Specific subject (null = all of type)
 * @param {string}      rule.resourceType  - 'command' | 'tool' | 'ability' | '*'
 * @param {string|null} rule.resourceName  - Specific resource (null = all of type)
 * @param {string}      rule.action        - 'allow' | 'deny' | 'prompt'
 * @param {string}      rule.scope         - 'once' | 'session' | 'permanent'
 * @param {object|null} rule.conditions    - JSON conditions for granular matching
 * @param {number}      rule.priority      - Tiebreaker (higher = more important)
 * @param {Database}    [database]         - Optional DB instance
 * @returns {object} Created rule with id
 */
export function createRule(rule, database) {
  let db = database || getDatabase();

  let {
    ownerId      = null,
    sessionId    = null,
    subjectType,
    subjectId    = null,
    resourceType,
    resourceName = null,
    action,
    scope        = Scope.PERMANENT,
    conditions   = null,
    priority     = 0,
  } = rule;

  if (!subjectType)
    throw new Error('subjectType is required');

  if (!resourceType)
    throw new Error('resourceType is required');

  if (!action)
    throw new Error('action is required');

  let result = db.prepare(`
    INSERT INTO permission_rules
      (owner_id, session_id, subject_type, subject_id, resource_type, resource_name, action, scope, conditions, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ownerId,
    sessionId,
    subjectType,
    subjectId,
    resourceType,
    resourceName,
    action,
    scope,
    (conditions) ? JSON.stringify(conditions) : null,
    priority,
  );

  return {
    id:           result.lastInsertRowid,
    ownerId,
    sessionId,
    subjectType,
    subjectId,
    resourceType,
    resourceName,
    action,
    scope,
    conditions,
    priority,
  };
}

/**
 * Delete a permission rule by ID.
 *
 * @param {number}   ruleId
 * @param {Database} [database]
 * @returns {boolean} True if deleted
 */
export function deleteRule(ruleId, database) {
  let db     = database || getDatabase();
  let result = db.prepare('DELETE FROM permission_rules WHERE id = ?').run(ruleId);
  return result.changes > 0;
}

/**
 * Get a permission rule by ID.
 *
 * @param {number}   ruleId
 * @param {Database} [database]
 * @returns {object|null}
 */
export function getRule(ruleId, database) {
  let db  = database || getDatabase();
  let row = db.prepare('SELECT * FROM permission_rules WHERE id = ?').get(ruleId);
  return (row) ? deserializeRule(row) : null;
}

/**
 * List rules, optionally filtered.
 *
 * @param {object}   [filters]
 * @param {number}   [filters.ownerId]
 * @param {number}   [filters.sessionId]
 * @param {string}   [filters.subjectType]
 * @param {number}   [filters.subjectId]
 * @param {string}   [filters.resourceType]
 * @param {string}   [filters.resourceName]
 * @param {Database} [database]
 * @returns {Array<object>}
 */
export function listRules(filters = {}, database) {
  let db         = database || getDatabase();
  let clauses    = [];
  let params     = [];

  if (filters.ownerId !== undefined) {
    clauses.push('owner_id = ?');
    params.push(filters.ownerId);
  }

  if (filters.sessionId !== undefined) {
    clauses.push('session_id = ?');
    params.push(filters.sessionId);
  }

  if (filters.subjectType !== undefined) {
    clauses.push('subject_type = ?');
    params.push(filters.subjectType);
  }

  if (filters.subjectId !== undefined) {
    clauses.push('subject_id = ?');
    params.push(filters.subjectId);
  }

  if (filters.resourceType !== undefined) {
    clauses.push('resource_type = ?');
    params.push(filters.resourceType);
  }

  if (filters.resourceName !== undefined) {
    clauses.push('resource_name = ?');
    params.push(filters.resourceName);
  }

  let where = (clauses.length > 0) ? `WHERE ${clauses.join(' AND ')}` : '';
  let rows  = db.prepare(`SELECT * FROM permission_rules ${where} ORDER BY priority DESC, id ASC`).all(...params);

  return rows.map(deserializeRule);
}

// ============================================================================
// Permission Evaluation
// ============================================================================

/**
 * Evaluate permissions for a subject performing an action on a resource.
 *
 * @param {object}   subject
 * @param {string}   subject.type  - 'user' | 'agent' | 'plugin'
 * @param {number}   subject.id    - Subject's ID
 * @param {object}   resource
 * @param {string}   resource.type - 'command' | 'tool' | 'ability'
 * @param {string}   resource.name - Resource name (e.g., 'shell', 'grep')
 * @param {object}   [context]
 * @param {number}   [context.sessionId]  - Current session
 * @param {number}   [context.ownerId]    - Rule owner (user who set the rules)
 * @param {Database} [database]
 * @returns {{ action: string, rule: object|null }} Resolved action and matching rule
 */
export function evaluate(subject, resource, context = {}, database) {
  let db    = database || getDatabase();
  let rules = findMatchingRules(subject, resource, context, db);

  if (rules.length === 0) {
    audit(AuditEvent.PERMISSION_PROMPT, {
      subject:  { type: subject.type, id: subject.id },
      resource: { type: resource.type, name: resource.name },
      reason:   'no matching rules',
    });
    return { action: DEFAULT_ACTION, rule: null };
  }

  // Score each rule by specificity
  let scored = rules.map((rule) => ({
    rule,
    specificity: computeSpecificity(rule, subject, resource, context),
  }));

  // Sort by specificity descending, then priority descending, then deny-beats-allow
  scored.sort((a, b) => {
    // Higher specificity wins
    if (a.specificity !== b.specificity)
      return b.specificity - a.specificity;

    // Higher priority wins
    if (a.rule.priority !== b.rule.priority)
      return b.rule.priority - a.rule.priority;

    // At equal specificity and priority, deny beats allow
    if (a.rule.action === Action.DENY && b.rule.action !== Action.DENY)
      return -1;

    if (b.rule.action === Action.DENY && a.rule.action !== Action.DENY)
      return 1;

    return 0;
  });

  let winner = scored[0].rule;

  // Consume 'once' scoped rules after evaluation
  if (winner.scope === Scope.ONCE)
    deleteRule(winner.id, db);

  // Audit the permission decision
  let auditEventMap = {
    [Action.ALLOW]:  AuditEvent.PERMISSION_ALLOW,
    [Action.DENY]:   AuditEvent.PERMISSION_DENY,
    [Action.PROMPT]: AuditEvent.PERMISSION_PROMPT,
  };

  let auditEventType = auditEventMap[winner.action];
  if (auditEventType) {
    audit(auditEventType, {
      subject:  { type: subject.type, id: subject.id },
      resource: { type: resource.type, name: resource.name },
      ruleId:   winner.id,
    });
  }

  return { action: winner.action, rule: winner };
}

// ============================================================================
// Specificity Computation
// ============================================================================

/**
 * Compute specificity score for a rule.
 *
 * Scoring breakdown (each bit contributes to total):
 *   +8: session_id matches (session-scoped rule)
 *   +4: exact subject match (type + id)
 *   +2: exact subject type (but wildcard id)
 *   +1: exact resource match (type + name)
 *
 * @param {object} rule
 * @param {object} subject
 * @param {object} resource
 * @param {object} context
 * @returns {number}
 */
export function computeSpecificity(rule, subject, resource, context) {
  let score = 0;

  // Session-scoped rules are most specific
  if (rule.sessionId != null && rule.sessionId === context.sessionId)
    score += 8;

  // Exact subject match (type + id)
  if (rule.subjectType !== SubjectType.ANY && rule.subjectId != null)
    score += 4;
  // Subject type match (but any id)
  else if (rule.subjectType !== SubjectType.ANY)
    score += 2;

  // Exact resource match (type + name)
  if (rule.resourceType !== ResourceType.ANY && rule.resourceName != null)
    score += 1;

  return score;
}

// ============================================================================
// Rule Matching
// ============================================================================

/**
 * Find all rules that match the given subject, resource, and context.
 *
 * A rule matches if:
 *   - subject_type is '*' OR matches subject.type
 *   - subject_id is NULL OR matches subject.id
 *   - resource_type is '*' OR matches resource.type
 *   - resource_name is NULL OR matches resource.name
 *   - session_id is NULL OR matches context.sessionId
 *   - owner_id is NULL OR matches context.ownerId
 *   - conditions are NULL OR match context
 *
 * @param {object}   subject
 * @param {object}   resource
 * @param {object}   context
 * @param {Database} db
 * @returns {Array<object>}
 */
function findMatchingRules(subject, resource, context, db) {
  // Query all potentially matching rules with SQL-level filtering
  let rows = db.prepare(`
    SELECT * FROM permission_rules
    WHERE
      (subject_type = '*' OR subject_type = ?)
      AND (subject_id IS NULL OR subject_id = ?)
      AND (resource_type = '*' OR resource_type = ?)
      AND (resource_name IS NULL OR resource_name = ?)
      AND (session_id IS NULL OR session_id = ?)
      AND (owner_id IS NULL OR owner_id = ?)
  `).all(
    subject.type,
    subject.id,
    resource.type,
    resource.name,
    context.sessionId || null,
    context.ownerId || null,
  );

  let rules = rows.map(deserializeRule);

  // Filter by conditions (application-level)
  return rules.filter((rule) => matchConditions(rule.conditions, context));
}

/**
 * Check if a rule's conditions match the given context.
 *
 * Conditions is a JSON object where each key must match a value
 * in the context. Supports simple equality matching.
 *
 * @param {object|null} conditions
 * @param {object}      context
 * @returns {boolean}
 */
function matchConditions(conditions, context) {
  if (!conditions)
    return true;

  for (let [key, value] of Object.entries(conditions)) {
    if (context[key] !== value)
      return false;
  }

  return true;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Safely parse JSON — returns null on failure instead of throwing.
 * Prevents malformed conditions data from crashing the permission engine.
 *
 * @param {string} str - JSON string
 * @returns {Object|null}
 */
function safeParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    console.error('[Security] Malformed JSON in permission rule conditions:', str);
    return null;
  }
}

/**
 * Deserialize a rule row from the database.
 *
 * @param {object} row - Raw DB row
 * @returns {object} Deserialized rule
 */
function deserializeRule(row) {
  return {
    id:           row.id,
    ownerId:      row.owner_id,
    sessionId:    row.session_id,
    subjectType:  row.subject_type,
    subjectId:    row.subject_id,
    resourceType: row.resource_type,
    resourceName: row.resource_name,
    action:       row.action,
    scope:        row.scope,
    conditions:   (row.conditions) ? safeParseJSON(row.conditions) : null,
    priority:     row.priority,
    createdAt:    row.created_at,
  };
}
