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
  let contentEntries;

  try {
    if (typeof frame.getContentForIndexing === 'function')
      contentEntries = frame.getContentForIndexing();
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
