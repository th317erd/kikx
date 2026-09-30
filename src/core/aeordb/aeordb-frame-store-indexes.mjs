'use strict';

import { encodeSegment } from './aeordb-frame-store-paths.mjs';

export function buildGlobalIndexConfigs(rootPath) {
  return [
    {
      path: `${rootPath}/sessions/.aeordb-config/indexes.json`,
      body: {
        glob: '*/session.json',
        indexes: [
          { name: 'id', type: 'string' },
          { name: 'organizationID', type: 'string' },
          { name: 'title', type: [ 'string', 'trigram' ] },
          { name: 'coordinatorAgentID', type: 'string' },
          { name: 'createdByAgentID', type: 'string' },
          { name: 'parentSessionID', type: 'string' },
          { name: 'generation', type: 'u64' },
          { name: 'createdAt', type: 'timestamp' },
          { name: 'updatedAt', type: 'timestamp' },
          { name: 'createdClock', type: 'string' },
          { name: 'updatedClock', type: 'string' },
        ],
      },
    },
  ];
}

export function buildSessionIndexConfigs(rootPath, sessionID) {
  let sessionRoot = `${rootPath}/sessions/${encodeSegment(sessionID)}`;

  return [
    {
      path: `${sessionRoot}/interactions/.aeordb-config/indexes.json`,
      body: {
        glob: '**/frames/*.json',
        indexes: [
          { name: 'id', type: 'string' },
          { name: 'type', type: 'string' },
          { name: 'sessionID', type: 'string' },
          { name: 'interactionID', type: 'string' },
          { name: 'parentID', type: 'string' },
          { name: 'order', type: 'u64' },
          { name: 'timestamp', type: 'timestamp' },
          { name: 'createdAt', type: 'timestamp' },
          { name: 'updatedAt', type: 'timestamp' },
          { name: 'createdClock', type: 'string' },
          { name: 'updatedClock', type: 'string' },
          { name: 'authorType', type: 'string' },
          { name: 'authorID', type: 'string' },
          { name: 'hidden', type: 'string', source: [ 'hiddenIndex' ] },
          { name: 'deleted', type: 'string', source: [ 'deletedIndex' ] },
          { name: 'scheduledAt', type: 'timestamp' },
          { name: 'scheduledStatus', type: 'string' },
          { name: 'contentText', type: 'trigram' },
          { name: 'toolName', type: [ 'string', 'trigram' ], source: [ 'content', 'toolName' ] },
          { name: 'stateStatus', type: 'string', source: [ 'state', 'status' ] },
          { name: 'compactionKind', type: 'string', source: [ 'content', 'kind' ] },
          { name: 'compactionStatus', type: 'string', source: [ 'content', 'status' ] },
          { name: 'compactionBoundaryOrder', type: 'u64', source: [ 'content', 'boundaryOrder' ] },
        ],
      },
    },
    {
      path: `${sessionRoot}/values/.aeordb-config/indexes.json`,
      body: {
        glob: '**/*.json',
        indexes: [
          { name: 'namespace', type: 'string' },
          { name: 'ownerType', type: 'string' },
          { name: 'ownerID', type: 'string' },
          { name: 'scopeID', type: 'string' },
          { name: 'key', type: [ 'string', 'trigram' ] },
          { name: 'valueText', type: 'trigram' },
          { name: 'updatedAt', type: 'timestamp' },
        ],
      },
    },
    {
      path: `${sessionRoot}/tool-log/.aeordb-config/indexes.json`,
      body: {
        glob: '*.json',
        indexes: [
          { name: 'id', type: 'string' },
          { name: 'toolName', type: [ 'string', 'trigram' ] },
          { name: 'agentID', type: 'string' },
          { name: 'timestamp', type: 'timestamp' },
          { name: 'note', type: 'trigram' },
          { name: 'outputText', type: 'trigram' },
        ],
      },
    },
  ];
}
