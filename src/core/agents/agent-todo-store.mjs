'use strict';

import { randomUUID } from 'node:crypto';

const DEFAULT_ROOT_PATH = '/kikx';
const EMPTY_TITLE_ERROR = 'title must be a non-empty string';

export class AgentTodoStore {
  constructor(options = {}) {
    let {
      aeordb,
      rootPath = DEFAULT_ROOT_PATH,
      clock = () => Date.now(),
      idGenerator = () => randomUUID(),
    } = options;

    if (!aeordb)
      throw new TypeError('AgentTodoStore requires an aeordb client');

    this.aeordb = aeordb;
    this.rootPath = normalizeRoot(rootPath);
    this.clock = clock;
    this.idGenerator = idGenerator;
  }

  async getTodoState(agentID) {
    let normalizedAgentID = normalizeRequiredString(agentID, 'agentID');
    let state = null;

    try {
      state = await this.aeordb.getFile(this.todoPath(normalizedAgentID));
    } catch (error) {
      if (error.status !== 404)
        throw error;
    }

    return normalizeTodoState(state, {
      agentID: normalizedAgentID,
      now: this.clock(),
    });
  }

  async addItem(agentID, input = {}) {
    let state = await this.getTodoState(agentID);
    let now = this.clock();
    let title = normalizeTitle(input.title || input.name);
    let notes = normalizeOptionalString(input.notes || input.description);
    let parentID = normalizeOptionalString(input.parentID || input.parent_id);
    let item = createTodoItem({
      id: input.id || this.idGenerator(),
      title,
      notes,
      now,
    });

    if (parentID) {
      let parent = findTopLevelItem(state.items, parentID);
      if (!parent)
        throw notFound(`Todo item not found: ${parentID}`);

      parent.children.push(item);
      parent.updatedAt = now;
    } else {
      state.items.push(item);
    }

    if (input.focus === true)
      state.focus = createFocus(parentID ? { itemID: parentID, childID: item.id, name: item.title, now } : { itemID: item.id, name: item.title, now });

    return await this.saveTodoState({
      ...state,
      updatedAt: now,
    });
  }

  async updateItem(agentID, input = {}) {
    let id = normalizeRequiredString(input.id || input.itemID || input.item_id, 'id');
    let state = await this.getTodoState(agentID);
    let target = findItem(state.items, id, normalizeOptionalString(input.parentID || input.parent_id));
    if (!target)
      throw notFound(`Todo item not found: ${id}`);

    let now = this.clock();
    let hasTitle = Object.hasOwn(input, 'title') || Object.hasOwn(input, 'name');
    let hasNotes = Object.hasOwn(input, 'notes') || Object.hasOwn(input, 'description');
    let status = normalizeOptionalStatus(input.status ?? input.state);

    if (hasTitle)
      target.item.title = normalizeTitle(input.title || input.name);

    if (hasNotes)
      target.item.notes = normalizeOptionalString(input.notes ?? input.description);

    if (status)
      applyStatus(target.item, status, now);

    if (input.completed === true || input.complete === true)
      applyStatus(target.item, 'complete', now);
    else if (input.completed === false || input.complete === false)
      applyStatus(target.item, 'pending', now);

    target.item.updatedAt = now;
    if (target.parent)
      target.parent.updatedAt = now;

    if (state.focus && focusMatches(state.focus, target))
      state.focus.name = target.item.title;

    return await this.saveTodoState({
      ...state,
      updatedAt: now,
    });
  }

  async completeItem(agentID, input = {}) {
    return await this.updateItem(agentID, {
      ...input,
      status: 'complete',
    });
  }

  async deleteItem(agentID, input = {}) {
    let id = normalizeRequiredString(input.id || input.itemID || input.item_id, 'id');
    let state = await this.getTodoState(agentID);
    let parentID = normalizeOptionalString(input.parentID || input.parent_id);
    let removed = null;
    let now = this.clock();

    if (parentID) {
      let parent = findTopLevelItem(state.items, parentID);
      if (!parent)
        throw notFound(`Todo item not found: ${parentID}`);

      removed = removeByID(parent.children, id);
      if (removed)
        parent.updatedAt = now;
    } else {
      removed = removeByID(state.items, id);
      if (!removed) {
        for (let parent of state.items) {
          removed = removeByID(parent.children, id);
          if (removed) {
            parent.updatedAt = now;
            break;
          }
        }
      }
    }

    if (!removed)
      throw notFound(`Todo item not found: ${id}`);

    if (state.focus && (state.focus.itemID === id || state.focus.childID === id))
      state.focus = null;

    return await this.saveTodoState({
      ...state,
      updatedAt: now,
    });
  }

  async clearTodoState(agentID) {
    let state = await this.getTodoState(agentID);
    let now = this.clock();
    return await this.saveTodoState({
      ...state,
      items: [],
      focus: null,
      updatedAt: now,
    });
  }

  async setFocus(agentID, input = {}) {
    let id = normalizeRequiredString(input.id || input.itemID || input.item_id, 'id');
    let state = await this.getTodoState(agentID);
    let target = findItem(state.items, id, normalizeOptionalString(input.parentID || input.parent_id));
    if (!target)
      throw notFound(`Todo item not found: ${id}`);

    let now = this.clock();
    state.focus = createFocus({
      itemID: target.parent?.id || target.item.id,
      childID: target.parent ? target.item.id : null,
      name: target.item.title,
      now,
    });

    return await this.saveTodoState({
      ...state,
      updatedAt: now,
    });
  }

  async clearFocus(agentID) {
    let state = await this.getTodoState(agentID);
    let now = this.clock();
    return await this.saveTodoState({
      ...state,
      focus: null,
      updatedAt: now,
    });
  }

  async saveTodoState(state) {
    let normalized = normalizeTodoState(state, {
      agentID: state.agentID,
      now: this.clock(),
    });
    await this.aeordb.putFile(this.todoPath(normalized.agentID), normalized);
    return cloneJSON(normalized);
  }

  todoPath(agentID) {
    return `${this.rootPath}/agents/${encodeURIComponent(normalizeRequiredString(agentID, 'agentID'))}/todo.json`;
  }
}

function createTodoItem({ id, title, notes = '', now }) {
  return {
    id: normalizeRequiredString(id, 'id'),
    title: normalizeTitle(title),
    notes: normalizeOptionalString(notes),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    children: [],
  };
}

function normalizeTodoState(value, options = {}) {
  let now = options.now || Date.now();
  let agentID = normalizeRequiredString(value?.agentID || options.agentID, 'agentID');
  let state = isPlainObject(value) ? value : {};
  let items = Array.isArray(state.items)
    ? state.items.map((item) => normalizeTodoItem(item, now)).filter(Boolean)
    : [];

  return {
    agentID,
    items,
    focus: normalizeFocus(state.focus, items),
    createdAt: state.createdAt || now,
    updatedAt: state.updatedAt || state.createdAt || now,
  };
}

function normalizeTodoItem(item, now) {
  if (!isPlainObject(item) || typeof item.id !== 'string' || item.id.trim() === '')
    return null;

  let title = typeof item.title === 'string' && item.title.trim() !== ''
    ? item.title.trim()
    : item.id.trim();

  return {
    id: item.id.trim(),
    title,
    notes: normalizeOptionalString(item.notes),
    status: item.status === 'complete' ? 'complete' : 'pending',
    createdAt: item.createdAt || now,
    updatedAt: item.updatedAt || item.createdAt || now,
    completedAt: item.status === 'complete' ? (item.completedAt || item.updatedAt || now) : null,
    children: Array.isArray(item.children)
      ? item.children.map((child) => normalizeTodoChild(child, now)).filter(Boolean)
      : [],
  };
}

function normalizeTodoChild(item, now) {
  let child = normalizeTodoItem(item, now);
  if (!child)
    return null;

  child.children = [];
  return child;
}

function normalizeFocus(focus, items) {
  if (!isPlainObject(focus))
    return null;

  let itemID = normalizeOptionalString(focus.itemID || focus.item_id);
  let childID = normalizeOptionalString(focus.childID || focus.child_id);
  if (!itemID)
    return null;

  let target = childID ? findItem(items, childID, itemID) : findItem(items, itemID);
  if (!target)
    return null;

  return {
    itemID: target.parent?.id || target.item.id,
    childID: target.parent ? target.item.id : null,
    name: target.item.title,
    setAt: focus.setAt || null,
  };
}

function createFocus({ itemID, childID = null, name, now }) {
  return {
    itemID,
    childID,
    name,
    setAt: now,
  };
}

function findTopLevelItem(items, id) {
  let normalizedID = normalizeOptionalString(id);
  return items.find((item) => item.id === normalizedID) || null;
}

function findItem(items, id, parentID = '') {
  let normalizedID = normalizeOptionalString(id);
  let normalizedParentID = normalizeOptionalString(parentID);
  if (!normalizedID)
    return null;

  if (normalizedParentID) {
    let parent = findTopLevelItem(items, normalizedParentID);
    if (!parent)
      return null;

    let child = parent.children.find((item) => item.id === normalizedID) || null;
    return child ? { item: child, parent } : null;
  }

  for (let item of items) {
    if (item.id === normalizedID)
      return { item, parent: null };

    let child = item.children.find((candidate) => candidate.id === normalizedID);
    if (child)
      return { item: child, parent: item };
  }

  return null;
}

function removeByID(items, id) {
  let index = items.findIndex((item) => item.id === id);
  if (index < 0)
    return null;

  return items.splice(index, 1)[0] || null;
}

function applyStatus(item, status, now) {
  item.status = status;
  item.completedAt = status === 'complete' ? (item.completedAt || now) : null;
}

function focusMatches(focus, target) {
  if (!focus || !target)
    return false;

  if (target.parent)
    return focus.itemID === target.parent.id && focus.childID === target.item.id;

  return focus.itemID === target.item.id && !focus.childID;
}

function normalizeTitle(value) {
  let title = normalizeRequiredString(value, 'title');
  if (!title)
    throw new TypeError(EMPTY_TITLE_ERROR);

  return title;
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${fieldName} must be a non-empty string`);

  return value.trim();
}

function normalizeOptionalString(value) {
  if (value == null)
    return '';

  if (typeof value !== 'string')
    return String(value).trim();

  return value.trim();
}

function normalizeOptionalStatus(value) {
  if (value == null || value === '')
    return '';

  let status = String(value).trim().toLowerCase();
  if ([ 'done', 'completed', 'complete' ].includes(status))
    return 'complete';

  if ([ 'todo', 'open', 'pending', 'incomplete' ].includes(status))
    return 'pending';

  throw new TypeError('status must be pending or complete');
}

function normalizeRoot(rootPath) {
  if (!rootPath || typeof rootPath !== 'string')
    throw new TypeError('rootPath must be a non-empty string');

  return `/${rootPath.replace(/^\/+|\/+$/g, '')}`;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function notFound(message) {
  let error = new Error(message);
  error.status = 404;
  return error;
}
