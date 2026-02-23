'use strict';

// ============================================================================
// Self-Approval Prevention Tests (S5)
// ============================================================================
// COORD-003: Agent approves own action → rejected
// GUARD-007: User approves agent action → accepted

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  handleApprovalResponse,
  getPendingApproval,
  _addPendingApproval,
} from '../../server/lib/abilities/approval.mjs';

import { getInteractionBus } from '../../server/lib/interactions/bus.mjs';

// ============================================================================
// COORD-003: Agent cannot approve its own actions
// ============================================================================

describe('COORD-003: Agent self-approval prevention', () => {
  let executionId;
  let agentId;

  beforeEach(() => {
    executionId = `test-exec-${Date.now()}-${Math.random()}`;
    agentId = 42;
  });

  it('should reject when agent tries to approve its own execution', () => {
    // Set up a pending approval with an agentId
    _addPendingApproval(executionId, {
      resolve:     () => {},
      ability:     { name: 'test_ability', permissions: {} },
      context:     { userId: 1, sessionId: 1 },
      userId:      1,
      agentId:     agentId,
      requestHash: 'abc123',
    });

    // Verify it's pending
    assert.ok(getPendingApproval(executionId));

    // Agent 42 tries to approve its own action
    let result = handleApprovalResponse(
      executionId,
      true,
      null,
      false,
      { agentId: agentId }
    );

    assert.equal(result.success, false);
    assert.ok(result.error.includes('cannot approve their own'));

    // Approval should still be pending (not consumed)
    assert.ok(getPendingApproval(executionId));

    // Clean up
    handleApprovalResponse(executionId, false, 'cleanup', false, { userId: 1 });
  });

  it('should allow a different agent to approve', () => {
    let resolved = null;
    _addPendingApproval(executionId, {
      resolve:     (val) => { resolved = val; },
      ability:     { name: 'test_ability', permissions: {} },
      context:     { userId: 1, sessionId: 1 },
      userId:      1,
      agentId:     agentId,
      requestHash: 'abc123',
    });

    // Different agent (99) approves
    let result = handleApprovalResponse(
      executionId,
      true,
      null,
      false,
      { agentId: 99 }
    );

    assert.equal(result.success, true);
    assert.ok(resolved);
    assert.equal(resolved.status, 'approved');
  });

  it('should reject when agent self-approves via interaction bus', () => {
    let bus = getInteractionBus();

    // Create an interaction originated by agent 42
    let interaction = bus.create('@user', 'approval', { data: 'test' }, {
      sessionId:     1,
      userId:        1,
      sourceAgentId: 42,
    });

    assert.equal(interaction.source_agent_id, 42);

    // Register as pending
    let requestPromise = bus.request(interaction, 5000);

    // Agent 42 tries to respond to its own interaction
    let responded = bus.respond(
      interaction.interaction_id,
      { approved: true },
      true,
      { agentId: 42 }
    );

    assert.equal(responded, false, 'Agent should not respond to its own interaction');

    // Clean up — let a user respond
    bus.respond(interaction.interaction_id, { approved: true }, true, {});
  });

  it('should allow different agent to respond via interaction bus', () => {
    let bus = getInteractionBus();

    let interaction = bus.create('@user', 'approval', { data: 'test' }, {
      sessionId:     1,
      userId:        1,
      sourceAgentId: 42,
    });

    let requestPromise = bus.request(interaction, 5000);

    // Agent 99 responds to agent 42's interaction — allowed
    let responded = bus.respond(
      interaction.interaction_id,
      { approved: true },
      true,
      { agentId: 99 }
    );

    assert.equal(responded, true);
  });
});

// ============================================================================
// GUARD-007: User can approve agent actions
// ============================================================================

describe('GUARD-007: User can approve agent actions', () => {
  it('should accept when user approves (no agentId in security context)', () => {
    let executionId = `test-user-approve-${Date.now()}`;
    let resolved = null;

    _addPendingApproval(executionId, {
      resolve:     (val) => { resolved = val; },
      ability:     { name: 'test_ability', permissions: {} },
      context:     { userId: 1, sessionId: 1 },
      userId:      1,
      agentId:     42,
      requestHash: 'abc123',
    });

    // User approves — no agentId in security context
    let result = handleApprovalResponse(
      executionId,
      true,
      null,
      false,
      { userId: 1 }
    );

    assert.equal(result.success, true);
    assert.ok(resolved);
    assert.equal(resolved.status, 'approved');
  });

  it('should accept when user denies (no agentId in security context)', () => {
    let executionId = `test-user-deny-${Date.now()}`;
    let resolved = null;

    _addPendingApproval(executionId, {
      resolve:     (val) => { resolved = val; },
      ability:     { name: 'test_ability', permissions: {} },
      context:     { userId: 1, sessionId: 1 },
      userId:      1,
      agentId:     42,
      requestHash: 'abc123',
    });

    // User denies
    let result = handleApprovalResponse(
      executionId,
      false,
      'Not now',
      false,
      { userId: 1 }
    );

    assert.equal(result.success, true);
    assert.ok(resolved);
    assert.equal(resolved.status, 'denied');
    assert.equal(resolved.reason, 'Not now');
  });

  it('should accept with empty security context', () => {
    let executionId = `test-empty-ctx-${Date.now()}`;
    let resolved = null;

    _addPendingApproval(executionId, {
      resolve:     (val) => { resolved = val; },
      ability:     { name: 'test_ability', permissions: {} },
      context:     { userId: 1, sessionId: 1 },
      userId:      1,
      agentId:     42,
      requestHash: 'abc123',
    });

    let result = handleApprovalResponse(executionId, true, null, false, {});

    assert.equal(result.success, true);
    assert.ok(resolved);
    assert.equal(resolved.status, 'approved');
  });
});

// ============================================================================
// Edge cases
// ============================================================================

describe('Self-approval edge cases', () => {
  it('should track source_agent_id on interaction create', () => {
    let bus = getInteractionBus();

    let withAgent = bus.create('@system', 'test', {}, { sourceAgentId: 7 });
    assert.equal(withAgent.source_agent_id, 7);

    let withoutAgent = bus.create('@system', 'test', {}, {});
    assert.equal(withoutAgent.source_agent_id, null);
  });

  it('should skip self-approval check when agentId is null', () => {
    let executionId = `test-null-agent-${Date.now()}`;
    let resolved = null;

    _addPendingApproval(executionId, {
      resolve:     (val) => { resolved = val; },
      ability:     { name: 'test_ability', permissions: {} },
      context:     { userId: 1, sessionId: 1 },
      userId:      1,
      agentId:     null,
      requestHash: 'abc123',
    });

    // Even with agentId in security context, if pending has null agentId, skip check
    let result = handleApprovalResponse(executionId, true, null, false, { agentId: 42 });

    assert.equal(result.success, true);
    assert.ok(resolved);
  });

  it('should skip self-approval check when no agent in security context', () => {
    let executionId = `test-no-sec-agent-${Date.now()}`;
    let resolved = null;

    _addPendingApproval(executionId, {
      resolve:     (val) => { resolved = val; },
      ability:     { name: 'test_ability', permissions: {} },
      context:     { userId: 1, sessionId: 1 },
      userId:      1,
      agentId:     42,
      requestHash: 'abc123',
    });

    let result = handleApprovalResponse(executionId, true, null, false, {});
    assert.equal(result.success, true);
  });
});
