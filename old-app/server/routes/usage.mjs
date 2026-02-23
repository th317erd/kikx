'use strict';

import { Router } from 'express';
import { getDatabase } from '../database.mjs';
import { requireAuth } from '../middleware/auth.mjs';
import { loadSessionWithAgent } from '../lib/participants/index.mjs';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// Token rates for cost calculation
const INPUT_TOKEN_RATE  = 0.003 / 1000;   // $3 per 1M input tokens
const OUTPUT_TOKEN_RATE = 0.015 / 1000;   // $15 per 1M output tokens

/**
 * Calculate cost from tokens.
 */
function calculateCost(inputTokens, outputTokens) {
  return (inputTokens * INPUT_TOKEN_RATE) + (outputTokens * OUTPUT_TOKEN_RATE);
}

/**
 * GET /api/usage
 * Get usage summary. Returns global spend for the user.
 * For service/session spend, use /api/usage/session/:sessionId
 */
router.get('/', (req, res) => {
  let db = getDatabase();

  // Global spend: sum of ALL charges for ALL agents owned by this user
  let globalSpend = db.prepare(`
    SELECT
      COALESCE(SUM(tc.input_tokens), 0) as input_tokens,
      COALESCE(SUM(tc.output_tokens), 0) as output_tokens,
      COALESCE(SUM(tc.cost_cents), 0) as cost_cents
    FROM token_charges tc
    JOIN agents a ON tc.agent_id = a.id
    WHERE a.user_id = ?
  `).get(req.user.id);

  // Also include legacy session-based tracking and corrections
  let legacySessionUsage = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens
    FROM sessions
    WHERE user_id = ?
  `).get(req.user.id);

  let legacyCorrections = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens
    FROM usage_corrections
    WHERE user_id = ?
  `).get(req.user.id);

  // Combine new charges with legacy data
  let totalInputTokens = (globalSpend?.input_tokens || 0) +
                         (legacySessionUsage?.input_tokens || 0) +
                         (legacyCorrections?.input_tokens || 0);
  let totalOutputTokens = (globalSpend?.output_tokens || 0) +
                          (legacySessionUsage?.output_tokens || 0) +
                          (legacyCorrections?.output_tokens || 0);
  let totalCostCents = globalSpend?.cost_cents || 0;

  // Calculate cost for legacy tokens
  let legacyCost = calculateCost(
    (legacySessionUsage?.input_tokens || 0) + (legacyCorrections?.input_tokens || 0),
    (legacySessionUsage?.output_tokens || 0) + (legacyCorrections?.output_tokens || 0)
  );

  return res.json({
    global: {
      inputTokens:  totalInputTokens,
      outputTokens: totalOutputTokens,
      costCents:    totalCostCents + Math.round(legacyCost * 100),
      cost:         (totalCostCents / 100) + legacyCost,
    },
  });
});

/**
 * GET /api/usage/session/:sessionId
 * Get usage for a specific session, including service spend (same API key).
 */
router.get('/session/:sessionId', (req, res) => {
  let db = getDatabase();
  let sessionId = parseInt(req.params.sessionId, 10);

  // Get session and its agent (via participants, falls back to legacy agent_id)
  let session = loadSessionWithAgent(sessionId, req.user.id, db);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Global spend: ALL charges for ALL agents owned by this user
  let globalSpend = db.prepare(`
    SELECT
      COALESCE(SUM(tc.input_tokens), 0) as input_tokens,
      COALESCE(SUM(tc.output_tokens), 0) as output_tokens,
      COALESCE(SUM(tc.cost_cents), 0) as cost_cents
    FROM token_charges tc
    JOIN agents a ON tc.agent_id = a.id
    WHERE a.user_id = ?
  `).get(req.user.id);

  // Service spend: charges for ALL agents with the same API key
  let serviceSpend = db.prepare(`
    SELECT
      COALESCE(SUM(tc.input_tokens), 0) as input_tokens,
      COALESCE(SUM(tc.output_tokens), 0) as output_tokens,
      COALESCE(SUM(tc.cost_cents), 0) as cost_cents
    FROM token_charges tc
    JOIN agents a ON tc.agent_id = a.id
    WHERE a.encrypted_api_key = ? AND a.user_id = ?
  `).get(session.encrypted_api_key, req.user.id);

  // Session spend: charges for just this session
  let sessionSpend = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cost_cents), 0) as cost_cents
    FROM token_charges
    WHERE session_id = ?
  `).get(sessionId);

  // Also include legacy session-based tracking
  let legacySessionUsage = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens
    FROM sessions
    WHERE user_id = ?
  `).get(req.user.id);

  let legacyCorrections = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens
    FROM usage_corrections
    WHERE user_id = ?
  `).get(req.user.id);

  // Legacy cost calculation
  let legacyCost = calculateCost(
    (legacySessionUsage?.input_tokens || 0) + (legacyCorrections?.input_tokens || 0),
    (legacySessionUsage?.output_tokens || 0) + (legacyCorrections?.output_tokens || 0)
  );

  // Combine global with legacy
  let globalInputTokens = (globalSpend?.input_tokens || 0) +
                          (legacySessionUsage?.input_tokens || 0) +
                          (legacyCorrections?.input_tokens || 0);
  let globalOutputTokens = (globalSpend?.output_tokens || 0) +
                           (legacySessionUsage?.output_tokens || 0) +
                           (legacyCorrections?.output_tokens || 0);
  let globalCostCents = (globalSpend?.cost_cents || 0) + Math.round(legacyCost * 100);

  return res.json({
    global: {
      inputTokens:  globalInputTokens,
      outputTokens: globalOutputTokens,
      costCents:    globalCostCents,
      cost:         globalCostCents / 100,
    },
    service: {
      inputTokens:  serviceSpend?.input_tokens || 0,
      outputTokens: serviceSpend?.output_tokens || 0,
      costCents:    serviceSpend?.cost_cents || 0,
      cost:         (serviceSpend?.cost_cents || 0) / 100,
    },
    session: {
      inputTokens:  sessionSpend?.input_tokens || 0,
      outputTokens: sessionSpend?.output_tokens || 0,
      costCents:    sessionSpend?.cost_cents || 0,
      cost:         (sessionSpend?.cost_cents || 0) / 100,
    },
  });
});

/**
 * POST /api/usage/charge
 * Record a token charge for an API call.
 */
router.post('/charge', (req, res) => {
  let { agentId, sessionId, messageId, inputTokens, outputTokens, description } = req.body;
  let db = getDatabase();

  // Verify agent belongs to user
  let agent = db.prepare('SELECT id FROM agents WHERE id = ? AND user_id = ?').get(agentId, req.user.id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  // Calculate cost in cents
  let cost = calculateCost(inputTokens || 0, outputTokens || 0);
  let costCents = Math.round(cost * 100);

  let result = db.prepare(`
    INSERT INTO token_charges (agent_id, session_id, message_id, input_tokens, output_tokens, cost_cents, charge_type, description)
    VALUES (?, ?, ?, ?, ?, ?, 'usage', ?)
  `).run(agentId, sessionId || null, messageId || null, inputTokens || 0, outputTokens || 0, costCents, description || null);

  return res.status(201).json({
    id:           result.lastInsertRowid,
    inputTokens:  inputTokens || 0,
    outputTokens: outputTokens || 0,
    costCents:    costCents,
    cost:         cost,
  });
});

/**
 * POST /api/usage/correction
 * Add a usage correction. User provides their actual current cost,
 * and we calculate the difference from what we're tracking.
 */
router.post('/correction', (req, res) => {
  let { agentId, actualCost, reason } = req.body;
  let db = getDatabase();

  if (actualCost === undefined) {
    return res.status(400).json({ error: 'actualCost is required' });
  }

  // If agentId is provided, verify it belongs to user and get it
  let agent = null;
  if (agentId) {
    agent = db.prepare('SELECT id FROM agents WHERE id = ? AND user_id = ?').get(agentId, req.user.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
  } else {
    // Get the first agent for this user (or we could require agentId)
    agent = db.prepare('SELECT id FROM agents WHERE user_id = ? LIMIT 1').get(req.user.id);
    if (!agent) {
      return res.status(400).json({ error: 'No agents found. Create an agent first.' });
    }
  }

  // Get current total
  let globalSpend = db.prepare(`
    SELECT COALESCE(SUM(cost_cents), 0) as cost_cents
    FROM token_charges tc
    JOIN agents a ON tc.agent_id = a.id
    WHERE a.user_id = ?
  `).get(req.user.id);

  // Include legacy data
  let legacySessionUsage = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens
    FROM sessions
    WHERE user_id = ?
  `).get(req.user.id);

  let legacyCorrections = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens
    FROM usage_corrections
    WHERE user_id = ?
  `).get(req.user.id);

  let legacyCost = calculateCost(
    (legacySessionUsage?.input_tokens || 0) + (legacyCorrections?.input_tokens || 0),
    (legacySessionUsage?.output_tokens || 0) + (legacyCorrections?.output_tokens || 0)
  );

  let currentCostCents = (globalSpend?.cost_cents || 0) + Math.round(legacyCost * 100);
  let currentCost = currentCostCents / 100;

  // Calculate correction needed
  let correctionCost = actualCost - currentCost;
  let correctionCostCents = Math.round(correctionCost * 100);

  // Only insert if there's actually a correction needed
  if (correctionCostCents !== 0) {
    // Estimate tokens from cost (assume 80% output, 20% input)
    let outputPortion = correctionCost * 0.8;
    let inputPortion = correctionCost * 0.2;
    let correctionOutputTokens = Math.round(outputPortion / OUTPUT_TOKEN_RATE);
    let correctionInputTokens = Math.round(inputPortion / INPUT_TOKEN_RATE);

    db.prepare(`
      INSERT INTO token_charges (agent_id, input_tokens, output_tokens, cost_cents, charge_type, description)
      VALUES (?, ?, ?, ?, 'correction', ?)
    `).run(agent.id, correctionInputTokens, correctionOutputTokens, correctionCostCents, reason || 'Manual correction');
  }

  let newCost = currentCost + correctionCost;

  return res.json({
    success:          true,
    previousCost:     currentCost,
    correctionAmount: correctionCost,
    newCost:          newCost,
  });
});

/**
 * GET /api/usage/history
 * Get charge history for the current user.
 */
router.get('/history', (req, res) => {
  let db = getDatabase();
  let limit = parseInt(req.query.limit, 10) || 50;

  let charges = db.prepare(`
    SELECT
      tc.id,
      tc.agent_id,
      a.name as agent_name,
      tc.session_id,
      tc.message_id,
      tc.input_tokens,
      tc.output_tokens,
      tc.cost_cents,
      tc.charge_type,
      tc.description,
      tc.created_at
    FROM token_charges tc
    JOIN agents a ON tc.agent_id = a.id
    WHERE a.user_id = ?
    ORDER BY tc.created_at DESC
    LIMIT ?
  `).all(req.user.id, limit);

  return res.json({
    charges: charges.map((c) => ({
      id:           c.id,
      agentId:      c.agent_id,
      agentName:    c.agent_name,
      sessionId:    c.session_id,
      messageId:    c.message_id,
      inputTokens:  c.input_tokens,
      outputTokens: c.output_tokens,
      costCents:    c.cost_cents,
      cost:         c.cost_cents / 100,
      chargeType:   c.charge_type,
      description:  c.description,
      createdAt:    c.created_at,
    })),
  });
});

export default router;
