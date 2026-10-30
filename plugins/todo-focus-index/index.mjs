'use strict';

const PLUGIN_ID = 'internal:todo-focus-index';
const INDEX_NAME = 'focus_todo_id';
const SERVICE_NAME = 'todoFocusIndex';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

// The focus index is created once per load, not once per process.
//
// It lives in a plugin-owned service so the registry owns its lifetime: unload releases
// it, and a reload builds a fresh one. The previous shape kept the promise in module
// scope, which outlived every reload - a re-registered plugin silently reused the first
// load's result - and its `.catch(() => {})` cached a transient failure forever, so one
// bad moment at startup disabled the index for the whole process.
//
export class TodoFocusIndexService {
  constructor({ db = null } = {}) {
    this.db = db;
    this.promise = null;
    this.error = null;
    this.attempts = 0;
  }

  ensure() {
    if (this.promise)
      return this.promise;
    if (!this.db?.ensureScalarIndex)
      return Promise.resolve();

    this.attempts += 1;
    this.promise = Promise.resolve()
      .then(() => this.db.ensureScalarIndex(INDEX_NAME))
      .then((result) => {
        this.error = null;
        return result;
      })
      .catch((error) => {
        // Report, never cache: a failed index stays retryable, and frame stamping must
        // not be blocked by it. The failure is visible on .error for health checks.
        this.error = error?.message || String(error);
        this.promise = null;
        return undefined;
      });
    return this.promise;
  }
}

export function createTodoFocusIndexService(context = {}) {
  return new TodoFocusIndexService({ db: resolveService(context, 'aeordb') });
}

function ensureFocusIndex(context) {
  let service = resolveService(context, SERVICE_NAME);
  if (!service?.ensure) {
    // Hand-built contexts (specs, legacy embedders) may have no service layer at all.
    // Memoize on that context rather than in module scope, so it still cannot leak
    // across loads.
    service = createTodoFocusIndexService(context);
    if (context && typeof context === 'object')
      context[SERVICE_NAME] = service;
  }
  return service.ensure();
}

function normalizeID(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveService(context, name) {
  if (context?.[name])
    return context[name];
  if (context?.services?.[name])
    return context.services[name];
  if (typeof context?.require === 'function' && context.has?.(name))
    return context.require(name);
  if (typeof context?.get === 'function')
    return context.get(name);
  if (typeof context?.services?.context?.get === 'function')
    return context.services.context.get(name);
  return null;
}

function resolveAgentID(frame, engine, session) {
  let direct = normalizeID(frame.targetAgentID)
    || (frame.authorType === 'agent' ? normalizeID(frame.authorID) : '');
  if (direct)
    return direct;

  if (frame.parentID) {
    let parent = engine?.get?.(frame.parentID);
    if (parent?.authorType === 'agent' && normalizeID(parent.authorID))
      return parent.authorID;
  }

  let contentAgent = normalizeID(frame.content?.agentID);
  if (contentAgent)
    return contentAgent;

  return normalizeID(session?.coordinatorAgentID);
}

export class FocusTodoFramePlugin {
  static pluginID = PLUGIN_ID;

  constructor(context = {}) {
    this.context = context;
  }

  async process(next) {
    let context = this.context || {};
    let frame = context.newFrame;
    if (!frame?.id || frame.focus_todo_id != null) {
      await next(context);
      return;
    }

    let agentID = resolveAgentID(frame, context.engine, context.session);
    if (!agentID) {
      await next(context);
      return;
    }

    let todoStore = resolveService(context, 'agentTodoStore');
    if (!todoStore?.getTodoState) {
      await next(context);
      return;
    }

    await ensureFocusIndex(context);

    let state;
    try {
      state = await todoStore.getTodoState(agentID);
    } catch {
      await next(context);
      return;
    }

    let focusID = normalizeID(state?.focus?.childID) || normalizeID(state?.focus?.itemID);
    if (!focusID) {
      await next(context);
      return;
    }

    let merged = context.engine.merge([{
      ...frame,
      focus_todo_id: focusID,
    }], {
      authorType: 'system',
      authorID: PLUGIN_ID,
      silent: true,
    });
    let updated = merged[0] || context.engine.get?.(frame.id) || { ...frame, focus_todo_id: focusID };
    await context.services?.frameRuntime?.frameStore?.flush?.();
    await next({
      ...context,
      newFrame: updated,
      changes: [
        ...(context.changes || []),
        {
          propName: INDEX_NAME,
          previousValue: frame[INDEX_NAME],
          newValue: updated[INDEX_NAME],
        },
      ],
    });
  }
}

export function setup(provide) {
  provide(({ registry, registerService }) => {
    // The focus index is this plugin's first service: the registry owns its lifetime,
    // so unload tears it down and a reload gets a fresh instance instead of inheriting
    // the previous load's promise.
    //
    // Deliberately no `dependsOn: [ 'aeordb' ]`. A missing database used to be tolerated
    // (the index is advisory), and declaring it a dependency would turn that tolerance
    // into a fatal initializePluginServices() error that aborts boot.
    registerService?.(SERVICE_NAME, {
      factory: (context) => createTodoFocusIndexService(context),
      shutdown: (instance) => { if (instance) instance.promise = null; },
    });

    registry.registerFrameIndex?.(INDEX_NAME, { type: 'string' });
    registry.registerSelector('*', FocusTodoFramePlugin, PLUGIN_ID);

    let PluginInterface = registry.getClass?.('PluginInterface');
    if (!PluginInterface)
      return;

    class TodoFramesTool extends PluginInterface {
      static pluginID = PLUGIN_ID;
      static featureName = 'todo-frames';
      static displayName = 'List frames for a todo item';
      static description = 'List frames indexed under a todo item ID, including tool calls and other frame types.';
      static frameType = 'TodoFramesToolFrame';
      static riskLevel = 'none';
      static inputSchema = {
        type: 'object',
        properties: {
          todo_id: { type: 'string', description: 'Todo item ID to query.' },
          session_id: { type: 'string', description: 'Session ID. Defaults to the current session.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
          offset: { type: 'integer', minimum: 0 },
        },
        required: [ 'todo_id' ],
        additionalProperties: false,
      };
      static help = 'Use todo-frames to list frames associated with a todo item. Results are locators; read bodies with database-fetch.';

      async _execute(params = {}) {
        let todoID = normalizeID(params.todo_id);
        if (!todoID)
          throw new TypeError('todo-frames requires todo_id');

        let sessionID = normalizeID(params.session_id) || normalizeID(this.context.session?.id);
        if (!sessionID)
          throw new TypeError('todo-frames requires a session_id or current session');

        let db = resolveService(this.context, 'aeordb');
        if (!db?.searchFiles)
          throw new Error('todo-frames requires the aeordb search service');

        let limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(Number(params.limit) || DEFAULT_LIMIT)));
        let offset = Math.max(0, Math.trunc(Number(params.offset) || 0));
        let result = await db.searchFiles({
          path: `/kikx/sessions/${encodeURIComponent(sessionID)}/interactions`,
          where: { field: INDEX_NAME, op: 'eq', value: todoID },
          limit,
          offset,
          include_matches: false,
        });
        let results = Array.isArray(result?.results)
          ? result.results
          : Array.isArray(result?.items) ? result.items : [];

        return {
          todo_id: todoID,
          session_id: sessionID,
          index: INDEX_NAME,
          results,
          count: results.length,
          has_more: Boolean(result?.has_more),
          fetch_tool: 'database-fetch',
          note: 'Use database-fetch with each result path and its fetch hint to read the frame body.',
        };
      }
    }

    registry.registerTool('todo-frames', TodoFramesTool);
  });
}

export default setup;
