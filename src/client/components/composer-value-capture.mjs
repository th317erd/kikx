'use strict';

// A textarea's `value` property can be changed by a render, a reset, or a
// component cleanup without emitting `input`. This wrapper emits a custom
// `valuechange` before the assignment, and again for native input events, so a
// consumer always gets the last user value before it can be wiped.

export const COMPOSER_VALUE_CHANGE_EVENT = 'valuechange';

function findValueDescriptor(node) {
  for (let current = node; current; current = Object.getPrototypeOf(current)) {
    let descriptor = Object.getOwnPropertyDescriptor(current, 'value');
    if (descriptor)
      return descriptor;
  }
  return null;
}

function dispatchValueChange(node, detail) {
  let event;
  if (typeof CustomEvent === 'function') {
    event = new CustomEvent(COMPOSER_VALUE_CHANGE_EVENT, { detail });
  } else {
    event = { type: COMPOSER_VALUE_CHANGE_EVENT, detail };
  }
  node.dispatchEvent?.(event);
  return event;
}

/**
 * Install idempotently on a textarea.
 *
 * The returned function restores the original `value` descriptor and removes
 * the native input bridge. Call it when the composer node is discarded; the
 * shell installs a fresh wrapper after each render.
 */
export function installComposerValueCapture(textarea) {
  if (!textarea || textarea.__kikxComposerValueCapture)
    return textarea?.__kikxComposerValueCapture?.uninstall || (() => {});

  let descriptor = findValueDescriptor(textarea);
  let current = descriptor?.get
    ? descriptor.get.call(textarea)
    : String(textarea.value ?? '');
  let getValue = descriptor?.get
    ? () => descriptor.get.call(textarea)
    : () => current;
  let setValue = descriptor?.set
    ? (value) => descriptor.set.call(textarea, value)
    : (value) => { current = String(value); };
  let lastValue = String(getValue() ?? '');
  let installed = true;

  let onInput = () => {
    if (!installed)
      return;
    let value = String(getValue() ?? '');
    let previous = lastValue;
    lastValue = value;
    dispatchValueChange(textarea, { previous, value, source: 'input' });
  };

  try {
    Object.defineProperty(textarea, 'value', {
      configurable: true,
      enumerable: true,
      get() {
        return getValue();
      },
      set(value) {
        if (!installed) {
          setValue(value);
          return;
        }
        let previous = String(getValue() ?? '');
        let next = value == null ? '' : String(value);
        // Dispatch BEFORE assignment. A listener can preserve `previous`
        // without racing the mutation that is about to erase it.
        dispatchValueChange(textarea, { previous, value: next, source: 'property' });
        setValue(next);
        lastValue = String(getValue() ?? '');
      },
    });
  } catch (_error) {
    // Some exotic DOM doubles expose a non-configurable value property. Native
    // input remains covered; the shell snapshot is the fallback for those.
    return () => {};
  }

  textarea.addEventListener?.('input', onInput);
  let handle = {
    uninstall() {
      if (!installed)
        return;
      installed = false;
      textarea.removeEventListener?.('input', onInput);
      try {
        if (descriptor)
          Object.defineProperty(textarea, 'value', descriptor);
        else
          delete textarea.value;
      } catch (_error) {}
      delete textarea.__kikxComposerValueCapture;
    },
  };
  textarea.__kikxComposerValueCapture = handle;
  return handle.uninstall;
}
