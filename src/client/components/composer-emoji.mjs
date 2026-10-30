// This module deliberately does NOT export an `onComposerKeydown`. The real
// handler lives in `kikx-composer.mjs`, which imports `shouldSubmitComposerKey`
// from `composer-keyboard.mjs` and delegates to `handleEmojiPickerKeydown`
// first. An earlier draft of this file exported its own copy of that handler
// and called `shouldSubmitComposerKey` without importing it — a loaded gun
// rather than a live bug, since nothing referenced the export, but any future
// `import { onComposerKeydown } from './composer-emoji.mjs'` would have thrown
// a ReferenceError on the first keypress. `node --check` cannot catch that: it
// does not resolve free identifiers.

// The emoji picker claims the keys that would otherwise do something else:
// Enter would submit the half-written message, and ArrowUp/ArrowDown already
// drive message history, so the picker must win while it is open or typing
// `:sm` and pressing Enter sends the literal text `:sm`.
//
// Returns true when the event was consumed.
export function handleEmojiPickerKeydown(app, event) {
  let picker = app?._emojiPicker;
  if (!picker || !picker.isOpen)
    return false;

  let key = event?.key;
  if (key === 'Escape') {
    event.preventDefault?.();
    event.stopPropagation?.();
    picker.close();
    return true;
  }

  if (key === 'ArrowDown' || key === 'ArrowUp') {
    event.preventDefault?.();
    event.stopPropagation?.();
    picker.moveSelection(key === 'ArrowDown' ? 1 : -1);
    return true;
  }

  if (key === 'Enter' || key === 'Tab') {
    // Shift+Enter still means "newline" in the composer, so let it through and
    // close the picker rather than trapping the user.
    if (event?.shiftKey || event?.altKey || event?.ctrlKey || event?.metaKey) {
      picker.close();
      return false;
    }
    if (!picker.select())
      return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    return true;
  }

  return false;
}

// Called from the app's input path on every keystroke.
export function updateEmojiPickerFromComposer(app, event) {
  let picker = app?._emojiPicker;
  if (!picker)
    return false;

  let textarea = event?.target;
  if (!textarea)
    return false;

  let caret = typeof textarea.selectionStart === 'number'
    ? textarea.selectionStart
    : textarea.value.length;
  return picker.update(textarea.value, caret);
}
