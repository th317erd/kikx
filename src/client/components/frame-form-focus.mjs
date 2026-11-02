'use strict';

// Focus/caret preservation for shell repaints. Kept separate from the scroll
// controller so form-field identity rules do not inflate the scroll module.

export function captureFormFocus(app) {
  let active = globalThis.document?.activeElement;
  if (!active || active === globalThis.document?.body)
    return null;
  if (!isFormControl(active))
    return null;
  if (active.matches?.('textarea[name="message"], .kikx-session-search__input'))
    return null;

  let name = active.getAttribute?.('name') || '';
  let id = active.getAttribute?.('id') || '';
  let type = active.getAttribute?.('type') || '';
  let selector = active.localName || active.tagName?.toLowerCase?.() || 'input';
  let candidates = matchingFormControls(app, { tag: selector, name, id, type });
  let index = Math.max(0, candidates.indexOf(active));
  return {
    tag: selector,
    name,
    id,
    type,
    index,
    value: typeof active.value === 'string' ? active.value : undefined,
    checked: typeof active.checked === 'boolean' ? active.checked : undefined,
    selectionStart: supportsSelection(active) ? active.selectionStart : null,
    selectionEnd: supportsSelection(active) ? active.selectionEnd : null,
    selectionDirection: supportsSelection(active) ? active.selectionDirection : 'none',
  };
}

export function restoreFormFocus(app, snapshot) {
  if (!snapshot || typeof app?.querySelectorAll !== 'function')
    return false;

  let candidates = matchingFormControls(app, snapshot);
  if (candidates.length === 0 && globalThis.document?.querySelectorAll)
    candidates = matchingFormControls(globalThis.document, snapshot);
  let control = candidates[Math.min(snapshot.index || 0, Math.max(0, candidates.length - 1))];
  if (!control)
    return false;

  if (snapshot.value !== undefined && typeof control.value === 'string' && control.value !== snapshot.value) {
    try {
      control.value = snapshot.value;
    } catch (_error) {}
  }
  if (snapshot.checked !== undefined && typeof control.checked === 'boolean')
    control.checked = snapshot.checked;

  // Modal components focus their first control in a requestAnimationFrame
  // during connect. Restore this field after that frame so a rebuilt account or
  // agent editor does not steal focus back to its close button.
  let focus = () => {
    if (!control.isConnected)
      return;
    let active = globalThis.document?.activeElement;
    let modal = control.closest?.('aeor-modal');
    // Do not steal focus from a control the user clicked after the render. A
    // modal's own close-button autofocus is inside the same modal, so the
    // captured field can still reclaim it.
    if (active && active !== globalThis.document?.body && active !== control && !modal?.contains?.(active))
      return;
    control.focus?.({ preventScroll: true });
    if (supportsSelection(control)
      && Number.isInteger(snapshot.selectionStart)
      && Number.isInteger(snapshot.selectionEnd)) {
      try {
        let max = control.value.length;
        control.setSelectionRange(
          Math.min(snapshot.selectionStart, max),
          Math.min(snapshot.selectionEnd, max),
          snapshot.selectionDirection || 'none',
        );
      } catch (_error) {}
    }
  };
  if (typeof globalThis.setTimeout === 'function') {
    // A rebuilt modal runs its own first-focus callback in requestAnimationFrame.
    // Restore after that callback; a short timer is more reliable than racing
    // modal lifecycle scheduling and does not steal focus after the next click.
    globalThis.setTimeout(focus, 40);
  } else {
    queueMicrotask(focus);
  }
  return true;
}

function matchingFormControls(app, snapshot) {
  let tag = snapshot.tag || 'input';
  let selector = tag;
  if (snapshot.id)
    selector += `#${escapeSelector(snapshot.id)}`;
  else if (snapshot.name)
    selector += `[name="${escapeSelectorValue(snapshot.name)}"]`;

  try {
    return [ ...app.querySelectorAll(selector) ].filter((control) => (
      control.isConnected
      && (control.getClientRects?.().length ?? 1) > 0
      && control.localName === tag
      && (!snapshot.name || control.getAttribute('name') === snapshot.name)
      && (!snapshot.type || control.getAttribute('type') === snapshot.type)
    ));
  } catch (_error) {
    return [];
  }
}

function isFormControl(element) {
  return element?.matches?.('input, textarea, select');
}

function supportsSelection(element) {
  return typeof element?.setSelectionRange === 'function'
    && typeof element?.selectionStart === 'number';
}

function escapeSelector(value) {
  return globalThis.CSS?.escape
    ? globalThis.CSS.escape(String(value))
    : String(value).replace(/["\\]/g, '\\$&');
}

function escapeSelectorValue(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}
