'use strict';

import { FrameManager }  from '../../shared/frame-manager/frame-manager.mjs';
import { safeParseJSON }  from '../lib/utils.mjs';

// =============================================================================
// Frame Persistence
// =============================================================================

export class FramePersistence {
  /**
   * @param {import('../types').CascadingContext} context
   */
  constructor(context) {
    if (!context)
      throw new Error('FramePersistence requires a CascadingContext');

    /** @type {import('../types').CascadingContext} */
    this._context = context;

    let models = this._context.getProperty('models');
    if (!models)
      throw new Error('FramePersistence requires models on the context');

    /** @type {import('../types').CoreModels} */
    this._models = models;
  }

  // ---------------------------------------------------------------------------
  // saveFrames
  // ---------------------------------------------------------------------------
  /**
   * Persists an array of frame data objects to the database (upsert).
   * @param {string} sessionID
   * @param {import('../types').FrameData[]} frames
   * @returns {Promise<any[]>}
   */
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

      let interactionID = frameData.interactionID || '';
      let record        = this._frameToRecord(sessionID, interactionID, frameData);

      let existing = await Frame.where.id.EQ(frameData.id).first();

      if (existing) {
        let keys = Object.keys(record);

        for (let key of keys) {
          if (key === 'id')
            continue;

          existing[key] = record[key];
        }

        await existing.save();
        results.push(existing);
      } else {
        let frame = await Frame.create(record);
        results.push(frame);
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // loadFrames
  // ---------------------------------------------------------------------------
  /**
   * Loads frames from the DB into a new FrameManager instance.
   * @param {string} sessionID
   * @param {import('../types').LoadFramesOptions} [options]
   * @returns {Promise<FrameManager>}
   */
  async loadFrames(sessionID, options = {}) {
    let frameManager = new FrameManager({ history: true });
    await this.loadFramesInto(frameManager, sessionID, options);
    return frameManager;
  }

  // ---------------------------------------------------------------------------
  // loadFramesInto
  // ---------------------------------------------------------------------------
  /**
   * Loads frames from the DB into an existing FrameManager.
   * @param {FrameManager} frameManager
   * @param {string} sessionID
   * @param {import('../types').LoadFramesOptions} [options]
   * @returns {Promise<import('../types').FrameData[]>}
   */
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

    // Safety: enforce limit client-side
    if (options.limit !== undefined && records.length > options.limit)
      records = records.slice(0, options.limit);

    let frameDataArray = (options.metadataOnly)
      ? records.map((record) => this._recordToFrameMetadataOnly(record))
      : records.map((record) => this._recordToFrame(record));

    frameManager.merge(frameDataArray, { events: false });

    let registry = this._context && this._context.getProperty('pluginRegistry');
    if (registry && typeof registry.version === 'number')
      frameManager.setRegistryVersion(registry.version);

    return frameDataArray;
  }

  // ---------------------------------------------------------------------------
  // loadContent
  // ---------------------------------------------------------------------------
  /**
   * Loads the full content for a single frame by ID.
   * @param {string} frameID
   * @returns {Promise<Record<string, any>|string|null>}
   */
  async loadContent(frameID) {
    if (!frameID)
      return null;

    let { Frame } = this._models;
    let record    = await Frame.where.id.EQ(frameID).first();

    if (!record)
      return null;

    let content = (typeof record.content === 'string')
      ? safeParseJSON(record.content, record.content)
      : record.content;

    return (content != null) ? content : {};
  }

  // ---------------------------------------------------------------------------
  // loadContentBulk
  // ---------------------------------------------------------------------------
  /**
   * Loads the full content for multiple frames by ID.
   * @param {string[]} frameIDs
   * @returns {Promise<Map<string, Record<string, any>>>}
   */
  async loadContentBulk(frameIDs) {
    if (!frameIDs || frameIDs.length === 0)
      return new Map();

    let { Frame } = this._models;
    let records   = await Promise.all(
      frameIDs.map((id) => Frame.where.id.EQ(id).first()),
    );

    let result = new Map();

    for (let record of records) {
      if (!record)
        continue;

      let content = (typeof record.content === 'string')
        ? safeParseJSON(record.content, record.content)
        : record.content;

      result.set(record.id, (content != null) ? content : {});
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // loadFramesInWindow
  // ---------------------------------------------------------------------------
  /**
   * Loads full frames for a specific order range within a session.
   * @param {string} sessionID
   * @param {number} [fromOrder]
   * @param {number} [toOrder]
   * @returns {Promise<FrameManager>}
   */
  async loadFramesInWindow(sessionID, fromOrder, toOrder) {
    if (!sessionID)
      throw new Error('sessionID is required');

    let options = {};

    if (fromOrder !== undefined)
      options.afterOrder = fromOrder;

    if (toOrder !== undefined)
      options.beforeOrder = toOrder;

    return this.loadFrames(sessionID, options);
  }

  // ---------------------------------------------------------------------------
  // hideOrphanedFrames
  // ---------------------------------------------------------------------------
  /**
   * Detects and hides orphaned tool-call frames that have no matching tool-result.
   * @param {string} sessionID
   * @param {FrameManager} [frameManager]
   * @returns {Promise<number>} Number of frames hidden
   */
  async hideOrphanedFrames(sessionID, frameManager) {
    if (!sessionID)
      return 0;

    try {
      let { Frame } = this._models;

      let toolFrames = await Frame
        .where.sessionID.EQ(sessionID)
        .AND.hidden.EQ(false)
        .AND.deleted.EQ(false)
        .all();

      let resolvedToolIds = new Set();
      for (let f of toolFrames) {
        if (f.type !== 'ToolResult')
          continue;

        let content = safeParseJSON(f.content, {});
        if (content.toolUseID)
          resolvedToolIds.add(content.toolUseID);
      }

      let orphans = [];
      for (let f of toolFrames) {
        if (f.type !== 'ToolCall')
          continue;

        let content = safeParseJSON(f.content, {});
        let toolUseID = content.toolUseID || content.toolUseId;

        if (toolUseID && !resolvedToolIds.has(toolUseID))
          orphans.push(f);
      }

      if (orphans.length > 0) {
        let orphanUpdates = orphans.map((o) => {
          let plain = (typeof o.toJSON === 'function') ? o.toJSON() : { ...o };
          return { ...plain, hidden: true };
        });

        if (frameManager) {
          frameManager.merge(orphanUpdates, { silent: true });
          await this.saveFrames(sessionID, orphanUpdates);
        } else {
          await this.saveFrames(sessionID, orphanUpdates);
        }

        console.log(`[FramePersistence] Hidden ${orphans.length} orphaned frame(s) in session ${sessionID}`);
      }

      return orphans.length;
    } catch (error) {
      console.error('[FramePersistence] hideOrphanedFrames failed:', error.message);
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // deleteFrames
  // ---------------------------------------------------------------------------
  /**
   * Deletes frames from the DB for a session.
   * @param {string} sessionID
   * @param {object} [options]
   * @param {string} [options.interactionID]
   * @returns {Promise<number>} Count of deleted frames
   */
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
  /**
   * Returns the next monotonic order counter for a session.
   * @param {string} sessionID
   * @returns {Promise<number>}
   */
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
  /**
   * @param {string} sessionID
   * @returns {Promise<number>}
   */
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
  /**
   * Returns the highest frame order for a session, or 0 if no frames exist.
   * @param {string} sessionID
   * @returns {Promise<number>}
   */
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
  // updateFrameState
  // ---------------------------------------------------------------------------
  /**
   * DEPRECATED: Use FrameManager.merge() + saveFrames() instead.
   * @param {string} frameID
   * @param {Record<string, any>|null} state
   * @returns {Promise<void>}
   */
  async updateFrameState(frameID, state) {
    console.warn('[FramePersistence] DEPRECATED: updateFrameState() called directly. Use FrameManager.merge() + saveFrames() instead.');

    let { Frame } = this._models;

    let frame = await Frame.where.id.EQ(frameID).first();
    if (!frame)
      return;

    frame.state = (state != null) ? JSON.stringify(state) : null;
    await frame.save();
  }

  // ---------------------------------------------------------------------------
  // _frameToRecord
  // ---------------------------------------------------------------------------
  /**
   * Converts a FrameManager-style frame data object to a DB record.
   * @param {string} sessionID
   * @param {string} interactionID
   * @param {import('../types').FrameData} frameData
   * @returns {Record<string, any>}
   */
  _frameToRecord(sessionID, interactionID, frameData) {
    let content = frameData.content;
    let targets = frameData.targets;

    if (content !== undefined && content !== null && typeof content !== 'string')
      content = JSON.stringify(content);

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
      parentID:      (frameData.parentID !== undefined) ? frameData.parentID : null,
      groupID:       (frameData.groupID !== undefined) ? frameData.groupID : null,
      groupType:     (frameData.groupType !== undefined) ? frameData.groupType : null,
      authorType:    (frameData.authorType !== undefined) ? frameData.authorType : null,
      authorID:      (frameData.authorID !== undefined) ? frameData.authorID : null,
      hidden:        (frameData.hidden !== undefined) ? frameData.hidden : true,
      deleted:       (frameData.deleted !== undefined) ? frameData.deleted : false,
      processed:     (frameData.processed !== undefined) ? frameData.processed : false,
      processedAt:   (frameData.processedAt !== undefined) ? frameData.processedAt : null,
      signature:             (frameData.signature !== undefined) ? frameData.signature : null,
      signingKeyFingerprint: (frameData.signingKeyFingerprint !== undefined) ? frameData.signingKeyFingerprint : null,
      state:                 (frameData.state !== undefined && frameData.state !== null)
        ? (typeof frameData.state === 'string' ? frameData.state : JSON.stringify(frameData.state))
        : null,
    };

    return record;
  }

  // ---------------------------------------------------------------------------
  // _recordToFrameBase — shared base for _recordToFrame / _recordToFrameMetadataOnly
  // ---------------------------------------------------------------------------
  /**
   * Converts a DB Frame model instance to a FrameManager-compatible data object,
   * with optional content parsing. Shared base to avoid duplication.
   *
   * @param {any} record - DB Frame model instance
   * @param {{ includeContent: boolean }} options
   * @returns {import('../types').FrameData}
   */
  _recordToFrameBase(record, { includeContent }) {
    let targets = safeParseJSON(record.targets, []);
    let content = null;

    if (includeContent) {
      content = (typeof record.content === 'string')
        ? safeParseJSON(record.content, record.content)
        : record.content;
      content = (content != null) ? content : {};
    }

    return {
      id:            record.id,
      interactionID: record.interactionID || null,
      type:          record.type,
      content,
      targets:       (targets != null) ? targets : [],
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
      signature:             record.signature || null,
      signingKeyFingerprint: record.signingKeyFingerprint || null,
      state:                 record.state || null,
      createdAt:             record.createdAt || null,
    };
  }

  // ---------------------------------------------------------------------------
  // _recordToFrame
  // ---------------------------------------------------------------------------
  /**
   * Converts a DB Frame model instance to a FrameManager-compatible data object.
   * @param {any} record - DB Frame model instance
   * @returns {import('../types').FrameData}
   */
  _recordToFrame(record) {
    return this._recordToFrameBase(record, { includeContent: true });
  }

  // ---------------------------------------------------------------------------
  // _recordToFrameMetadataOnly
  // ---------------------------------------------------------------------------
  /**
   * Like _recordToFrame but skips content parsing — sets content to null.
   * @param {any} record - DB Frame model instance
   * @returns {import('../types').FrameData}
   */
  _recordToFrameMetadataOnly(record) {
    return this._recordToFrameBase(record, { includeContent: false });
  }
}
