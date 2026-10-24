'use strict';

export function shouldSubmitComposerKey(event) {
  if (!event || event.key !== 'Enter')
    return false;

  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey)
    return false;

  return event.isComposing !== true;
}

// Enter submits; Shift/Alt/Ctrl/Meta+Enter insert a newline. Bind this to a
// textarea that also lives in a <form>: without it the textarea's HTML default
// (Enter = newline) silently disagrees with the message composer beside it,
// which is exactly the report from the owner.
//
// Returns the listener so a caller that rebuilds a subtree can remove it.
export function bindComposerSubmitKeys(node, submit) {
  if (!node || typeof node.addEventListener !== 'function' || typeof submit !== 'function')
    return null;

  let listener = (event) => {
    if (!shouldSubmitComposerKey(event))
      return;

    // Claim the key, or the textarea inserts a newline as well as sending.
    if (typeof event.preventDefault === 'function')
      event.preventDefault();

    submit(event);
  };

  node.addEventListener('keydown', listener);
  return listener;
}
