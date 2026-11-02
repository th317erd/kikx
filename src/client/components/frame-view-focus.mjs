'use strict';

// Focus ownership for plugin view surfaces during a shell repaint.

export function viewSurfaceHost(app) {
  return app?.querySelector?.("[data-kikx-view-surface]") || null;
}

export function captureViewSurfaceFocus(app) {
  let active = document.activeElement;
  if (!active || active === document.body)
    return null;

  let host = viewSurfaceHost(app);
  if (!host || !host.contains(active))
    return null;

  let key = active.getAttribute?.("data-kikx-focus-key") || "";
  if (!key)
    return null;

  let snapshot = { surfaceID: host.getAttribute("data-kikx-view-surface") || null, key };

  // A caret exists only on controls that model selection. Reading it off anything
  // else yields undefined, and restoring a caret onto a non-text control is a no-op
  // at best, so the presence of the fields is recorded rather than assumed.
  if (typeof active.selectionStart === "number") {
    snapshot.selectionStart = active.selectionStart;
    snapshot.selectionEnd = typeof active.selectionEnd === "number" ? active.selectionEnd : active.selectionStart;
    snapshot.selectionDirection = active.selectionDirection || "none";
  }

  return snapshot;
}

export function restoreViewSurfaceFocus(app, snapshot) {
  if (!snapshot || !snapshot.key)
    return false;

  let host = viewSurfaceHost(app);
  if (!host)
    return false;

  // The plugin replaced its surface on reload: restoring a key into a different view
  // would put the caret somewhere the user never was.
  if (snapshot.surfaceID && host.getAttribute("data-kikx-view-surface") !== snapshot.surfaceID)
    return false;

  // Attribute comparison, not a selector built from the key: the key is arbitrary
  // plugin-authored text, and interpolating it into a selector would make the plugin
  // able to choose what the shell queries -- including a throwing selector.
  let target = null;
  for (let candidate of host.querySelectorAll("[data-kikx-focus-key]")) {
    if (candidate.getAttribute("data-kikx-focus-key") === snapshot.key) {
      target = candidate;
      break;
    }
  }
  if (!target || typeof target.focus !== "function")
    return false;

  // preventScroll: the frame-list placement above already decided where the page
  // sits; a browser scroll-into-view here would silently override it.
  target.focus({ preventScroll: true });

  if (typeof target.setSelectionRange === "function"
    && Number.isInteger(snapshot.selectionStart)
    && Number.isInteger(snapshot.selectionEnd)) {
    let max = typeof target.value === "string" ? target.value.length : null;
    let clamp = (index) => (max === null ? index : Math.min(index, max));
    target.setSelectionRange(clamp(snapshot.selectionStart), clamp(snapshot.selectionEnd), snapshot.selectionDirection || "none");
  }

  return document.activeElement === target;
}

// Repaint the pinned thinking rack from the session's live frames. Cheap: it
// only updates the per-agent panels, never the thread or the whole shell.
