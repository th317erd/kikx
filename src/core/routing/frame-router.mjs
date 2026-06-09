'use strict';

import { SelectorCompiler } from './selector-compiler.mjs';

export class FrameRouter {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this._registrations = [];
    this._queue = [];
    this._processing = false;
    this._flushWaiters = [];
  }

  registerSelector(selector, PluginClass, pluginName = null) {
    if (typeof PluginClass !== 'function')
      throw new TypeError('PluginClass must be a class/function');

    this._registrations.push({
      selector,
      matcher: SelectorCompiler.compile(selector),
      PluginClass,
      pluginName,
    });
  }

  loadFromRegistry(registry) {
    for (let entry of registry.getSelectors())
      this.registerSelector(entry.selector, entry.PluginClass, entry.pluginName);
  }

  connectTo(frameEngine, session = null, options = {}) {
    let handler = ({ commit }) => {
      if (commit.silent)
        return;

      this.enqueue(frameEngine, commit, session, options);
    };

    frameEngine.on('commit', handler);
    return () => frameEngine.off('commit', handler);
  }

  enqueue(frameEngine, commit, session = null, options = {}) {
    this._queue.push({ frameEngine, commit, session, options });

    if (!this._processing)
      this._processQueue();
  }

  async flush() {
    if (!this._processing && this._queue.length === 0)
      return;

    return await new Promise((resolve) => {
      this._flushWaiters.push(resolve);
    });
  }

  async _processQueue() {
    this._processing = true;

    while (this._queue.length > 0) {
      let item = this._queue.shift();

      try {
        await this.routeCommit(item.frameEngine, item.commit, item.session, item.options);
      } catch (error) {
        this.logger.error?.('FrameRouter routeCommit failed', error);
      }
    }

    this._processing = false;
    this._resolveFlushWaiters();
  }

  async routeCommit(frameEngine, commit, session = null, options = {}) {
    if (!commit?.changes?.length || commit.silent)
      return;

    for (let change of commit.changes) {
      let history = frameEngine.getVersionHistory(change.frameID);
      let { frame, previousFrame } = resolveCommitFrame(history, commit);
      if (!frame)
        continue;

      let registrations = this._matchingRegistrations(frame);
      if (registrations.length === 0)
        continue;

      let context = this.createContext({
        frameEngine,
        commit,
        change,
        frame,
        previousFrame,
        session,
        options,
      });
      await this.executeChain(registrations, context);
    }
  }

  createContext({ frameEngine, commit, change, frame, previousFrame = null, session, options }) {
    return {
      frames: frameEngine,
      engine: frameEngine,
      commit,
      change,
      session,
      previousFrame,
      newFrame: frame,
      changes: computeChanges(previousFrame, frame),
      logger: this.logger,
      services: options.services || null,
    };
  }

  async executeChain(registrations, context) {
    let index = 0;
    let stopped = false;

    let next = async (nextContext = context) => {
      if (stopped)
        return;

      let registration = registrations[index++];
      if (!registration)
        return;

      let plugin = new registration.PluginClass(nextContext);
      let called = false;

      let wrappedNext = async (ctx = nextContext) => {
        called = true;
        await next(ctx);
      };

      let done = () => {
        called = true;
        stopped = true;
      };

      try {
        await plugin.process(wrappedNext, done);
      } catch (error) {
        this.logger.error?.(`FrameRouter plugin "${registration.pluginName || registration.PluginClass.name}" failed`, error);
      }

      if (!called && !stopped)
        await next(nextContext);
    };

    await next(context);
  }

  _matchingRegistrations(frame) {
    let matches = [];

    for (let registration of this._registrations) {
      try {
        if (registration.matcher(frame))
          matches.push(registration);
      } catch (error) {
        this.logger.error?.('FrameRouter selector failed', error);
      }
    }

    return matches;
  }

  _resolveFlushWaiters() {
    let waiters = this._flushWaiters.splice(0);
    for (let resolve of waiters)
      resolve();
  }
}

export class BaseFramePlugin {
  constructor(context = {}) {
    this.context = context;
    this.logger = context.logger || console;
  }

  async process(next) {
    await next(this.context);
  }
}

function resolveCommitFrame(history, commit) {
  let versions = Array.isArray(history) ? history : [];
  let index = versions.findIndex((frame) => frame?.commitOrder === commit.order);
  if (index < 0)
    index = versions.length - 1;

  return {
    frame: index >= 0 ? versions[index] : null,
    previousFrame: index > 0 ? versions[index - 1] : null,
  };
}

function computeChanges(previousFrame, newFrame) {
  if (!previousFrame)
    return [];

  let keys = new Set([
    ...Object.keys(previousFrame),
    ...Object.keys(newFrame),
  ]);

  let changes = [];
  for (let key of keys) {
    if (previousFrame[key] !== newFrame[key]) {
      changes.push({
        propName: key,
        previousValue: previousFrame[key],
        newValue: newFrame[key],
      });
    }
  }

  return changes;
}
