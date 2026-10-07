'use strict';

// Pure, DOM-free presentation logic for the todo tool cards.
//
// Kept out of tool-use-base.mjs (which imports the AEOR element DSL over
// /vendor URLs and therefore cannot be loaded in node) so the summary rules can
// be unit-tested and reused. The renderer passes in the tool name, the call
// input, and the todo state recovered from the tool result; these functions
// decide the visible summary and NEVER fall back to a raw UUID.

const ACTION_VERBS = {
  'todo-add': { call: 'Adding todo', done: 'Added todo' },
  'todo-update': { call: 'Updating todo', done: 'Updated todo' },
  'todo-complete': { call: 'Completing todo', done: 'Completed todo' },
  'todo-delete': { call: 'Deleting todo', done: 'Deleted todo' },
  'todo-focus-set': { call: 'Focusing todo', done: 'Focused todo' },
};

// Accept the todo result in any shape the renderer can produce: a parsed state
// object, a JSON string, or an already-extracted list.
export function extractTodoItems(result) {
  let state = parseTodoResult(result);
  if (Array.isArray(state))
    return state;

  return Array.isArray(state?.items) ? state.items : [];
}

// The item removed by todo-delete. AgentTodoStore returns it as `deleted` on the
// result object only (it is deliberately not persisted), so a delete result can
// still name its subject. Returns null when absent or malformed.
export function extractDeletedTodo(result) {
  let state = parseTodoResult(result);
  let deleted = state?.deleted;
  if (!deleted || typeof deleted !== 'object' || Array.isArray(deleted))
    return null;

  return { id: typeof deleted.id === 'string' ? deleted.id : '', title: titleOf(deleted) };
}

function parseTodoResult(result) {
  if (typeof result === 'string') {
    try {
      return JSON.parse(result);
    } catch (_error) {
      return null;
    }
  }

  return result;
}

export function findTodoTitle(items, id) {
  if (!id || !Array.isArray(items))
    return '';

  for (let item of items) {
    if (!item)
      continue;

    if (item.id === id)
      return titleOf(item);

    let children = Array.isArray(item.children) ? item.children : [];
    for (let child of children) {
      if (child?.id === id)
        return titleOf(child);
    }
  }

  return '';
}

// The most human-readable subject for the todo being acted on:
//   1) an explicit title in the call input (todo-add, or a rename via update),
//   2) the item the id points at in the returned todo state (update / complete /
//      delete / focus-set carry only an id), else
//   3) '' so callers fall back to a generic phrase — never a raw id.
export function todoSubject({ input = {}, items = [], deleted = null } = {}) {
  if (typeof input.title === 'string' && input.title.trim() !== '')
    return input.title.trim();

  let fromItems = findTodoTitle(items, input.id);
  if (fromItems)
    return fromItems;

  // A delete result no longer contains its item in `items`; fall back to the
  // removed item the store returned so the summary can still name it.
  return titleOf(deleted);
}

export function todoCallSummary({ toolName, input = {}, items = [] } = {}) {
  if (toolName === 'todo-get')
    return 'Reading todo list...';
  if (toolName === 'todo-clear')
    return 'Clearing todo list...';
  if (toolName === 'todo-focus-clear')
    return 'Clearing todo focus...';

  let verb = ACTION_VERBS[toolName]?.call;
  if (!verb)
    return 'Updating todo list...';

  let subject = todoSubject({ input, items });
  if (subject)
    return `${verb}: ${subject}`;

  // No resolvable title: degrade to a status-aware generic, never an id.
  if (toolName === 'todo-update' && (input.status === 'complete' || input.completed === true))
    return 'Completing todo...';

  return `${verb}...`;
}

export function todoResultSummary({ toolName, status, input = {}, items = [], deleted = null } = {}) {
  let outcome = status === 'error' ? 'failed' : 'completed';

  if (toolName === 'todo-get' || toolName === 'todo-clear')
    return `Todo list ${outcome}.`;
  if (toolName === 'todo-focus-clear')
    return `Todo focus ${outcome}.`;

  let done = ACTION_VERBS[toolName]?.done;
  if (!done)
    return `Todo ${outcome}.`;

  let subject = todoSubject({ input, items, deleted });
  return subject ? `${done}: ${subject}` : `${done}.`;
}

function titleOf(item) {
  return typeof item?.title === 'string' ? item.title.trim() : '';
}
