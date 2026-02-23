'use strict';

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { getDatabase } from '../database.mjs';
import {
  createRule,
  deleteRule,
  getRule,
  listRules,
  evaluate,
  SubjectType,
  ResourceType,
  Action,
  Scope,
} from '../lib/permissions/index.mjs';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// Valid enum values for validation
const VALID_SUBJECT_TYPES  = new Set(Object.values(SubjectType));
const VALID_RESOURCE_TYPES = new Set(Object.values(ResourceType));
const VALID_ACTIONS        = new Set(Object.values(Action));
const VALID_SCOPES         = new Set(Object.values(Scope));

/**
 * GET /api/permissions
 * List permission rules for the current user.
 *
 * Query params:
 *   - subjectType: filter by subject type
 *   - resourceType: filter by resource type
 *   - resourceName: filter by resource name
 *   - sessionId: filter by session scope
 */
router.get('/', (req, res) => {
  let filters = { ownerId: req.user.id };

  if (req.query.subjectType)
    filters.subjectType = req.query.subjectType;

  if (req.query.resourceType)
    filters.resourceType = req.query.resourceType;

  if (req.query.resourceName)
    filters.resourceName = req.query.resourceName;

  if (req.query.sessionId)
    filters.sessionId = parseInt(req.query.sessionId, 10);

  let rules = listRules(filters);
  return res.json({ rules });
});

/**
 * POST /api/permissions
 * Create a permission rule.
 *
 * Body:
 *   - subjectType: 'user' | 'agent' | 'plugin' | '*'  (required)
 *   - subjectId:   number | null
 *   - resourceType: 'command' | 'tool' | 'ability' | '*'  (required)
 *   - resourceName: string | null
 *   - action:      'allow' | 'deny' | 'prompt'  (required)
 *   - scope:       'once' | 'session' | 'permanent'  (default: 'permanent')
 *   - sessionId:   number | null
 *   - conditions:  object | null
 *   - priority:    number  (default: 0)
 */
router.post('/', (req, res) => {
  let {
    subjectType,
    subjectId,
    resourceType,
    resourceName,
    action,
    scope,
    sessionId,
    conditions,
    priority,
  } = req.body;

  // Validate required fields
  if (!subjectType || !VALID_SUBJECT_TYPES.has(subjectType))
    return res.status(400).json({ error: `Invalid subjectType. Must be one of: ${[...VALID_SUBJECT_TYPES].join(', ')}` });

  if (!resourceType || !VALID_RESOURCE_TYPES.has(resourceType))
    return res.status(400).json({ error: `Invalid resourceType. Must be one of: ${[...VALID_RESOURCE_TYPES].join(', ')}` });

  if (!action || !VALID_ACTIONS.has(action))
    return res.status(400).json({ error: `Invalid action. Must be one of: ${[...VALID_ACTIONS].join(', ')}` });

  if (scope && !VALID_SCOPES.has(scope))
    return res.status(400).json({ error: `Invalid scope. Must be one of: ${[...VALID_SCOPES].join(', ')}` });

  // Session-scoped rules require a session ID
  if (scope === Scope.SESSION && !sessionId)
    return res.status(400).json({ error: 'Session-scoped rules require a sessionId' });

  // Validate session ownership if sessionId provided
  if (sessionId) {
    let db      = getDatabase();
    let session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, req.user.id);
    if (!session)
      return res.status(404).json({ error: 'Session not found' });
  }

  try {
    let rule = createRule({
      ownerId:    req.user.id,
      sessionId:  sessionId || null,
      subjectType,
      subjectId:  subjectId || null,
      resourceType,
      resourceName: resourceName || null,
      action,
      scope:      scope || Scope.PERMANENT,
      conditions: conditions || null,
      priority:   priority || 0,
    });

    return res.status(201).json(rule);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/permissions/:id
 * Get a specific permission rule.
 */
router.get('/:id', (req, res) => {
  let ruleId = parseInt(req.params.id, 10);
  let rule   = getRule(ruleId);

  if (!rule)
    return res.status(404).json({ error: 'Rule not found' });

  // Only allow viewing own rules
  if (rule.ownerId !== req.user.id)
    return res.status(404).json({ error: 'Rule not found' });

  return res.json(rule);
});

/**
 * DELETE /api/permissions/:id
 * Delete a permission rule.
 */
router.delete('/:id', (req, res) => {
  let ruleId = parseInt(req.params.id, 10);
  let rule   = getRule(ruleId);

  if (!rule)
    return res.status(404).json({ error: 'Rule not found' });

  // Only allow deleting own rules
  if (rule.ownerId !== req.user.id)
    return res.status(404).json({ error: 'Rule not found' });

  deleteRule(ruleId);
  return res.json({ success: true });
});

/**
 * POST /api/permissions/evaluate
 * Test permission evaluation (for debugging/UI).
 *
 * Body:
 *   - subjectType: string (required)
 *   - subjectId:   number (required)
 *   - resourceType: string (required)
 *   - resourceName: string (required)
 *   - sessionId:   number | null
 */
router.post('/evaluate', (req, res) => {
  let { subjectType, subjectId, resourceType, resourceName, sessionId } = req.body;

  if (!subjectType || !subjectId || !resourceType || !resourceName)
    return res.status(400).json({ error: 'subjectType, subjectId, resourceType, and resourceName are required' });

  let result = evaluate(
    { type: subjectType, id: subjectId },
    { type: resourceType, name: resourceName },
    { sessionId: sessionId || null, ownerId: req.user.id },
  );

  return res.json(result);
});

export default router;
