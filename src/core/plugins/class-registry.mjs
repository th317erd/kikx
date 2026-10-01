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

  clear() {
    this._stacks.clear();
    this._registrations = [];
    this._loadCounter = 0;
    this._version++;
  }

  bumpVersion() {
    this._version++;
  }

  get version() {
    return this._version;
  }
}
