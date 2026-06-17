'use strict';

import { GenericToolUse } from './tool-use-base.mjs';

export class KikxToolCallFrame extends GenericToolUse {}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-tool-call-frame'))
  customElements.define('kikx-tool-call-frame', KikxToolCallFrame);
