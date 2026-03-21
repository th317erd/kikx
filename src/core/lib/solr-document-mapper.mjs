'use strict';

// =============================================================================
// Solr Document Mapper
// =============================================================================
// Pure mapping functions that convert Frame and ValueStore model instances
// into Solr document objects matching the schema defined in solr/kikx/conf/schema.xml.
//
// These functions never throw — invalid input yields empty arrays or
// documents with null/undefined fields (Solr will reject malformed docs).
// =============================================================================

// ---------------------------------------------------------------------------
// mapFrameToSolrDocuments(frame, sessionID) → Array<SolrDocument>
// ---------------------------------------------------------------------------
// Maps a Frame model instance to an array of Solr documents.
// Returns [] for null/undefined frames or phantom frames.
// ---------------------------------------------------------------------------

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

  // Extract content fields from the frame
  // The frame may be an ORM model (has getContentForIndexing) or a plain
  // FrameManager object (has content as parsed object). Handle both.
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

// ---------------------------------------------------------------------------
// _extractContentFallback(frame) → Array<{ field, value }>
// ---------------------------------------------------------------------------
// Fallback content extraction for plain FrameManager frame objects that
// don't have the ORM model's getContentForIndexing() method.
// ---------------------------------------------------------------------------

function _extractContentFallback(frame) {
  let content = frame.content;

  if (content == null)
    return [];

  // If content is a string, try to parse it as JSON
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content);
    } catch (_error) {
      return [{ field: 'content', value: content }];
    }
  }

  if (typeof content !== 'object')
    return [{ field: 'content', value: String(content) }];

  // Extract text and/or html
  let text = content.text || content.html || content.message || content.result || content.reason || content.error;

  if (typeof text === 'string')
    return [{ field: 'content', value: text }];

  if (text != null)
    return [{ field: 'content', value: JSON.stringify(text) }];

  // Last resort: stringify the whole content
  return [{ field: 'content', value: JSON.stringify(content) }];
}

// ---------------------------------------------------------------------------
// mapValueStoreToSolrDocument(record) → SolrDocument
// ---------------------------------------------------------------------------
// Maps a ValueStore model instance to a single Solr document.
// Field name translations:
//   scopeID   → sessionID
//   ownerType → authorType
//   ownerID   → authorID
//   value     → content
// ---------------------------------------------------------------------------

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
