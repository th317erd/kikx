'use strict';

import { elements } from '../../lib/aeor-ui.mjs';
import { ShellToolUse } from './tool-use-base.mjs';

const { div, pre, code, details, summary } = elements;

export class ScriptToolUse extends ShellToolUse {
  static toolName = 'exec-script';

  displayName() {
    return 'Script';
  }

  renderSummaryText() {
    return this.isResultFrame ? this.resultSummary() : this.callSummary();
  }

  callSummary() {
    let target = this.scriptTarget();
    return target ? `Running script: ${target}...` : 'Running script...';
  }

  resultSummary() {
    let outcome = this.status === 'error' ? 'failed' : 'completed';
    let target = this.scriptTarget();
    return target ? `Script ${outcome}: ${target}` : `Script ${outcome}.`;
  }

  scriptTarget() {
    if (typeof this.input.start === 'string' && this.input.start.trim() !== '')
      return this.input.start.trim();
    return this.input.entry || '';
  }

  renderArgumentsDetails() {
    // The dedicated script disclosure below is more useful than raw JSON, and
    // is available on both call and result cards.
    return null;
  }

  renderToolSpecificSections() {
    let entries = scriptSourceEntries(this.input);
    if (entries.length === 0)
      return null;

    let detailsNode = details.class('kikx-tool-card__details kikx-tool-card__script-details')(
      summary('View script source'),
    ).build(document);
    let bodyNode = null;
    let ensureBody = () => {
      if (bodyNode)
        return;
      bodyNode = this.renderScriptSource(entries);
      detailsNode.appendChild(bodyNode);
    };
    let clearBody = () => {
      if (!bodyNode)
        return;
      bodyNode.remove();
      bodyNode = null;
    };

    detailsNode.addEventListener('toggle', () => {
      if (detailsNode.open)
        ensureBody();
      else
        clearBody();
    });

    return detailsNode;
  }

  renderScriptSource(entries) {
    return div.class('kikx-tool-output kikx-tool-output--script')(
      ...entries.map((entry) => div.class('kikx-tool-output__section')(
        div.class('kikx-tool-output__section-label')(entry.label),
        pre.class('kikx-tool-card__preview')(code(entry.content)),
      )),
    ).build(document);
  }
}

export function scriptSourceEntries(input = {}) {
  let entries = [];
  if (typeof input.start === 'string' && input.start.trim() !== '')
    entries.push({ label: 'start', content: input.start.trim() });

  let files = Array.isArray(input.files) ? input.files : [];
  let hasPackageFile = false;
  for (let file of files) {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string')
      continue;
    if (file.path === 'package.json')
      hasPackageFile = true;
    entries.push({
      label: file.path,
      content: file.encoding === 'base64'
        ? `[base64]\n${String(file.content ?? '')}`
        : String(file.content ?? ''),
    });
  }

  if (files.length === 0 && typeof input.script === 'string')
    entries.push({ label: input.entry || 'index.mjs', content: input.script });

  if (!hasPackageFile && input.packageJson != null) {
    entries.push({
      label: 'package.json',
      content: typeof input.packageJson === 'string'
        ? input.packageJson
        : JSON.stringify(input.packageJson, null, 2),
    });
  }

  if (input.truncated === true && typeof input.preview === 'string')
    entries.push({ label: 'retained input preview', content: input.preview });

  return entries;
}
