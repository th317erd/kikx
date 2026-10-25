'use strict';

import { ToolUse } from './tool-use-base.mjs';

export class TagToolUse extends ToolUse {
  static toolName = 'tag-list';

  displayName() {
    return 'Tags';
  }

  callSummary() {
    let target = this.tagTarget();
    return target ? `Tagging ${target}...` : 'Updating tags...';
  }

  resultSummary() {
    let outcome = this.status === 'error' ? 'failed' : 'completed';
    if (this.content.toolName === 'tag-list') {
      let count = Array.isArray(this.content.result?.tags) ? this.content.result.tags.length : null;
      return count == null ? 'Listed tags.' : `Listed ${count} tag${count === 1 ? '' : 's'}.`;
    }

    let target = this.tagTarget();
    return target ? `Tag ${outcome}: ${target}` : `Tag ${outcome}.`;
  }

  tagTarget() {
    let type = this.input.target_type || '';
    let id = this.input.target_id || '';
    let name = this.input.name || '';
    let target = type && id ? `${type}/${id}` : '';
    return name ? (target ? `${target} · ${name}` : name) : target;
  }
}
