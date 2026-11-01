'use strict';

import * as coordinatorLoop from './library/coordinator-loop.mjs';
import * as engineer from './library/engineer.mjs';
import * as qa from './library/qa.mjs';
import * as design from './library/design.mjs';

const REGISTRY = new Map([
  [ coordinatorLoop.id, coordinatorLoop ],
  [ engineer.id, engineer ],
  [ qa.id, qa ],
  [ design.id, design ],
]);

export function getBehaviorScript(id) {
  let entry = typeof id === 'string' ? REGISTRY.get(id.trim()) : undefined;
  if (!entry)
    return null;

  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    script: entry.script,
  };
}

export function listBehaviorScripts() {
  return [ ...REGISTRY.values() ].map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
  }));
}

export function isBehaviorScriptID(id) {
  return typeof id === 'string' && REGISTRY.has(id.trim());
}
