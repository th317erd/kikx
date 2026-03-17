'use strict';

import { FrameManager } from '../../shared/frame-manager/frame-manager.mjs';

// =============================================================================
// Frame Persistence
// =============================================================================
// Syncs between the database (Frame model records) and the in-memory
// FrameManager. Handles serialization of content/targets (JSON objects
// in FrameManager, TEXT strings in the DB) and field name mapping
// (parentID ↔ parentID, groupID ↔ groupID).
// =============================================================================

export class FramePersistence {
  constructor(context) {
    if (!context)
      throw new Error('FramePersistence requires a CascadingContext');

    this._context = context;

    let models = this._context.getProperty('models');
    if (!models)
      throw new Error('FramePersistence requires models on the context');

    this._models = models;
  }

  // ---------------------------------------------------------------------------
  // saveFrames
  // ---------------------------------------------------------------------------
  // Persists an array of frame data objects to the database.
  // Uses upsert logic: if a frame with the same ID exists, update it;
  // otherwise create a new record.
  // ---------------------------------------------------------------------------

  async saveFrames(sessionID, frames) {
    if (!sessionID)
      throw new Error('sessionID is required');

    if (!Array.isArray(frames) || frames.length === 0)
      return [];

    let { Frame } = this._models;
    let results   = [];

    for (let frameData of frames) {
      if (!frameData.id)
        continue;

      let interactionID = frameData.interactionID || frameData.id;
      let record        = this._frameToRecord(sessionID, interactionID, frameData);

      // Check if frame already exists
      let existing = await Frame.where.id.EQ(frameData.id).first();

      if (existing) {
        // Update existing record
        let keys = Object.keys(record);
        for (let key of keys) {
          if (key === 'id')
            continue;

          existing[key] = record[key];
        }

        await existing.save();
        results.push(existing);
      } else {
        // Create new record
        let frame = await Frame.create(record);
        results.push(frame);
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // loadFrames
  // ---------------------------------------------------------------------------
  // Loads frames from the DB into a new FrameManager instance.
  // Options:
  //   interactionID — load only frames for this interaction
  //   afterOrder    — load frames with order > afterOrder (reconnection replay)
  //   limit         — max number of frames to load
  // ---------------------------------------------------------------------------

  async loadFrames(sessionID, options = {}) {
    let frameManager = new FrameManager({ history: true });
    await this.loadFramesInto(frameManager, sessionID, options);
    return frameManager;
  }

  // ---------------------------------------------------------------------------
  // loadFramesInto
  // ---------------------------------------------------------------------------
  // Loads frames from the DB into an existing FrameManager.
  // Returns the array of frame data objects merged.
  // ---------------------------------------------------------------------------

  async loadFramesInto(frameManager, sessionID, options = {}) {
    if (!sessionID)
      throw new Error('sessionID is required');

    let { Frame } = this._models;

    let query = Frame.where.sessionID.EQ(sessionID);

    if (options.interactionID)
      query = query.AND.interactionID.EQ(options.interactionID);

    if (options.afterOrder !== undefined)
      query = query.AND.order.GT(options.afterOrder);

    if (options.beforeOrder !== undefined)
      query = query.AND.order.LT(options.beforeOrder);

    if (options.parentID !== undefined)
      query = query.AND.parentID.EQ(options.parentID);

    query = query.ORDER('+Frame:order');

    if (options.limit !== undefined)
      query = query.LIMIT(options.limit);

    let records = await query.all();

    // Safety: enforce limit client-side (some ORM versions ignore LIMIT with .all())
    if (options.limit !== undefined && records.length > options.limit)
      records = records.slice(0, options.limit);

    let frameDataArray = records.map((record) => this._recordToFrame(record));

    frameManager.merge(frameDataArray, { events: false });

    return frameDataArray;
  }

  // ---------------------------------------------------------------------------
  // deleteFrames
  // ---------------------------------------------------------------------------
  // Deletes frames from the DB for a session.
  // If interactionID is given, only delete that interaction's frames.
  // ---------------------------------------------------------------------------

  async deleteFrames(sessionID, options = {}) {
    if (!sessionID)
      throw new Error('sessionID is required');

    let { Frame } = this._models;

    let query = Frame.where.sessionID.EQ(sessionID);

    if (options.interactionID)
      query = query.AND.interactionID.EQ(options.interactionID);

    let frames = await query.all();

    for (let frame of frames)
      await frame.destroy();

    return frames.length;
  }

  // ---------------------------------------------------------------------------
  // getNextOrder
  // ---------------------------------------------------------------------------
  // Returns the next monotonic order counter for a session.
  // Queries MAX(order) for the session, returns MAX + 1 (or 1 if none).
  // ---------------------------------------------------------------------------

  async getNextOrder(sessionID) {
    if (!sessionID)
      throw new Error('sessionID is required');

    let { Frame } = this._models;
    let frames    = await Frame.where.sessionID.EQ(sessionID).ORDER('+Frame:order').all();

    if (frames.length === 0)
      return 1;

    let maxOrder = frames[frames.length - 1].order;
    return maxOrder + 1;
  }

  // ---------------------------------------------------------------------------
  // getFrameCount
  // ---------------------------------------------------------------------------
  // Returns the count of frames in a session.
  // ---------------------------------------------------------------------------

  async getFrameCount(sessionID) {
    if (!sessionID)
      throw new Error('sessionID is required');

    let { Frame } = this._models;
    let frames    = await Frame.where.sessionID.EQ(sessionID).all();
    return frames.length;
  }

  // ---------------------------------------------------------------------------
  // getMaxOrder
  // ---------------------------------------------------------------------------
  // Returns the highest frame order for a session, or 0 if no frames exist.
  // Uses descending ORDER + LIMIT(1) for efficiency.
  // ---------------------------------------------------------------------------

  async getMaxOrder(sessionID) {
    if (!sessionID)
      throw new Error('sessionID is required');

    let { Frame } = this._models;
    let frames    = await Frame.where.sessionID.EQ(sessionID)
      .ORDER('+Frame:order')
      .all();

    if (frames.length === 0)
      return 0;

    return frames[frames.length - 1].order;
  }

  // ---------------------------------------------------------------------------
  // _frameToRecord
  // ---------------------------------------------------------------------------
  // Converts a FrameManager-style frame data object to a DB record.
  // Handles field mapping (parentID → parentID, groupID → groupID)
  // and JSON serialization (content/targets objects → strings).
  // ---------------------------------------------------------------------------

  _frameToRecord(sessionID, interactionID, frameData) {
    let content = frameData.content;
    let targets = frameData.targets;

    // Serialize content to JSON string if it's an object
    if (content !== undefined && content !== null && typeof content !== 'string')
      content = JSON.stringify(content);

    // Serialize targets to JSON string if it's an array/object
    if (targets !== undefined && targets !== null && typeof targets !== 'string')
      targets = JSON.stringify(targets);

    let record = {
      id:            frameData.id,
      sessionID:     sessionID,
      interactionID: interactionID,
      type:          frameData.type,
      order:         frameData.order,
      timestamp:     frameData.timestamp || Date.now(),
      content:       (content !== undefined) ? content : null,
      targets:       (targets !== undefined) ? targets : null,
      parentID:      (frameData.parentID !== undefined) ? frameData.parentID : (frameData.parentID !== undefined ? frameData.parentID : null),
      groupID:       (frameData.groupID !== undefined) ? frameData.groupID : (frameData.groupID !== undefined ? frameData.groupID : null),
      groupType:     (frameData.groupType !== undefined) ? frameData.groupType : null,
      authorType:    (frameData.authorType !== undefined) ? frameData.authorType : null,
      authorID:      (frameData.authorID !== undefined) ? frameData.authorID : null,
      hidden:        (frameData.hidden !== undefined) ? frameData.hidden : true,
      deleted:       (frameData.deleted !== undefined) ? frameData.deleted : false,
      processed:     (frameData.processed !== undefined) ? frameData.processed : false,
      processedAt:   (frameData.processedAt !== undefined) ? frameData.processedAt : null,
      signature:     (frameData.signature !== undefined) ? frameData.signature : null,
    };

    return record;
  }

  // ---------------------------------------------------------------------------
  // _recordToFrame
  // ---------------------------------------------------------------------------
  // Converts a DB Frame model instance to a FrameManager-compatible
  // data object. Handles field mapping (parentID → parentID, groupID → groupID)
  // and JSON deserialization (content/targets strings → objects).
  // ---------------------------------------------------------------------------

  _recordToFrame(record) {
    let content = record.content;
    let targets = record.targets;

    // Deserialize content from JSON string
    if (typeof content === 'string') {
      try {
        content = JSON.parse(content);
      } catch (error) {
        // Leave as string if not valid JSON
      }
    }

    // Deserialize targets from JSON string
    if (typeof targets === 'string') {
      try {
        targets = JSON.parse(targets);
      } catch (error) {
        targets = [];
      }
    }

    return {
      id:            record.id,
      interactionID: record.interactionID || null,
      type:          record.type,
      content:       (content !== undefined && content !== null) ? content : {},
      targets:       (targets !== undefined && targets !== null) ? targets : [],
      parentID:      record.parentID || null,
      groupID:       record.groupID || null,
      groupType:     record.groupType || null,
      order:         record.order,
      timestamp:     record.timestamp,
      hidden:        record.hidden,
      deleted:       record.deleted,
      processed:     record.processed,
      processedAt:   record.processedAt,
      authorType:    record.authorType || null,
      authorID:      record.authorID || null,
      signature:     record.signature || null,
      createdAt:     record.createdAt || null,
    };
  }
}
