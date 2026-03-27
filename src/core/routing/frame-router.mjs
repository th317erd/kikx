'use strict';

import { SelectorCompiler } from './selector-compiler.mjs';

// =============================================================================
// FrameRouter — Event routing engine for frame mutations
// =============================================================================
// Listens for non-silent commits on connected FrameManagers. When a commit
// arrives, matches each changed frame against registered selectors and
// dispatches through a next()/done() middleware chain.
//
// Key behaviors:
//   - Routing happens per-commit; selectors match per-frame within the commit
//   - Handler isolation: one handler crash never breaks the chain
//   - Re-entrant safety: if a handler creates frames (new commit), the new
//     commit is queued and processed iteratively after the current commit
//   - Silent commits are never routed
// =============================================================================

export class FrameRouter {
  constructor(options = {}) {
    this._registrations = [];  // { matcher, PluginClass, pluginName }
    this._logger        = options.logger || console;
    this._processing    = false;
    this._queue         = [];
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  // Register a selector + plugin class. Selector is compiled once here.
  registerSelector(selector, PluginClass, pluginName) {
    let matcher = SelectorCompiler.compile(selector);
    this._registrations.push({ matcher, PluginClass, pluginName: pluginName || null });
  }

  // Bulk-load all selectors from a PluginRegistry.
  loadFromRegistry(registry) {
    let entries = registry.getSelectors();

    for (let i = 0; i < entries.length; i++) {
      let entry = entries[i];
      this.registerSelector(entry.selector, entry.PluginClass, entry.pluginName);
    }
  }

  // ---------------------------------------------------------------------------
  // Connect to a FrameManager
  // ---------------------------------------------------------------------------

  // Subscribe to a FrameManager's commit events.
  // Returns a cleanup function to unsubscribe.
  connectTo(frameManager, sessionContext, options) {
    let connectOptions = options || {};

    let handler = ({ commit }) => {
      if (commit.silent)
        return;

      this._enqueue(frameManager, commit, sessionContext || null, connectOptions);
    };

    frameManager.on('commit', handler);

    return () => frameManager.off('commit', handler);
  }

  // ---------------------------------------------------------------------------
  // Queue processing (re-entrant safety)
  // ---------------------------------------------------------------------------

  _enqueue(frameManager, commit, sessionContext, connectOptions) {
    this._queue.push({ frameManager, commit, sessionContext, connectOptions });

    if (!this._processing)
      this._processQueue();
  }

  async _processQueue() {
    this._processing = true;

    while (this._queue.length > 0) {
      let entry = this._queue.shift();

      try {
        await this._routeCommit(entry.frameManager, entry.commit, entry.sessionContext, entry.connectOptions);
      } catch (err) {
        this._logger.error('FrameRouter: uncaught error in _routeCommit:', err);
      }
    }

    this._processing = false;
  }

  // ---------------------------------------------------------------------------
  // Per-commit routing
  // ---------------------------------------------------------------------------

  async _routeCommit(frameManager, commit, sessionContext, connectOptions) {
    let changes = commit.changes;

    if (!changes || changes.length === 0)
      return;

    for (let i = 0; i < changes.length; i++) {
      let change = changes[i];

      // Get the current frame
      let frame = frameManager.getHead(change.frameID) || frameManager.get(change.frameID);

      if (!frame)
        continue;

      // Find all matching registrations
      let matching = [];

      for (let j = 0; j < this._registrations.length; j++) {
        let reg = this._registrations[j];

        try {
          if (reg.matcher(frame))
            matching.push(reg);
        } catch (err) {
          this._logger.error(`FrameRouter: selector matcher threw for plugin "${reg.pluginName}":`, err);
        }
      }

      if (matching.length === 0)
        continue;

      // Build routing context
      let context = this._buildContext(frameManager, frame, change, commit, sessionContext);

      // Execute the middleware chain with state hydration/persistence
      await this._executeChainWithState(matching, context, frame, connectOptions);
    }
  }

  // ---------------------------------------------------------------------------
  // Context building
  // ---------------------------------------------------------------------------

  _buildContext(frameManager, frame, change, commit, sessionContext) {
    let previousFrame = null;

    if (change.operation === 'update') {
      let history = frameManager.getVersionHistory(change.frameID);

      if (history.length >= 2)
        previousFrame = history[history.length - 2];
    }

    let propChanges = this._computeChanges(previousFrame, frame);

    return {
      frames:        frameManager,
      previousFrame,
      newFrame:      frame,
      changes:       propChanges,
      commit,
      engine:        frameManager,
      session:       sessionContext,
      logger:        this._logger,
    };
  }

  // Compute property-level diffs between previousFrame and newFrame.
  _computeChanges(previousFrame, newFrame) {
    if (!previousFrame)
      return [];

    let changes  = [];
    let allKeys  = new Set();

    // Gather all property names from both frames
    let prevKeys = Object.keys(previousFrame);
    let newKeys  = Object.keys(newFrame);

    for (let i = 0; i < prevKeys.length; i++)
      allKeys.add(prevKeys[i]);

    for (let i = 0; i < newKeys.length; i++)
      allKeys.add(newKeys[i]);

    for (let key of allKeys) {
      let prev = previousFrame[key];
      let curr = newFrame[key];

      if (prev !== curr)
        changes.push({ propName: key, previousValue: prev, newValue: curr });
    }

    return changes;
  }

  // ---------------------------------------------------------------------------
  // State hydration + middleware chain + state persistence
  // ---------------------------------------------------------------------------

  async _executeChainWithState(matchingPlugins, context, frame, connectOptions) {
    // Hydrate raw state from the frame
    let rawState = {};

    try {
      if (frame.state) {
        let parsed = (typeof frame.state === 'string') ? JSON.parse(frame.state) : frame.state;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          rawState = parsed;
      }
    } catch (_e) {
      rawState = {};
    }

    // Create a Proxy with dirty tracking
    let dirty = false;

    let stateProxy = new Proxy(rawState, {
      set(target, prop, value) {
        target[prop] = value;
        dirty = true;
        return true;
      },
      deleteProperty(target, prop) {
        delete target[prop];
        dirty = true;
        return true;
      },
    });

    // Side-channel error flag for plugin throws
    let stateError = { value: false };
    context._stateError = stateError;

    // Execute the chain — pass stateProxy so _invokePlugin can set it on each instance
    await this._executeChain(matchingPlugins, context, stateProxy);

    {
      // Persist state if dirty and no plugin threw
      if (dirty && !stateError.value) {
        // Update the in-memory frame for the current routing cycle
        frame.state = JSON.stringify(rawState);

        // Persist via FrameManager merge (silent to avoid re-routing)
        let frameManager = context.frames;
        if (frameManager)
          frameManager.merge([{ ...frame, state: JSON.stringify(rawState) }], { silent: true });

        // Persist to DB if FramePersistence is available
        let framePersistence = (connectOptions && connectOptions.framePersistence) || null;

        if (framePersistence) {
          try {
            await framePersistence.saveFrames(
              (context.session && context.session.id) || null,
              [{ ...frame, state: JSON.stringify(rawState) }],
            );
          } catch (persistErr) {
            this._logger.error('FrameRouter: failed to persist plugin state:', persistErr);
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Middleware chain execution
  // ---------------------------------------------------------------------------

  async _executeChain(matchingPlugins, context, stateProxy) {
    let index     = 0;
    let chainDone = false;

    let advance = async (ctx) => {
      if (chainDone)
        return;

      if (index >= matchingPlugins.length)
        return;

      let registration = matchingPlugins[index++];
      await this._invokePlugin(registration, ctx || context, advance, stop, stateProxy);
    };

    let stop = async () => {
      chainDone = true;
    };

    await advance(context);
  }

  async _invokePlugin(registration, context, next, done, stateProxy) {
    let instance;

    try {
      instance = new registration.PluginClass(context);
    } catch (err) {
      this._logger.error(
        `FrameRouter: failed to instantiate plugin "${registration.pluginName}":`, err,
      );
      // Continue chain on instantiation failure
      await next(context);
      return;
    }

    // Attach state proxy if available
    if (stateProxy !== undefined)
      instance._state = stateProxy;

    let called = false;

    let wrappedNext = (ctx) => {
      called = true;
      return next(ctx || context);
    };

    let wrappedDone = (ctx) => {
      called = true;
      return done(ctx || context);
    };

    try {
      await instance.process(wrappedNext, wrappedDone);
    } catch (err) {
      this._logger.error(
        `FrameRouter: plugin "${registration.pluginName}" threw in process():`, err,
      );

      // Mark chain as having encountered a plugin error (prevents state persistence)
      if (context._stateError !== undefined)
        context._stateError.value = true;
    } finally {
      if (!called) {
        this._logger.error(
          `FrameRouter: plugin "${registration.pluginName}" returned without calling next() or done(). Calling next() automatically.`,
        );

        try {
          await next(context);
        } catch (err) {
          this._logger.error('FrameRouter: auto-next() after missing call threw:', err);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  getRegistrations() {
    return [...this._registrations];
  }
}
