'use strict';

import { getAllAssertionHandlers } from '../assertions/index.mjs';

/**
 * Execute a pipeline of assertions sequentially with middleware chain.
 *
 * All handlers are called for each assertion in alphabetical order.
 * Each handler decides whether to act on the assertion or pass through.
 *
 * @param {Array} assertions - Array of assertion objects
 * @param {object} context - Rich context object
 * @param {object} callbacks - Optional callbacks for state updates
 * @returns {Promise<Array>} Array of results
 */
export async function executeSequential(assertions, context, callbacks = {}) {
  let results = [];

  for (let assertion of assertions) {
    // Check for abort
    if (context.signal?.aborted) {
      results.push({
        ...assertion,
        status: 'aborted',
      });
      continue;
    }

    // Notify assertion started
    if (callbacks.onAssertionStart)
      callbacks.onAssertionStart(assertion);

    try {
      let result = await executeAssertion(assertion, context, callbacks);

      results.push({
        ...assertion,
        status: 'completed',
        result: result,
      });

      // Notify assertion completed
      if (callbacks.onAssertionComplete)
        callbacks.onAssertionComplete(assertion, result);

    } catch (error) {
      results.push({
        ...assertion,
        status: 'failed',
        error:  error.message,
      });

      // Notify assertion failed
      if (callbacks.onAssertionError)
        callbacks.onAssertionError(assertion, error);
    }
  }

  return results;
}

/**
 * Execute pipelines in parallel.
 *
 * Each key's pipeline runs sequentially, but all keys run in parallel.
 *
 * @param {object} pipelines - Object mapping keys to assertion arrays
 * @param {object} context - Rich context object
 * @param {object} callbacks - Optional callbacks for state updates
 * @returns {Promise<object>} Object mapping keys to results
 */
export async function executeParallel(pipelines, context, callbacks = {}) {
  let keys    = Object.keys(pipelines);
  let results = {};

  // Execute all pipelines in parallel
  let promises = keys.map(async (key) => {
    let pipelineContext = {
      ...context,
      pipeline: {
        ...context.pipeline,
        parallelKey: key,
      },
    };

    let pipelineResults = await executeSequential(
      pipelines[key],
      pipelineContext,
      callbacks
    );

    return { key, results: pipelineResults };
  });

  let pipelineResults = await Promise.all(promises);

  for (let { key, results: pResults } of pipelineResults)
    results[key] = pResults;

  return results;
}

/**
 * Execute a single assertion through the middleware pipeline.
 *
 * All handlers are called in alphabetical order. Each handler can:
 * - Transform the assertion and call next()
 * - Pass through unchanged by calling next(assertion)
 * - Short-circuit by returning a result without calling next()
 *
 * @param {object} assertion - The assertion object
 * @param {object} context - Rich context object
 * @param {object} callbacks - Optional callbacks
 * @returns {Promise<any>} The final result
 */
async function executeAssertion(assertion, context, callbacks = {}) {
  // Get all assertion handlers
  let handlers = getAllAssertionHandlers()
    .filter((h) => h && typeof h.execute === 'function');

  let handlerNames = handlers.map((h) => h.name);

  // Update context with pipeline info
  let pipelineContext = {
    ...context,
    pipeline: {
      ...context.pipeline,
      handlers: handlerNames,
      index:    0,
    },
  };

  // Build the middleware chain
  let index = 0;

  async function next(message) {
    // End of pipeline, return final message
    if (index >= handlers.length)
      return message;

    let handler      = handlers[index++];
    let handlerName  = handler.name || `handler_${index}`;

    // Update pipeline index in context
    pipelineContext.pipeline.index = index;

    // Notify handler invoked
    if (callbacks.onHandlerInvoke)
      callbacks.onHandlerInvoke(handlerName, message);

    try {
      // Execute handler with next function
      return await handler.execute(message, pipelineContext, next);
    } catch (error) {
      // Handler error - log and continue to next
      console.error(`Handler "${handlerName}" error:`, error.message);
      return next(message);
    }
  }

  // Start the pipeline
  return next(assertion);
}

/**
 * Execute operations (entry point for executor.mjs).
 *
 * Handles both sequential and parallel execution modes.
 *
 * @param {object} operationBlock - Parsed operation block from detectOperations
 * @param {object} context - Rich context object
 * @param {object} callbacks - Optional callbacks
 * @returns {Promise<object>} Execution results
 */
export async function executePipeline(operationBlock, context, callbacks = {}) {
  if (operationBlock.mode === 'sequential') {
    let results = await executeSequential(
      operationBlock.assertions,
      context,
      callbacks
    );

    return {
      mode:    'sequential',
      results: results,
    };
  }

  if (operationBlock.mode === 'parallel') {
    let pipelineResults = await executeParallel(
      operationBlock.pipelines,
      context,
      callbacks
    );

    return {
      mode:            'parallel',
      pipelineResults: pipelineResults,
    };
  }

  throw new Error(`Unknown execution mode: ${operationBlock.mode}`);
}

export default {
  executeSequential,
  executeParallel,
  executePipeline,
};
