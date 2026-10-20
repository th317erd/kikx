'use strict';

import { elements, $ } from '../../lib/aeor-ui.mjs';
import { ToolUse } from './tool-use-base.mjs';
import {
  extractDeletedTodo,
  extractTodoItems,
  todoCallSummary,
  todoResultSummary,
  todoSubject,
} from './todo-summary.mjs';

const { div, span, strong, p, ul, li } = elements;

// Todo cards are meant to tell the user what changed and what the list looks
// like now. They never render the raw JSON state (which is full of UUIDs), and
// they never display a todo id. The item title, notes, checkbox, focus and
// counts are the useful surface.
export class TodoToolUse extends ToolUse {
  displayName() {
    return 'Todo list';
  }

  todoResult() {
    let output = this.state.output || this.previewOutput();
    if (!output)
      return null;

    return parseTodoOutput(output);
  }

  todoItems() {
    return extractTodoItems(this.todoResult());
  }

  callSummary() {
    return todoCallSummary({ toolName: this.toolName, input: this.input, items: this.todoItems() });
  }

  resultSummary() {
    let result = this.todoResult();
    return todoResultSummary({
      toolName: this.toolName,
      status: this.status,
      input: this.input,
      items: extractTodoItems(result),
      deleted: extractDeletedTodo(result),
    });
  }

  renderFacts() {
    let items = flattenTodoItems(this.todoItems());
    let done = items.filter((item) => isComplete(item)).length;
    let open = Math.max(0, items.length - done);
    return div.class('kikx-tool-card__facts')(
      span(`${open} open`),
      span(`${done} done`),
    ).build(document);
  }

  renderToolSpecificSections() {
    let result = this.todoResult();
    let items = extractTodoItems(result);
    let deleted = extractDeletedTodo(result);
    let action = this.todoAction(items, deleted);

    return div.class('kikx-todo-panel')(
      div.class(`kikx-todo-action kikx-todo-action--${action.kind}`)(action.text),
      deleted ? this.renderDeletedTodo(deleted) : null,
      this.renderTodoList(items, result?.focus),
    ).build(document);
  }

  // The generic JSON arguments/output views are exactly the UUID soup the todo
  // card must avoid. The panel above is the whole user-facing detail.
  renderArgumentsDetails() {
    return null;
  }

  renderResultDetails() {
    return null;
  }

  todoAction(items, deleted) {
    let subject = todoSubject({ input: this.input, items, deleted });
    let title = typeof this.input.title === 'string' ? this.input.title.trim() : '';

    if (this.status === 'error')
      return { kind: 'error', text: this.resultSummary() };

    switch (this.toolName) {
      case 'todo-add':
        return { kind: 'added', text: `Added: ${title || subject || 'New todo'}` };
      case 'todo-complete':
        return { kind: 'completed', text: `Completed: ${subject || 'Todo item'}` };
      case 'todo-delete':
        return { kind: 'deleted', text: `Deleted: ${deleted?.title || subject || 'Todo item'}` };
      case 'todo-focus-set':
        return { kind: 'focused', text: `Focus set: ${subject || 'Todo item'}` };
      case 'todo-focus-clear':
        return { kind: 'focused', text: 'Todo focus cleared' };
      case 'todo-clear':
        return { kind: 'cleared', text: 'All todos cleared' };
      case 'todo-get':
        return { kind: 'listed', text: 'Current todo list' };
      case 'todo-update':
        if (this.input.completed === true || this.input.status === 'complete')
          return { kind: 'completed', text: `Completed: ${subject || title || 'Todo item'}` };
        if (title)
          return { kind: 'updated', text: `Renamed to: ${title}` };
        if (Object.hasOwn(this.input, 'notes'))
          return { kind: 'updated', text: `Notes updated: ${subject || 'Todo item'}` };
        return { kind: 'updated', text: `Updated: ${subject || 'Todo item'}` };
      default:
        return { kind: 'updated', text: 'Todo list updated' };
    }
  }

  renderDeletedTodo(deleted) {
    return ul.class('kikx-todo-list kikx-todo-list--deleted')(
      li.class('kikx-todo-item kikx-todo-item--deleted')(
        span.class('kikx-todo-checkbox is-deleted')(),
        div.class('kikx-todo-item__body')(
          strong.class('kikx-todo-item__title')(deleted.title || 'Deleted todo'),
        ),
      ),
    ).build(document);
  }

  renderTodoList(items, focus = null) {
    if (!Array.isArray(items) || items.length === 0)
      return p.class('kikx-todo-empty')('No todo items.').build(document);

    return ul.class('kikx-todo-list')(
      ...items.map((item) => this.renderTodoItem(item, focus)),
    ).build(document);
  }

  renderTodoItem(item, focus = null) {
    let children = Array.isArray(item?.children) ? item.children : [];
    let complete = isComplete(item);
    let focused = isFocused(item, focus);
    let row = li.class('kikx-todo-item')(
      span.class(`kikx-todo-checkbox${complete ? ' is-complete' : ''}`)(),
      div.class('kikx-todo-item__body')(
        div.class('kikx-todo-item__head')(
          strong.class('kikx-todo-item__title')(titleOf(item)),
          focused ? span.class('kikx-todo-focus')('Focus') : null,
        ),
        item?.notes ? p.class('kikx-todo-item__notes')(String(item.notes)) : null,
        children.length > 0
          ? ul.class('kikx-todo-list kikx-todo-list--children')(
            ...children.map((child) => this.renderTodoItem(child, focus)),
          ).build(document)
          : null,
      ),
    ).build(document);

    if (complete)
      row.classList.add('is-complete');
    if (focused)
      row.classList.add('is-focused');

    let checkbox = row.querySelector('.kikx-todo-checkbox');
    if (checkbox) {
      checkbox.setAttribute('role', 'checkbox');
      checkbox.setAttribute('aria-checked', complete ? 'true' : 'false');
      checkbox.setAttribute('aria-label', complete ? 'Completed' : 'Pending');
    }

    return row;
  }
}

function parseTodoOutput(output = {}) {
  if (output.format !== 'json')
    return output.content || '';

  try {
    return JSON.parse(output.content || 'null');
  } catch (_error) {
    return output.content || '';
  }
}

function flattenTodoItems(items) {
  let output = [];
  for (let item of Array.isArray(items) ? items : []) {
    if (!item)
      continue;
    output.push(item);
    if (Array.isArray(item.children))
      output.push(...flattenTodoItems(item.children));
  }
  return output;
}

function isComplete(item) {
  return item?.status === 'complete' || item?.completed === true;
}

function isFocused(item, focus) {
  if (!focus || !item)
    return false;
  if (focus.childID)
    return focus.childID === item.id;
  return focus.itemID === item.id;
}

function titleOf(item) {
  let title = typeof item?.title === 'string' ? item.title.trim() : '';
  return title || 'Untitled todo';
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-todo-tool-use'))
  customElements.define('kikx-todo-tool-use', TodoToolUse);
