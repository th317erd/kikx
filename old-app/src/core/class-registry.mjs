'use strict';

// =============================================================================
// Class Registry — Universal Stack-Based Class Registry
// =============================================================================
// A single registry for ALL classes in the system. Stack-based override:
// plugins push to the stack, getClass() returns the top, unregisterPlugin()
// removes all entries from that plugin and rebuilds affected stacks.
// Version counter for hot reload detection.
// =============================================================================

export class ClassRegistry {
  constructor() {
    this._stacks = new Map();        // key → [{ classRef, pluginName, loadOrder }]
    this._registrations = [];        // ordered list of all registrations
    this._version = 0;               // bumped on any change
    this._loadCounter = 0;           // monotonic counter for load order
  }

  // ---------------------------------------------------------------------------
  // registerClass(keyOrClass, classRefOrOptions?, maybeOptions?)
  // ---------------------------------------------------------------------------
  // Pattern 1: registerClass(MyClass)                      → key = MyClass.name
  // Pattern 2: registerClass('Key', SomeClass)             → key = 'Key'
  // Pattern 3: registerClass(MyClass, { pluginName })      → key = MyClass.name
  // Pattern 4: registerClass('Key', SomeClass, { pluginName })
  // ---------------------------------------------------------------------------

  registerClass(keyOrClass, classRefOrOptions, maybeOptions) {
    if (keyOrClass == null) {
      throw new Error('registerClass: first argument must not be null or undefined');
    }

    let key;
    let classRef;
    let options = {};

    if (typeof keyOrClass === 'string') {
      // Pattern 2 or 4: string key + classRef
      key = keyOrClass;

      if (classRefOrOptions == null || typeof classRefOrOptions !== 'function') {
        throw new Error(`registerClass: classRef for key "${key}" must be a function/class`);
      }

      classRef = classRefOrOptions;
      options = maybeOptions || {};
    } else if (typeof keyOrClass === 'function') {
      // Pattern 1 or 3: class directly
      classRef = keyOrClass;
      key = classRef.name;

      if (!key) {
        throw new Error('registerClass: class must have a name (anonymous functions are not allowed)');
      }

      options = classRefOrOptions || {};
    } else {
      throw new Error('registerClass: first argument must be a string key or a class/function');
    }

    let pluginName = options.pluginName || null;

    // Idempotency: if the same class is already at the top, skip
    let stack = this._stacks.get(key);
    if (stack && stack.length > 0 && stack[stack.length - 1].classRef === classRef) {
      return;
    }

    let loadOrder = this._loadCounter++;
    let entry = { key, classRef, pluginName, loadOrder };

    if (!stack) {
      stack = [];
      this._stacks.set(key, stack);
    }

    stack.push(entry);
    this._registrations.push(entry);
    this._version++;
  }

  // ---------------------------------------------------------------------------
  // getClass(key) — top of the stack
  // ---------------------------------------------------------------------------

  getClass(key) {
    let stack = this._stacks.get(key);
    if (!stack || stack.length === 0) return null;
    return stack[stack.length - 1].classRef;
  }

  // ---------------------------------------------------------------------------
  // getClassAtIndex(key, index) — specific stack position (0 = base)
  // ---------------------------------------------------------------------------

  getClassAtIndex(key, index) {
    let stack = this._stacks.get(key);
    if (!stack || index < 0 || index >= stack.length) return null;
    return stack[index].classRef;
  }

  // ---------------------------------------------------------------------------
  // hasClass(key)
  // ---------------------------------------------------------------------------

  hasClass(key) {
    let stack = this._stacks.get(key);
    return !!(stack && stack.length > 0);
  }

  // ---------------------------------------------------------------------------
  // getRegisteredKeys()
  // ---------------------------------------------------------------------------

  getRegisteredKeys() {
    let keys = [];
    for (let [key, stack] of this._stacks) {
      if (stack.length > 0) keys.push(key);
    }
    return keys;
  }

  // ---------------------------------------------------------------------------
  // unregisterPlugin(pluginName) — remove all from that plugin, rebuild stacks
  // ---------------------------------------------------------------------------

  unregisterPlugin(pluginName) {
    // Remove from global registrations list
    this._registrations = this._registrations.filter(e => e.pluginName !== pluginName);

    // Rebuild affected stacks
    let affectedKeys = new Set();
    for (let [key, stack] of this._stacks) {
      let before = stack.length;
      let filtered = stack.filter(e => e.pluginName !== pluginName);
      if (filtered.length !== before) {
        affectedKeys.add(key);
        if (filtered.length === 0) {
          this._stacks.delete(key);
        } else {
          this._stacks.set(key, filtered);
        }
      }
    }

    this._version++;
  }

  // ---------------------------------------------------------------------------
  // clear() — reset everything
  // ---------------------------------------------------------------------------

  clear() {
    this._stacks.clear();
    this._registrations = [];
    this._loadCounter = 0;
    this._version++;
  }

  // ---------------------------------------------------------------------------
  // bumpVersion()
  // ---------------------------------------------------------------------------

  bumpVersion() {
    this._version++;
  }

  // ---------------------------------------------------------------------------
  // version getter
  // ---------------------------------------------------------------------------

  get version() {
    return this._version;
  }
}
