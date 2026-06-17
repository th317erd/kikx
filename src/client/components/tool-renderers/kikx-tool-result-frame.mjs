'use strict';

import { GenericToolUse } from './tool-use-base.mjs';

export class KikxToolResultFrame extends GenericToolUse {}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-tool-result-frame'))
  customElements.define('kikx-tool-result-frame', KikxToolResultFrame);
