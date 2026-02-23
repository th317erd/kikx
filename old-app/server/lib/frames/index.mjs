'use strict';

import { randomUUID } from 'crypto';
import { getDatabase } from '../../database.mjs';

/**
 * Frame types for the interaction frames system.
 */
export const FrameType = {
  MESSAGE: 'message',   // User/agent/system message
  REQUEST: 'request',   // Interaction request (websearch, prompt, etc.)
  RESULT: 'result',     // Interaction result
  UPDATE: 'update',     // Replace content of target frame
  COMPACT: 'compact',   // Checkpoint snapshot
};

/**
 * Author types for frames.
 */
export const AuthorType = {
  USER: 'user',
  AGENT: 'agent',
  SYSTEM: 'system',
};

// Track the last timestamp to ensure monotonic ordering
let lastTimestamp = '';
let sequenceCounter = 0;

/**
 * Generate a high-resolution timestamp for frame ordering.
 * Uses ISO format with sub-millisecond precision and monotonic counter.
 * Guaranteed to be unique and strictly ascending.
 *
 * @returns {string} High-resolution UTC timestamp
 */
export function generateTimestamp() {
  const now = Date.now();
  const date = new Date(now);
  const iso = date.toISOString();
  // Base timestamp with millisecond precision: 2026-02-07T12:34:56.789
  const base = iso.slice(0, -1);

  // Increment sequence counter for uniqueness within same millisecond
  sequenceCounter++;
  if (sequenceCounter > 999999) {
    sequenceCounter = 0;
  }

  // Format: 2026-02-07T12:34:56.789123456Z (ms + 6-digit counter)
  const timestamp = base + String(sequenceCounter).padStart(6, '0') + 'Z';

  // Ensure strict monotonic ordering
  if (timestamp <= lastTimestamp) {
    // Extract the counter from lastTimestamp and increment
    const lastCounter = parseInt(lastTimestamp.slice(-7, -1), 10);
    const newCounter = lastCounter + 1;
    const newBase = lastTimestamp.slice(0, -7);
    const newTimestamp = newBase + String(newCounter).padStart(6, '0') + 'Z';
    lastTimestamp = newTimestamp;
    return newTimestamp;
  }

  lastTimestamp = timestamp;
  return timestamp;
}

/**
 * Create a new frame.
 *
 * @param {Object} frame - Frame data
 * @param {number} frame.sessionId - Session this frame belongs to
 * @param {string} [frame.parentId] - Parent frame ID (for sub-frames)
 * @param {string[]} [frame.targetIds] - Array of target IDs
 * @param {string} frame.type - Frame type (message, request, result, update, compact)
 * @param {string} frame.authorType - Author type (user, agent, system)
 * @param {number} [frame.authorId] - Author ID (user or agent ID)
 * @param {Object} frame.payload - Frame payload content
 * @param {string} [frame.id] - Optional custom ID (UUID generated if not provided)
 * @param {string} [frame.timestamp] - Optional timestamp (generated if not provided)
 * @param {Database} [db] - Optional database instance for testing
 * @returns {Object} The created frame with id and timestamp
 */
export function createFrame(frame, db = null) {
  db = db || getDatabase();

  const id = frame.id || randomUUID();
  const timestamp = frame.timestamp || generateTimestamp();
  const targetIds = (frame.targetIds)
    ? JSON.stringify(frame.targetIds)
    : null;
  const payload = (typeof frame.payload === 'string')
    ? frame.payload
    : JSON.stringify(frame.payload);

  const stmt = db.prepare(`
    INSERT INTO frames (id, session_id, parent_id, target_ids, timestamp, type, author_type, author_id, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    frame.sessionId,
    frame.parentId || null,
    targetIds,
    timestamp,
    frame.type,
    frame.authorType,
    frame.authorId || null,
    payload
  );

  return {
    id,
    sessionId: frame.sessionId,
    parentId: frame.parentId || null,
    targetIds: frame.targetIds || null,
    timestamp,
    type: frame.type,
    authorType: frame.authorType,
    authorId: frame.authorId || null,
    payload: (() => {
      if (typeof frame.payload !== 'string')
        return frame.payload;

      try {
        return JSON.parse(frame.payload);
      } catch (error) {
        console.error(`Failed to parse frame payload for frame in session ${frame.sessionId}:`, error.message);
        return { error: 'Failed to parse payload' };
      }
    })(),
  };
}

/**
 * Get a single frame by ID.
 *
 * @param {string} id - Frame ID
 * @param {Database} [db] - Optional database instance for testing
 * @returns {Object|null} The frame or null if not found
 */
export function getFrame(id, db = null) {
  db = db || getDatabase();

  const row = db.prepare('SELECT * FROM frames WHERE id = ?').get(id);

  if (!row)
    return null;

  return parseFrameRow(row);
}

/**
 * Get frames for a session.
 *
 * @param {number} sessionId - Session ID
 * @param {Object} [options] - Query options
 * @param {string} [options.fromTimestamp] - Get frames after this timestamp (exclusive)
 * @param {string} [options.beforeTimestamp] - Get frames before this timestamp (exclusive, for backward pagination)
 * @param {string} [options.fromCompact] - Start from the most recent compact frame
 * @param {string[]} [options.types] - Filter by frame types
 * @param {number} [options.limit] - Maximum number of frames to return
 * @param {Database} [db] - Optional database instance for testing
 * @returns {Object[]} Array of frames sorted by timestamp ASC
 */
export function getFrames(sessionId, options = {}, db = null) {
  db = db || getDatabase();

  let sql = 'SELECT * FROM frames WHERE session_id = ?';
  const params = [sessionId];

  // Start from most recent compact frame if requested
  if (options.fromCompact) {
    const compactFrame = db.prepare(`
      SELECT timestamp FROM frames
      WHERE session_id = ? AND type = 'compact'
      ORDER BY timestamp DESC
      LIMIT 1
    `).get(sessionId);

    if (compactFrame) {
      sql += ' AND timestamp >= ?';
      params.push(compactFrame.timestamp);
    }
  } else if (options.fromTimestamp) {
    sql += ' AND timestamp > ?';
    params.push(options.fromTimestamp);
  }

  // Backward pagination: get frames before a timestamp
  if (options.beforeTimestamp) {
    sql += ' AND timestamp < ?';
    params.push(options.beforeTimestamp);
  }

  // Filter by types
  if (options.types && options.types.length > 0) {
    const placeholders = options.types.map(() => '?').join(', ');
    sql += ` AND type IN (${placeholders})`;
    params.push(...options.types);
  }

  // For backward pagination, order DESC first then reverse for correct ASC output
  if (options.beforeTimestamp && options.limit) {
    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(options.limit);
    const rows = db.prepare(sql).all(...params);
    // Reverse to get chronological order
    return rows.reverse().map(parseFrameRow);
  }

  sql += ' ORDER BY timestamp ASC';

  if (options.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const rows = db.prepare(sql).all(...params);

  return rows.map(parseFrameRow);
}

/**
 * Get all frames for a session (convenience wrapper).
 *
 * @param {number} sessionId - Session ID
 * @param {Database} [db] - Optional database instance for testing
 * @returns {Object[]} Array of frames sorted by timestamp
 */
export function getFramesBySession(sessionId, db = null) {
  return getFrames(sessionId, {}, db);
}

/**
 * Get frames that are children of a parent frame.
 *
 * @param {string} parentId - Parent frame ID
 * @param {Database} [db] - Optional database instance for testing
 * @returns {Object[]} Array of child frames sorted by timestamp
 */
export function getChildFrames(parentId, db = null) {
  db = db || getDatabase();

  const rows = db.prepare(`
    SELECT * FROM frames WHERE parent_id = ? ORDER BY timestamp ASC
  `).all(parentId);

  return rows.map(parseFrameRow);
}

/**
 * Get frames that target a specific ID.
 *
 * @param {string} targetId - Target ID to search for
 * @param {number} [sessionId] - Optional session ID to scope the search
 * @param {Database} [db] - Optional database instance for testing
 * @returns {Object[]} Array of frames targeting this ID
 */
export function getFramesByTarget(targetId, sessionId = null, db = null) {
  db = db || getDatabase();

  let sql = `SELECT * FROM frames WHERE target_ids LIKE ?`;
  const params = [`%"${targetId}"%`];

  if (sessionId) {
    sql += ' AND session_id = ?';
    params.push(sessionId);
  }

  sql += ' ORDER BY timestamp ASC';

  const rows = db.prepare(sql).all(...params);

  return rows.map(parseFrameRow);
}

/**
 * Get the most recent compact frame for a session.
 *
 * @param {number} sessionId - Session ID
 * @param {Database} [db] - Optional database instance for testing
 * @returns {Object|null} The most recent compact frame or null
 */
export function getLatestCompact(sessionId, db = null) {
  db = db || getDatabase();

  const row = db.prepare(`
    SELECT * FROM frames
    WHERE session_id = ? AND type = 'compact'
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(sessionId);

  if (!row)
    return null;

  return parseFrameRow(row);
}

/**
 * Count frames in a session.
 *
 * @param {number} sessionId - Session ID
 * @param {Object} [options] - Count options
 * @param {string} [options.fromTimestamp] - Count frames after this timestamp
 * @param {string[]} [options.types] - Filter by frame types
 * @param {Database} [db] - Optional database instance for testing
 * @returns {number} Frame count
 */
export function countFrames(sessionId, options = {}, db = null) {
  db = db || getDatabase();

  let sql = 'SELECT COUNT(*) as count FROM frames WHERE session_id = ?';
  const params = [sessionId];

  if (options.fromTimestamp) {
    sql += ' AND timestamp > ?';
    params.push(options.fromTimestamp);
  }

  if (options.types && options.types.length > 0) {
    const placeholders = options.types.map(() => '?').join(', ');
    sql += ` AND type IN (${placeholders})`;
    params.push(...options.types);
  }

  const result = db.prepare(sql).get(...params);
  return result.count;
}

/**
 * Compile frames into current state by replaying them in timestamp order.
 * This is the core of the event-sourcing system.
 *
 * Properties:
 * - Idempotent: Same input always produces same output
 * - Order-dependent: Frames processed in timestamp order
 * - Graceful: Missing targets are skipped
 * - Compact-aware: Loads snapshot from compact frames
 *
 * @param {Object[]} frames - Array of frames sorted by timestamp
 * @returns {Map<string, Object>} Map of frame ID to compiled payload
 */
export function compileFrames(frames) {
  const compiled = new Map();

  for (const frame of frames) {
    switch (frame.type) {
      case FrameType.COMPACT:
        // Load snapshot from compact frame
        if (frame.payload && frame.payload.snapshot) {
          for (const [id, content] of Object.entries(frame.payload.snapshot)) {
            compiled.set(id, content);
          }
        }
        break;

      case FrameType.UPDATE:
        // Replace content of target frame(s)
        if (frame.targetIds) {
          for (const targetId of frame.targetIds) {
            // Parse target ID - format is "prefix:id"
            if (targetId.startsWith('frame:')) {
              const frameId = targetId.slice(6);
              // Only apply update if target exists (graceful handling)
              if (compiled.has(frameId)) {
                compiled.set(frameId, frame.payload);
              }
            }
          }
        }
        break;

      case FrameType.MESSAGE:
      case FrameType.REQUEST:
      case FrameType.RESULT:
      default:
        // Store frame payload by ID
        compiled.set(frame.id, frame.payload);
        break;
    }
  }

  return compiled;
}

/**
 * Parse a raw database row into a frame object.
 *
 * @param {Object} row - Database row
 * @returns {Object} Parsed frame
 */
function parseFrameRow(row) {
  let targetIds = null;
  if (row.target_ids) {
    try {
      targetIds = JSON.parse(row.target_ids);
    } catch (error) {
      console.error(`Failed to parse target_ids for frame ${row.id}:`, error.message);
    }
  }

  let payload = {};
  try {
    payload = JSON.parse(row.payload);
  } catch (error) {
    console.error(`Failed to parse payload for frame ${row.id}:`, error.message);
    payload = { error: 'Failed to parse payload' };
  }

  return {
    id:         row.id,
    sessionId:  row.session_id,
    parentId:   row.parent_id,
    targetIds,
    timestamp:  row.timestamp,
    type:       row.type,
    authorType: row.author_type,
    authorId:   row.author_id,
    payload,
  };
}

/**
 * Search frames by content text across one or all sessions for a user.
 *
 * @param {number} userId - User ID (for ownership verification)
 * @param {string} query - Search text
 * @param {Object} [options] - Search options
 * @param {number} [options.sessionId] - Limit to a specific session
 * @param {string[]} [options.types] - Filter by frame types (default: ['message'])
 * @param {number} [options.limit] - Maximum results (default: 50, max: 200)
 * @param {number} [options.offset] - Offset for pagination (default: 0)
 * @param {Database} [db] - Optional database instance for testing
 * @returns {Object[]} Array of matching frames with session metadata
 */
export function searchFrames(userId, query, options = {}, db = null) {
  db = db || getDatabase();

  if (!query || query.trim().length === 0)
    return [];

  let types  = options.types || ['message'];
  let limit  = Math.min(options.limit || 50, 200);
  let offset = options.offset || 0;

  let sql = `
    SELECT f.*, s.name as session_name
    FROM frames f
    JOIN sessions s ON f.session_id = s.id
    WHERE s.user_id = ?
      AND f.payload LIKE ?
  `;
  let params = [userId, `%${query}%`];

  if (options.sessionId) {
    sql += ' AND f.session_id = ?';
    params.push(options.sessionId);
  }

  if (types.length > 0) {
    let placeholders = types.map(() => '?').join(', ');
    sql += ` AND f.type IN (${placeholders})`;
    for (let type of types)
      params.push(type);
  }

  sql += ' ORDER BY f.timestamp DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  let rows = db.prepare(sql).all(...params);

  return rows.map((row) => {
    let frame = parseFrameRow(row);
    frame.sessionName = row.session_name;
    return frame;
  });
}

/**
 * Count search results for a query.
 *
 * @param {number} userId - User ID
 * @param {string} query - Search text
 * @param {Object} [options] - Search options
 * @param {number} [options.sessionId] - Limit to a specific session
 * @param {string[]} [options.types] - Filter by frame types
 * @param {Database} [db] - Optional database instance for testing
 * @returns {number} Total matching frames
 */
export function countSearchResults(userId, query, options = {}, db = null) {
  db = db || getDatabase();

  if (!query || query.trim().length === 0)
    return 0;

  let types = options.types || ['message'];

  let sql = `
    SELECT COUNT(*) as count
    FROM frames f
    JOIN sessions s ON f.session_id = s.id
    WHERE s.user_id = ?
      AND f.payload LIKE ?
  `;
  let params = [userId, `%${query}%`];

  if (options.sessionId) {
    sql += ' AND f.session_id = ?';
    params.push(options.sessionId);
  }

  if (types.length > 0) {
    let placeholders = types.map(() => '?').join(', ');
    sql += ` AND f.type IN (${placeholders})`;
    for (let type of types)
      params.push(type);
  }

  let result = db.prepare(sql).get(...params);
  return result.count;
}

export default {
  FrameType,
  AuthorType,
  generateTimestamp,
  createFrame,
  getFrame,
  getFrames,
  getFramesBySession,
  getChildFrames,
  getFramesByTarget,
  getLatestCompact,
  countFrames,
  compileFrames,
  searchFrames,
  countSearchResults,
};
