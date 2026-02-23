'use strict';

// ============================================================================
// InteractionFunction - Base Class
// ============================================================================
// Base class for interactive functions with lifecycle, registration, and
// permission checking.
//
// Functions are instantiated actors with:
// - Static registration: defines metadata, schema, and permissions
// - Execution-level promise: resolves when the function completes its lifecycle
// - Method-level promises: resolve when individual method calls complete
// - Permission checking: allowed() method validates before execution

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

// Permission levels for function methods
export const PERMISSION = {
  ALWAYS: 'always',  // No permission check needed
  ASK:    'ask',     // Ask user for permission
  NEVER:  'never',   // Always deny
};

/**
 * Base class for interaction functions.
 * Subclasses should:
 * - Override static register() to define metadata
 * - Override execute() for main functionality
 * - Override allowed() for custom permission logic
 * - Optionally override handle() for incoming interactions
 */
export class InteractionFunction extends EventEmitter {
  // -------------------------------------------------------------------------
  // Static Registration API
  // -------------------------------------------------------------------------

  /**
   * Register this function class.
   * Override in subclasses to provide metadata for the interaction system.
   *
   * @returns {Object} Registration info
   * @returns {string} info.name - Function name (used as target_property)
   * @returns {string} info.description - Human-readable description
   * @returns {string} [info.target='@system'] - Target ID for routing
   * @returns {string} [info.permission='always'] - Default permission level
   * @returns {Object} [info.schema] - JSON Schema for payload validation
   * @returns {Array<Object>} [info.methods] - Additional callable methods
   */
  static register() {
    throw new Error(`${this.name}.register() must be implemented by subclass`);
  }

  /**
   * Get the function name from registration.
   *
   * @returns {string} Function name
   */
  static get functionName() {
    return this.register().name;
  }

  /**
   * Check if this class has registration info.
   *
   * @returns {boolean} True if register() is implemented
   */
  static get isRegisterable() {
    try {
      this.register();
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Instance Constructor
  // -------------------------------------------------------------------------

  /**
   * Create a new InteractionFunction.
   *
   * @param {string} name - Function name
   * @param {Object} context - Execution context
   * @param {number} [context.sessionId] - Session ID
   * @param {number} [context.userId] - User ID
   * @param {string} [context.interactionId] - Source interaction ID
   */
  constructor(name, context = {}) {
    super();

    this.id          = randomUUID();
    this.name        = name;
    this.context     = context;
    this.state       = 'pending';  // pending, running, completed, failed, cancelled
    this.startedAt   = null;
    this.completedAt = null;
    this.result      = null;
    this.error       = null;

    // Execution-level promise (lifecycle)
    this._executionResolve = null;
    this._executionReject  = null;
    this.execution         = new Promise((resolve, reject) => {
      this._executionResolve = resolve;
      this._executionReject  = reject;
    });

    // Pending method calls (method-level promises)
    this._pendingCalls = new Map();
  }

  // -------------------------------------------------------------------------
  // Permission Checking
  // -------------------------------------------------------------------------

  /**
   * Check if execution is allowed with the given payload.
   * Override in subclasses for custom permission logic.
   *
   * @param {*} payload - The payload to check
   * @param {Object} context - Execution context
   * @returns {Promise<{allowed: boolean, reason?: string}>}
   */
  async allowed(payload, context = {}) {
    // Default: check registration permission level
    let reg = this.constructor.register?.() || {};
    let permission = reg.permission || PERMISSION.ALWAYS;

    if (permission === PERMISSION.NEVER) {
      return { allowed: false, reason: 'Function is disabled' };
    }

    if (permission === PERMISSION.ASK) {
      // TODO: Implement user permission prompts
      // For now, allow but could be extended
      return { allowed: true, requiresApproval: true };
    }

    return { allowed: true };
  }

  /**
   * Check if a specific method is allowed.
   *
   * @param {string} methodName - Method name
   * @param {*} payload - Method payload
   * @param {Object} context - Execution context
   * @returns {Promise<{allowed: boolean, reason?: string}>}
   */
  async methodAllowed(methodName, payload, context = {}) {
    let reg = this.constructor.register?.() || {};
    let methods = reg.methods || [];
    let method = methods.find((m) => m.name === methodName);

    if (!method) {
      // If method not in registration, defer to main allowed()
      return await this.allowed(payload, context);
    }

    let permission = method.permission || reg.permission || PERMISSION.ALWAYS;

    if (permission === PERMISSION.NEVER) {
      return { allowed: false, reason: `Method '${methodName}' is disabled` };
    }

    if (permission === PERMISSION.ASK) {
      return { allowed: true, requiresApproval: true };
    }

    return { allowed: true };
  }

  // -------------------------------------------------------------------------
  // Lifecycle Methods
  // -------------------------------------------------------------------------

  /**
   * Start the function execution.
   *
   * @param {Object} params - Execution parameters
   * @returns {Promise<*>} Execution result
   */
  async start(params = {}) {
    if (this.state !== 'pending') {
      throw new Error(`Cannot start function in state: ${this.state}`);
    }

    this.state     = 'running';
    this.startedAt = new Date();
    this.emit('start', { id: this.id, name: this.name, params });

    try {
      this.result = await this.execute(params);
      this.state  = 'completed';
      this.completedAt = new Date();
      this.emit('complete', { id: this.id, name: this.name, result: this.result });
      this._executionResolve(this.result);
      return this.result;
    } catch (error) {
      this.error = error;
      this.state = 'failed';
      this.completedAt = new Date();
      this.emit('error', { id: this.id, name: this.name, error });
      this._executionReject(error);
      throw error;
    }
  }

  /**
   * Cancel the function execution.
   *
   * @param {string} reason - Cancellation reason
   * @returns {boolean} True if cancelled
   */
  cancel(reason = 'Cancelled') {
    if (this.state !== 'running' && this.state !== 'pending') {
      return false;
    }

    this.state = 'cancelled';
    this.error = new Error(reason);
    this.completedAt = new Date();

    // Reject all pending method calls
    for (let [callId, { reject }] of this._pendingCalls) {
      reject(new Error(`Function cancelled: ${reason}`));
    }
    this._pendingCalls.clear();

    this.emit('cancel', { id: this.id, name: this.name, reason });
    this._executionReject(this.error);

    return true;
  }

  /**
   * Execute the function. Override in subclasses.
   *
   * @param {Object} params - Execution parameters
   * @returns {Promise<*>} Execution result
   */
  async execute(params) {
    throw new Error('execute() must be implemented by subclass');
  }

  /**
   * Handle an incoming interaction. Override in subclasses.
   *
   * @param {Object} interaction - The interaction
   * @returns {Promise<*>} Response
   */
  async handle(interaction) {
    throw new Error(`Unhandled interaction: ${interaction.target_property}`);
  }

  // -------------------------------------------------------------------------
  // Method-Level Promises
  // -------------------------------------------------------------------------

  /**
   * Call a method on this function (creates a method-level promise).
   *
   * @param {string} method - Method name
   * @param {*} payload - Method payload
   * @param {number} timeout - Timeout in milliseconds (0 = no timeout)
   * @returns {Promise<*>} Method result
   */
  call(method, payload, timeout = 0) {
    let callId = randomUUID();

    return new Promise((resolve, reject) => {
      let timeoutId = null;

      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          this._pendingCalls.delete(callId);
          reject(new Error(`Method call timed out: ${method}`));
        }, timeout);
      }

      this._pendingCalls.set(callId, {
        method,
        payload,
        resolve: (result) => {
          if (timeoutId) clearTimeout(timeoutId);
          this._pendingCalls.delete(callId);
          resolve(result);
        },
        reject: (error) => {
          if (timeoutId) clearTimeout(timeoutId);
          this._pendingCalls.delete(callId);
          reject(error);
        },
        createdAt: new Date(),
      });

      // Emit the call event for the interaction bus to handle
      this.emit('call', {
        callId,
        functionId: this.id,
        method,
        payload,
      });
    });
  }

  /**
   * Resolve a pending method call.
   *
   * @param {string} callId - Call ID
   * @param {*} result - Call result
   * @returns {boolean} True if call was pending
   */
  resolveCall(callId, result) {
    let pending = this._pendingCalls.get(callId);

    if (!pending)
      return false;

    pending.resolve(result);
    return true;
  }

  /**
   * Reject a pending method call.
   *
   * @param {string} callId - Call ID
   * @param {Error|string} error - Error
   * @returns {boolean} True if call was pending
   */
  rejectCall(callId, error) {
    let pending = this._pendingCalls.get(callId);

    if (!pending)
      return false;

    pending.reject((error instanceof Error) ? error : new Error(error));
    return true;
  }

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  /**
   * Get function info for serialization.
   *
   * @returns {Object} Function info
   */
  toJSON() {
    return {
      id:          this.id,
      name:        this.name,
      state:       this.state,
      startedAt:   this.startedAt,
      completedAt: this.completedAt,
      result:      this.result,
      error:       this.error?.message || null,
    };
  }
}

export default InteractionFunction;
