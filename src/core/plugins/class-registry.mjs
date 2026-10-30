'use strict';

// Universal stack-based class registry.
//
// One registry for every overridable class in the system. Plugins push onto a
// per-key stack; `getClass()` returns the top of the stack. This is how a plugin
// overrides a core class: it re-registers the same key and wins.
//
// The engine opts into overridability by resolving classes through
// `registry.getClass(...)` instead of importing them directly. Hardcoded
// instantiation is deliberately locked down; security-critical code (crypto,
// auth) must NOT be resolved from here.

export class ClassRegistry {
  constructor() {
    this._stacks = new Map();     // key -> [{ classRef, pluginName, loadOrder }]
    this._registrations = [];     // ordered list of every registration
    this._loadCounter = 0;        // monotonic counter for load order
    this._version = 0;            // bumped on any change (hot-reload detection)
    // key -> the class a live instance was actually constructed from. Filled by
    // noteClassResolved() at every construction site that resolves through this
    // registry. A stack top that later differs from this value means the running
    // object is stale, which is reported by listRestartRequired() rather than
    // silently implied to have changed.
    this._resolvedClasses = new Map();
    // Keys that at least one construction site actually resolves. A key outside
    // this set is registered and looks overridable, but nothing in the running
    // system asks the registry for it - every consumer imports the class and
    // extends it instead. See listInertOverrides().
    this._consumedKeys = null;
  }

  // registerClass patterns:
  //   registerClass(MyClass)
  //   registerClass('Key', SomeClass)
  //   registerClass(MyClass, { pluginName })
  //   registerClass('Key', SomeClass, { pluginName })
  registerClass(keyOrClass, classRefOrOptions = null, maybeOptions = null) {
    let key;
    let classRef;
    let options = {};

    if (typeof keyOrClass === 'string') {
      key = keyOrClass;
      if (typeof classRefOrOptions !== 'function')
        throw new TypeError(`registerClass: classRef for key "${key}" must be a function/class`);

      classRef = classRefOrOptions;
      options = maybeOptions || {};
    } else if (typeof keyOrClass === 'function') {
      classRef = keyOrClass;
      key = classRef.name;
      if (!key)
        throw new TypeError('registerClass: class must have a name (anonymous functions are not allowed)');

      options = classRefOrOptions || {};
    } else {
      throw new TypeError('registerClass: first argument must be a string key or a class/function');
    }

    if (typeof classRef !== 'function')
      throw new TypeError(`registerClass: "${key}" must be a function/class`);

    let pluginName = options.pluginName || null;

    // Idempotency: registering the same class at the top of the stack is a no-op.
    let stack = this._stacks.get(key);
    if (stack && stack.length > 0 && stack[stack.length - 1].classRef === classRef)
      return classRef;

    let entry = { key, classRef, pluginName, loadOrder: this._loadCounter++ };
    if (!stack) {
      stack = [];
      this._stacks.set(key, stack);
    }

    stack.push(entry);
    this._registrations.push(entry);
    this._version++;
    return classRef;
  }

  // Top of the stack: the winning (most recent) class for a key.
  getClass(key) {
    let stack = this._stacks.get(key);
    if (!stack || stack.length === 0)
      return null;

    return stack[stack.length - 1].classRef;
  }

  // A specific stack position (0 = base, highest = top).
  getClassAtIndex(key, index) {
    let stack = this._stacks.get(key);
    if (!stack || index < 0 || index >= stack.length)
      return null;

    return stack[index].classRef;
  }

  hasClass(key) {
    let stack = this._stacks.get(key);
    return Boolean(stack && stack.length > 0);
  }

  getRegisteredKeys() {
    let keys = [];
    for (let [ key, stack ] of this._stacks) {
      if (stack.length > 0)
        keys.push(key);
    }

    return keys;
  }

  // Remove every registration made by a plugin (its overrides pop off the
  // stacks), so a disabled/unloaded plugin falls back to the classes below it.
  unregisterPlugin(pluginName) {
    if (!pluginName)
      return;

    this._registrations = this._registrations.filter((entry) => entry.pluginName !== pluginName);

    let changed = false;
    for (let [ key, stack ] of this._stacks) {
      let filtered = stack.filter((entry) => entry.pluginName !== pluginName);
      if (filtered.length === stack.length)
        continue;

      changed = true;
      if (filtered.length === 0)
        this._stacks.delete(key);
      else
        this._stacks.set(key, filtered);
    }

    if (changed)
      this._version++;
  }

  // Record that a live instance was built from `classRef` for `key`. Called from
  // resolveCoreClass() / resolveRegistered() at construction time.
  //
  // This is deliberately separate from the stack: the stack answers "what would be
  // constructed now", this answers "what was constructed". Conflating them is what
  // makes an override look applied when the running service still executes core.
  noteClassResolved(key, classRef) {
    if (!key)
      return;
    this._resolvedClasses.set(key, classRef || null);
  }

  // Forget that a live instance exists for `key` (e.g. the instance was rebuilt from
  // the current stack top).
  clearClassResolved(key) {
    this._resolvedClasses.delete(key);
  }

  classRefForResolved(key) {
    return this._resolvedClasses.has(key) ? this._resolvedClasses.get(key) : undefined;
  }

  // Keys where a live instance exists and the class it was built from is no longer
  // what the stack would produce. Those instances are running stale code and cannot be
  // replaced in place; the platform must say so instead of letting the registry row
  // look like a live behaviour change.
  listRestartRequired() {
    let keys = [];
    for (let [ key, builtFrom ] of this._resolvedClasses) {
      let current = this.getClass(key);
      if (current !== (builtFrom || null))
        keys.push(key);
    }

    return keys.sort();
  }

  // Declare which keys the running system actually asks the registry for: the keys
  // that have a real resolveCoreClass()/resolveRegistered() construction site.
  // Anything registered but not declared here is inert - a plugin can push an
  // override onto it and nothing will ever construct it, so the registry must not
  // present that override as a live behaviour change.
  //
  // null/undefined marks consumption as unknown, which disables inert reporting
  // rather than guessing. An unconfigured registry must never claim a key works.
  setConsumedKeys(keys) {
    if (keys == null) {
      this._consumedKeys = null;
      return this;
    }

    this._consumedKeys = keys instanceof Set ? keys : new Set(Array.isArray(keys) ? keys : [ ...keys ]);
    return this;
  }

  hasConsumedKeys() {
    return this._consumedKeys instanceof Set;
  }

  isKeyConsumed(key) {
    if (!(this._consumedKeys instanceof Set))
      return null;

    return this._consumedKeys.has(key);
  }

  // Keys carrying a non-core override where nothing resolves through the registry.
  // Deliberately distinct from listRestartRequired(): a restart would not help,
  // because there is no construction site to pick the override up at any point.
  // Reporting these as restart-required would promise a fix a restart cannot make.
  listInertOverrides() {
    if (!(this._consumedKeys instanceof Set))
      return [];

    let keys = [];
    for (let [ key, stack ] of this._stacks) {
      if (stack.length === 0 || this._consumedKeys.has(key))
        continue;

      // Only a non-core override is worth reporting: the base registration is
      // core's own, and nobody asked it to do anything.
      if (stack.some((entry) => entry.pluginName && entry.pluginName !== 'core'))
        keys.push(key);
    }

    return keys.sort();
  }

  clear() {
    this._stacks.clear();
    this._registrations = [];
    this._loadCounter = 0;
    this._resolvedClasses.clear();
    this._version++;
  }

  bumpVersion() {
    this._version++;
  }

  get version() {
    return this._version;
  }
}
