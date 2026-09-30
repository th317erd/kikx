'use strict';

export function installRuntimeMethods(prototype, methods) {
  for (let [name, method] of Object.entries(methods)) {
    Object.defineProperty(prototype, name, {
      value: method,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}
