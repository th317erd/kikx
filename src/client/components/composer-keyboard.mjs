'use strict';

export function shouldSubmitComposerKey(event) {
  if (!event || event.key !== 'Enter')
    return false;

  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey)
    return false;

  return event.isComposing !== true;
}
