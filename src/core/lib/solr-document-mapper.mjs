'use strict';

// =============================================================================
// Solr Document Mapper
// =============================================================================

/**
 * @typedef {object} SolrDocument
 * @property {string} id
 * @property {string} doc_type
 * @property {string} [type]
 * @property {string} [sessionID]
 * @property {string} [interactionID]
 * @property {string} [authorType]
 * @property {string} [authorID]
 * @property {number} [timestamp]
 * @property {boolean} [hidden]
 * @property {boolean} [archived]
 * @property {string} [content]
 * @property {string} [namespace]
 * @property {string} [note]
 */

/**
 * Maps a Frame model instance to an array of Solr documents.
 * Returns [] for null/undefined frames or phantom frames.
 * @param {import('../types').FrameData|null} frame
 * @param {string} sessionID
 * @returns {SolrDocument[]}
 */
export function mapFrameToSolrDocuments(frame, sessionID) {
  if (frame == null)
    return [];

  if (frame.groupType === 'phantom')
    return [];

  let doc = {
    id:            frame.id,
    doc_type:      'frame',
    type:          frame.type,
    sessionID:     sessionID,
    interactionID: frame.interactionID,
    authorType:    frame.authorType,
    authorID:      frame.authorID,
    timestamp:     frame.timestamp,
    hidden:        frame.hidden || false,
    archived:      frame.deleted || false,
  };

  /** @type {Array<{ field: string, value: string }>|undefined} */
  let contentEntries;

  try {
    if (typeof frame.getContentForIndexing === 'function') {
      contentEntries = frame.getContentForIndexing();
    } else {
      contentEntries = _extractContentFallback(frame);
    }
  } catch (_error) {
    // Swallow — content is best-effort
  }

  if (Array.isArray(contentEntries)) {
    for (let entry of contentEntries) {
      if (entry && entry.field)
        doc[entry.field] = entry.value;
    }
  }

  return [doc];
}

/**
 * Fallback content extraction for plain FrameManager frame objects.
 * @param {import('../types').FrameData} frame
 * @returns {Array<{ field: string, value: string }>}
 */
function _extractContentFallback(frame) {
  let content = frame.content;

  if (content == null)
    return [];

  if (typeof content === 'string') {
    try {
      content = JSON.parse(content);
    } catch (_error) {
      return [{ field: 'content', value: content }];
    }
  }

  if (typeof content !== 'object')
    return [{ field: 'content', value: String(content) }];

  let text = content.text || content.html || content.message || content.result || content.reason || content.error;

  if (typeof text === 'string')
    return [{ field: 'content', value: text }];

  if (text != null)
    return [{ field: 'content', value: JSON.stringify(text) }];

  return [{ field: 'content', value: JSON.stringify(content) }];
}

/**
 * Maps a ValueStore model instance to a single Solr document.
 * @param {import('../types').ValueStoreEntry|null} record
 * @returns {SolrDocument}
 */
export function mapValueStoreToSolrDocument(record) {
  if (record == null)
    record = {};

  return {
    id:         record.id,
    doc_type:   'value_store',
    type:       record.type,
    namespace:  record.namespace,
    sessionID:  record.scopeID,
    authorType: record.ownerType,
    authorID:   record.ownerID,
    note:       record.note,
    content:    record.value,
    timestamp:  record.createdAt ? new Date(record.createdAt).getTime() : Date.now(),
    hidden:     false,
    archived:   false,
  };
}
