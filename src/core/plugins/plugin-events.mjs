'use strict';

// Scoped event subscriptions for plugins.
//
// FrameRuntime emits a single global 'event' channel. A plugin listening directly on it
// receives traffic for every session in the system, including conversations it was
// never invited to. That is a confidentiality problem before it is a performance one.
//
// Plugins subscribe through here instead. A subscription may name the sessions it is
// interested in; anything else is filtered before the handler runs. A plugin that names
// nothing receives nothing - deny by default, opened explicitly.

export class PluginEventBus {
  // frameRuntime may be null at construction time. Plugins subscribe during their
  // load, which happens BEFORE the runtime is created, so the bus has to exist first
  // and be attached afterwards. Subscriptions registered before the attach are kept
  // and become live when it happens; events are not buffered, so nothing that fired
  // before an attach is delivered afterwards.
  constructor({ frameRuntime = null, logger = console } = {}) {
    this.frameRuntime = null;
    this.logger = logger;
    this.subscriptions = new Map();
    this._listening = false;
    if (frameRuntime) this.attach(frameRuntime);
  }

  attach(frameRuntime) {
    if (!frameRuntime || typeof frameRuntime.on !== 'function')
      throw new TypeError('PluginEventBus.attach requires a frameRuntime with on()');
    this.frameRuntime = frameRuntime;
    this.#listen();
    return this;
  }

  get attached() {
    return this._listening;
  }

  subscribe(pluginId, handler, { sessions = null } = {}) {
    if (typeof pluginId !== 'string' || !pluginId)
      throw new TypeError('subscribe requires a plugin id');
    if (typeof handler !== 'function')
      throw new TypeError('subscribe requires a handler function');

    let allowed = sessions === null ? null : new Set([].concat(sessions).filter(Boolean));

    let list = this.subscriptions.get(pluginId) || [];
    list.push({ handler, allowed });
    this.subscriptions.set(pluginId, list);
    // Recorded whether or not the runtime exists yet; attach() starts delivery. Nothing
    // is delivered before an attach, so a subscription registered early sees no events
    // rather than seeing them late.
    return true;
  }

  unsubscribe(pluginId) {
    this.subscriptions.delete(pluginId);
  }

  list() {
    return [...this.subscriptions.entries()].map(([pluginId, subs]) => ({
      pluginId,
      subscriptions: subs.length,
      scoped: subs.filter((s) => s.allowed !== null).length,
    }));
  }

  #listen() {
    if (this._listening) return;
    this._listening = true;
    this.frameRuntime.on('event', (event) => this.#dispatch(event));
  }

  #dispatch(event) {
    if (!event) return;
    let sessionID = event.sessionID || event.sessionId || event.frame?.sessionID || null;

    for (let [pluginId, subs] of this.subscriptions) {
      for (let { handler, allowed } of subs) {
        // An unscoped subscription receives nothing. Scoping is opt-in per subscription,
        // never granted by omission.
        if (allowed === null) continue;
        if (!sessionID || !allowed.has(sessionID)) continue;

        try {
          let result = handler(event);
          if (result && typeof result.catch === 'function') {
            result.catch((error) => this.logger?.warn?.(
              `[plugin-events] ${pluginId} handler failed: ${error.message}`,
            ));
          }
        } catch (error) {
          this.logger?.warn?.(`[plugin-events] ${pluginId} handler threw: ${error.message}`);
        }
      }
    }
  }
}

export function createPluginEventBus(options) {
  return new PluginEventBus(options);
}
