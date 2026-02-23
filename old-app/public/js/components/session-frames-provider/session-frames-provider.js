'use strict';

/**
 * Session Frames Provider
 *
 * A scoped provider component that owns frame state for a specific session.
 * Children can access frames via Mythix UI's scope resolution (DOM traversal).
 *
 * This is the SINGLE SOURCE OF TRUTH for frame state. Children should:
 *   - Read `frames` DynamicProperty for raw frames
 *   - Read `compiled` DynamicProperty for compiled state (Map)
 *   - Call `getCompiledPayload(frameId)` for individual lookups
 *
 * Frame compilation follows event-sourcing pattern:
 *   - COMPACT frames load snapshot
 *   - UPDATE frames replace target content
 *   - Other frames store payload by ID
 *
 * Listens for WebSocket events:
 *   - ws:new_frame - Add new frame
 *   - ws:frame_update - Update existing frame payload
 */

import {
  HeroComponent,
  GlobalState,
  DynamicProperty,
} from '../hero-base.js';

// Frame types (matches server/lib/frames/index.mjs)
// TODO: Move to shared/frames.mjs for server/client code sharing
const FrameType = {
  MESSAGE: 'message',
  REQUEST: 'request',
  RESULT: 'result',
  UPDATE: 'update',
  COMPACT: 'compact',
};

/**
 * Compile frames into current state by replaying them in timestamp order.
 * This is the core of the event-sourcing system.
 *
 * Ported from server/lib/frames/index.mjs:compileFrames()
 * TODO: Move to shared/frames.mjs for server/client code sharing
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
function compileFrames(frames) {
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

export class SessionFramesProvider extends HeroComponent {
  static tagName = 'session-frames-provider';

  // No shadow DOM - this is a structural/provider component
  // Children remain in light DOM and can use scope resolution

  // State
  #sessionId = null;
  #lastTimestamp = null;
  #firstTimestamp = null;
  #hasOlderFrames = false;
  #loadingOlder = false;
  #unsubscribers = [];

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor() {
    super();

    // Define frames as a DynamicProperty so Mythix UI templates react to changes
    this.defineDynamicProp('frames', []);

    // Define compiled as a DynamicProperty (Map of frameId -> payload)
    // This is the COMPILED state after applying all UPDATE frames
    this.defineDynamicProp('compiled', new Map());
  }

  // ---------------------------------------------------------------------------
  // Accessors (exposed to children via scope resolution)
  // ---------------------------------------------------------------------------

  /**
   * Get current session ID.
   * @returns {string|null}
   */
  get sessionId() {
    return this.#sessionId;
  }

  /**
   * Get compiled payload for a frame (from compiled Map).
   * @param {string} frameId
   * @returns {object|null}
   */
  getCompiledPayload(frameId) {
    const compiledMap = this.compiled.valueOf();
    return compiledMap.get(frameId) || null;
  }

  /**
   * Check if a frame has been compiled.
   * @param {string} frameId
   * @returns {boolean}
   */
  hasCompiledPayload(frameId) {
    const compiledMap = this.compiled.valueOf();
    return compiledMap.has(frameId);
  }

  /**
   * Get visible frames (excludes update/compact, applies show/hide logic).
   * @param {boolean} showHidden - Whether to include hidden frames
   * @returns {Array}
   */
  getVisibleFrames(showHidden = false) {
    const frames = this.frames.valueOf();
    const compiledMap = this.compiled.valueOf();

    // Filter out non-displayable frame types (update only — compact is visible as divider)
    const displayable = frames.filter((f) => f.type !== 'update');

    if (showHidden) {
      return displayable;
    }

    // Filter out hidden frames (but always show compact frames as dividers)
    return displayable.filter((f) => {
      if (f.type === 'compact') return true;
      const payload = compiledMap.get(f.id) || f.payload || {};
      return !payload.hidden;
    });
  }

  /**
   * Get the last known timestamp.
   * @returns {string|null}
   */
  getLastTimestamp() {
    return this.#lastTimestamp;
  }

  /**
   * Get the first known timestamp (oldest loaded frame).
   * @returns {string|null}
   */
  getFirstTimestamp() {
    return this.#firstTimestamp;
  }

  /**
   * Whether there are older frames available to load.
   * @returns {boolean}
   */
  get hasOlderFrames() {
    return this.#hasOlderFrames;
  }

  /**
   * Whether currently loading older frames.
   * @returns {boolean}
   */
  get loadingOlder() {
    return this.#loadingOlder;
  }

  /**
   * Recompile all frames and update the compiled DynamicProperty.
   * Called after any frame change to ensure consistent state.
   */
  _recompile() {
    const frames = this.frames.valueOf();
    const newCompiled = compileFrames(frames);
    this.compiled = newCompiled;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Component mounted.
   */
  mounted() {
    // Listen for WebSocket frame events
    this._onNewFrame = (event) => this._handleNewFrame(event);
    this._onFrameUpdate = (event) => this._handleFrameUpdate(event);
    document.addEventListener('ws:new_frame', this._onNewFrame);
    document.addEventListener('ws:frame_update', this._onFrameUpdate);

    // Subscribe to GlobalState.currentSession (follows hero-chat pattern)
    this.#unsubscribers.push(
      this.subscribeGlobal('currentSession', ({ value }) => {
        if (value && value.id) {
          this._loadSession(String(value.id));
        } else {
          this._clearSession();
        }
      })
    );

    // Check for existing session
    let existingSession = GlobalState.currentSession.valueOf();
    if (existingSession && existingSession.id) {
      this._loadSession(String(existingSession.id));
    }
  }

  /**
   * Component unmounted.
   */
  unmounted() {
    for (let unsub of this.#unsubscribers) {
      unsub();
    }
    this.#unsubscribers = [];

    if (this._onNewFrame) {
      document.removeEventListener('ws:new_frame', this._onNewFrame);
    }
    if (this._onFrameUpdate) {
      document.removeEventListener('ws:frame_update', this._onFrameUpdate);
    }
  }

  // ---------------------------------------------------------------------------
  // Session Management
  // ---------------------------------------------------------------------------

  /**
   * Load frames for a session.
   * @param {string} sessionId
   */
  async _loadSession(sessionId) {
    // Skip if already loading/loaded this session
    if (this.#sessionId === sessionId && this.frames.valueOf().length > 0) {
      return;
    }

    // Reset state
    this.#sessionId = sessionId;
    this.#lastTimestamp = null;
    this.#firstTimestamp = null;
    this.#hasOlderFrames = false;
    this.#loadingOlder = false;
    this.frames = [];
    this.compiled = new Map();
    this._phantomFrame = null;

    if (!sessionId) {
      return;
    }

    // Track this load so concurrent calls for the same session are deduplicated
    const loadId = Symbol();
    this._currentLoadId = loadId;

    // Fetch frames from API
    if (typeof window.fetchFrames === 'function') {
      try {
        const result = await window.fetchFrames(sessionId, { fromCompact: true });

        // Abort if a newer _loadSession call superseded this one
        if (this._currentLoadId !== loadId) {
          return;
        }

        if (result && result.frames) {
          // Update frames (triggers reactive update)
          this.frames = result.frames;

          // Compile frames to build state
          this._recompile();

          // Track timestamps
          if (result.frames.length > 0) {
            this.#lastTimestamp = result.frames[result.frames.length - 1].timestamp;
            this.#firstTimestamp = result.frames[0].timestamp;
          }

          // Check if there are older frames (before the compact point)
          this.#hasOlderFrames = result.hasMore || false;

          this.debug('Loaded frames', {
            sessionId,
            count:    result.frames.length,
            compiled: this.compiled.valueOf().size,
            hasOlder: this.#hasOlderFrames,
          });
        }
      } catch (error) {
        console.warn('SessionFramesProvider: Failed to load frames:', error);
      }
    }
  }

  /**
   * Clear session state.
   */
  _clearSession() {
    this.#sessionId = null;
    this.#lastTimestamp = null;
    this.#firstTimestamp = null;
    this.#hasOlderFrames = false;
    this.#loadingOlder = false;
    this._phantomFrame = null;
    this.frames = [];
    this.compiled = new Map();
  }

  /**
   * Load older frames (for infinite scroll / backward pagination).
   * Prepends frames before the oldest currently loaded frame.
   *
   * @param {number} [count=50] - Number of frames to load
   * @returns {Promise<{loaded: number, hasMore: boolean}>}
   */
  async loadOlderFrames(count = 50) {
    if (this.#loadingOlder || !this.#sessionId || !this.#firstTimestamp) {
      return { loaded: 0, hasMore: this.#hasOlderFrames };
    }

    this.#loadingOlder = true;

    try {
      let result = await window.fetchFrames(this.#sessionId, {
        before: this.#firstTimestamp,
        limit:  count,
      });

      if (!result || !result.frames || result.frames.length === 0) {
        this.#hasOlderFrames = false;
        return { loaded: 0, hasMore: false };
      }

      // Prepend older frames before current frames
      let currentFrames = this.frames.valueOf();
      let olderFrames   = result.frames;

      // Deduplicate by ID
      let existingIds = new Set(currentFrames.map((f) => f.id));
      let newFrames   = [];
      for (let frame of olderFrames) {
        if (!existingIds.has(frame.id))
          newFrames.push(frame);
      }

      if (newFrames.length > 0) {
        let merged = [...newFrames, ...currentFrames];
        merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        this.frames = merged;
        this._recompile();

        // Update first timestamp
        this.#firstTimestamp = merged[0].timestamp;
      }

      this.#hasOlderFrames = result.hasMore || false;

      this.debug('Loaded older frames', {
        loaded:  newFrames.length,
        hasMore: this.#hasOlderFrames,
        total:   this.frames.valueOf().length,
      });

      return { loaded: newFrames.length, hasMore: this.#hasOlderFrames };
    } catch (error) {
      console.warn('SessionFramesProvider: Failed to load older frames:', error);
      return { loaded: 0, hasMore: this.#hasOlderFrames };
    } finally {
      this.#loadingOlder = false;
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket Event Handlers
  // ---------------------------------------------------------------------------

  /**
   * Handle new_frame WebSocket event.
   * @param {CustomEvent} event
   */
  _handleNewFrame(event) {
    const { frame, sessionId } = event.detail;

    // Only process frames for our session
    if (!this.#sessionId || this.#sessionId !== String(sessionId)) {
      return;
    }
    if (!frame) {
      return;
    }

    // Add frame (including UPDATE frames - they're part of the event log)
    this._addFrame(frame);
    this.debug('Received new_frame:', frame.type, frame.id);
  }

  /**
   * Handle frame_update WebSocket event.
   * This is a legacy event - new code uses UPDATE frames via new_frame.
   * @param {CustomEvent} event
   */
  _handleFrameUpdate(event) {
    const { targetFrameId, payload, sessionId } = event.detail;

    // Only process updates for our session
    if (!this.#sessionId || this.#sessionId !== String(sessionId)) {
      return;
    }

    if (targetFrameId && payload) {
      // Create a synthetic UPDATE frame and add it
      const syntheticFrame = {
        id: `synthetic-${Date.now()}`,
        type: FrameType.UPDATE,
        targetIds: [`frame:${targetFrameId}`],
        payload: payload,
        timestamp: new Date().toISOString(),
      };
      this._addFrame(syntheticFrame);
      this.debug('Received frame_update (legacy):', targetFrameId);
    }
  }

  // ---------------------------------------------------------------------------
  // Frame Management
  // ---------------------------------------------------------------------------

  /**
   * Add a new frame.
   * @param {object} frame
   */
  _addFrame(frame) {
    let currentFrames = this.frames.valueOf();

    // Check for duplicate by ID
    const existing = currentFrames.find((f) => f.id === frame.id);
    if (existing) {
      // Update existing
      Object.assign(existing, frame);
      this.frames = [ ...currentFrames ];
    } else {
      // If this is a real user message frame, remove any optimistic user frames
      // with matching content (the optimistic frame was a placeholder)
      if (frame.type === 'message' && frame.authorType === 'user' && !frame.id.startsWith('optimistic-')) {
        currentFrames = currentFrames.filter((f) => {
          // Keep all non-optimistic frames
          if (!f.id.startsWith('optimistic-')) return true;
          // Remove optimistic user frames with matching content
          if (f.authorType === 'user' && f.payload?.content === frame.payload?.content) {
            this.debug('Removing optimistic frame replaced by real frame:', f.id);
            return false;
          }
          return true;
        });
      }

      // Clear phantom frame if this is the real agent message (replaces the phantom).
      // System messages (e.g. permission prompts) don't clear the phantom — they
      // appear alongside the streaming content.
      if (this._phantomFrame && frame.type === 'message' && frame.authorType === 'agent') {
        this.debug('Clearing phantom frame replaced by real agent message:', frame.id);
        this._phantomFrame = null;
      }

      // Add and sort by timestamp
      const newFrames = [ ...currentFrames, frame ];
      newFrames.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      this.frames = newFrames;
    }

    // Recompile all frames to update the compiled Map
    this._recompile();

    // Update last timestamp
    const allFrames = this.frames.valueOf();
    if (allFrames.length > 0) {
      this.#lastTimestamp = allFrames[allFrames.length - 1].timestamp;
    }
  }

  /**
   * Set phantom frame (for streaming messages before persisted).
   * This is a temporary frame that gets replaced when the real frame arrives.
   * @param {object|null} phantom
   */
  setPhantomFrame(phantom) {
    // Store phantom as a special property that children can access
    this._phantomFrame = phantom;

    // Trigger reactive update by reassigning compiled
    // hero-chat subscribes to compiled updates, not frames
    // We reassign compiled to same value to trigger the event
    this._recompile();
  }

  /**
   * Get current phantom frame.
   * @returns {object|null}
   */
  get phantomFrame() {
    return this._phantomFrame || null;
  }

  /**
   * Clear phantom frame.
   */
  clearPhantomFrame() {
    this._phantomFrame = null;

    // Trigger reactive update by reassigning compiled
    // hero-chat subscribes to compiled updates, not frames
    this._recompile();
  }

  /**
   * Finalize phantom frame (mark as complete).
   * Following the immutable frame pattern - don't clear, update state.
   * The typing indicator will be hidden when complete: true.
   */
  finalizePhantomFrame() {
    if (this._phantomFrame) {
      this._phantomFrame = {
        ...this._phantomFrame,
        complete: true,
      };

      // Trigger reactive update by reassigning compiled
      // hero-chat subscribes to compiled updates, not frames
      this._recompile();
    }
  }

  /**
   * Add an optimistic frame (for user messages before WebSocket confirmation).
   * The frame will be updated when the real frame arrives via WebSocket.
   * @param {object} frame
   */
  addOptimisticFrame(frame) {
    this._addFrame(frame);
  }
}

// Register the component
SessionFramesProvider.register();
