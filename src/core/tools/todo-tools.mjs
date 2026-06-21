'use strict';

import { PluginInterface } from '../plugins/index.mjs';
import { builtInToolComponent } from './tool-client-components.mjs';

class TodoTool extends PluginInterface {
  static pluginID = 'internal:todos';
  static clientComponent = builtInToolComponent('kikx-todo-tool-use');
  static riskLevel = 'none';

  todoStore() {
    let store = this.context.agentTodoStore || this.context.services?.agentTodoStore || resolveContextService(this.context, 'agentTodoStore');
    if (!store)
      throw new Error(`${this.constructor.featureName} requires agentTodoStore`);

    return store;
  }

  agentID(params = {}) {
    let agentID = normalizeOptionalString(this.context.agent?.id || params._agentID);
    if (!agentID)
      throw new Error(`${this.constructor.featureName} requires an agent context`);

    return agentID;
  }
}

export class TodoGetTool extends TodoTool {
  static featureName = 'todo-get';
  static displayName = 'Get todo list';
  static description = 'Read your current Kikx agent todo list and focus.';
  static frameType = 'TodoGetToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };
  static help = 'Use todo-get to inspect your own todo list, one-level sub-items, and current focus.';

  async _execute(params = {}) {
    return await this.todoStore().getTodoState(this.agentID(params));
  }
}

export class TodoAddTool extends TodoTool {
  static featureName = 'todo-add';
  static displayName = 'Add todo item';
  static description = 'Add a top-level todo item or one-level sub-item to your Kikx agent todo list.';
  static frameType = 'TodoAddToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Todo item title.',
      },
      notes: {
        type: 'string',
        description: 'Optional notes or acceptance details.',
      },
      parentID: {
        type: 'string',
        description: 'Optional top-level item ID. When set, the new item is added as a one-level sub-item.',
      },
      focus: {
        type: 'boolean',
        description: 'When true, also set focus to the new item.',
      },
    },
    required: [ 'title' ],
    additionalProperties: false,
  };
  static help = 'Use todo-add to create a top-level todo or a one-level sub-item with parentID. Set focus true when this is the next thing you should work on.';

  async _execute(params = {}) {
    return await this.todoStore().addItem(this.agentID(params), params);
  }
}

export class TodoUpdateTool extends TodoTool {
  static featureName = 'todo-update';
  static displayName = 'Update todo item';
  static description = 'Update a todo item title, notes, or status.';
  static frameType = 'TodoUpdateToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Todo item or sub-item ID.',
      },
      parentID: {
        type: 'string',
        description: 'Optional parent ID for a sub-item.',
      },
      title: {
        type: 'string',
        description: 'New title.',
      },
      notes: {
        type: 'string',
        description: 'New notes.',
      },
      status: {
        type: 'string',
        enum: [ 'pending', 'complete' ],
        description: 'New completion status.',
      },
      completed: {
        type: 'boolean',
        description: 'Shortcut to mark complete when true or pending when false.',
      },
    },
    required: [ 'id' ],
    additionalProperties: false,
  };
  static help = 'Use todo-update to rename, rewrite notes, or change status for an existing todo item or one-level sub-item.';

  async _execute(params = {}) {
    return await this.todoStore().updateItem(this.agentID(params), params);
  }
}

export class TodoCompleteTool extends TodoTool {
  static featureName = 'todo-complete';
  static displayName = 'Complete todo item';
  static description = 'Mark a todo item or sub-item complete.';
  static frameType = 'TodoCompleteToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Todo item or sub-item ID.',
      },
      parentID: {
        type: 'string',
        description: 'Optional parent ID for a sub-item.',
      },
    },
    required: [ 'id' ],
    additionalProperties: false,
  };
  static help = 'Use todo-complete when you have finished a todo item or one-level sub-item.';

  async _execute(params = {}) {
    return await this.todoStore().completeItem(this.agentID(params), params);
  }
}

export class TodoDeleteTool extends TodoTool {
  static featureName = 'todo-delete';
  static displayName = 'Delete todo item';
  static description = 'Delete a todo item or sub-item from your Kikx agent todo list.';
  static frameType = 'TodoDeleteToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Todo item or sub-item ID.',
      },
      parentID: {
        type: 'string',
        description: 'Optional parent ID for a sub-item.',
      },
    },
    required: [ 'id' ],
    additionalProperties: false,
  };
  static help = 'Use todo-delete to remove an item that is obsolete or no longer relevant.';

  async _execute(params = {}) {
    return await this.todoStore().deleteItem(this.agentID(params), params);
  }
}

export class TodoClearTool extends TodoTool {
  static featureName = 'todo-clear';
  static displayName = 'Clear todo list';
  static description = 'Clear your entire Kikx agent todo list and focus.';
  static frameType = 'TodoClearToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };
  static help = 'Use todo-clear only when the whole list is obsolete or the user asks you to clear it.';

  async _execute(params = {}) {
    return await this.todoStore().clearTodoState(this.agentID(params));
  }
}

export class TodoFocusSetTool extends TodoTool {
  static featureName = 'todo-focus-set';
  static displayName = 'Set todo focus';
  static description = 'Set your current focus to a specific todo item or sub-item.';
  static frameType = 'TodoFocusSetToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Todo item or sub-item ID to focus.',
      },
      parentID: {
        type: 'string',
        description: 'Optional parent ID for a sub-item.',
      },
    },
    required: [ 'id' ],
    additionalProperties: false,
  };
  static help = 'Use todo-focus-set to deliberately choose the current todo item you are working on.';

  async _execute(params = {}) {
    return await this.todoStore().setFocus(this.agentID(params), params);
  }
}

export class TodoFocusClearTool extends TodoTool {
  static featureName = 'todo-focus-clear';
  static displayName = 'Clear todo focus';
  static description = 'Clear your current todo focus without deleting the list.';
  static frameType = 'TodoFocusClearToolFrame';
  static inputSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };
  static help = 'Use todo-focus-clear when no todo item should be treated as your current focus.';

  async _execute(params = {}) {
    return await this.todoStore().clearFocus(this.agentID(params));
  }
}

function resolveContextService(context, name) {
  let appContext = context.services?.context || context.context;
  if (appContext?.has?.(name) && typeof appContext.require === 'function')
    return appContext.require(name);

  if (typeof appContext?.require === 'function') {
    try {
      return appContext.require(name);
    } catch (_error) {
      return null;
    }
  }

  return null;
}

function normalizeOptionalString(value) {
  if (value == null)
    return '';

  return String(value).trim();
}
