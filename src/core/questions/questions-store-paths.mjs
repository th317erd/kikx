'use strict';

// Path helpers and agent-index discovery. Kept separate from the store state
// machine so the store module stays under the source cap.

import { normalizeRequiredString } from './question-doc.mjs';

export async function listAgentIndexAgentIDs(store) {
    let { items } = await store.aeordb.list(`${store.rootPath}/agents`, { recursive: true, glob: 'questions.json' });
    let agentIDs = [];

    for (let item of items) {
      let match = /\/([^/]+)\/questions\.json$/.exec(item.path);
      if (match)
        agentIDs.push(decodeURIComponent(match[1]));
    }

    return agentIDs;
  }

export function questionPathFor(rootPath, questionID) {
  return `${rootPath}/questions/${encodeURIComponent(normalizeRequiredString(questionID, 'questionID'))}.json`;
}

export function indexPathFor(rootPath) {
  return `${rootPath}/questions/index/open.json`;
}

export function agentIndexPathFor(rootPath, agentID) {
  return `${rootPath}/agents/${encodeURIComponent(normalizeRequiredString(agentID, 'agentID'))}/questions.json`;
}
