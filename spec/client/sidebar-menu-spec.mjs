'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SIDEBAR_MENU_STATE_KEY,
  SIDEBAR_MENU_ELEMENT_ID,
  closeSidebarMenu,
  isSidebarMenuOpen,
  openSidebarMenu,
  toggleSidebarMenu,
} from '../../src/client/components/sidebar-menu.mjs';

// The menu is transient UI state, but it must follow the state-integrity rule:
// live in app state (so a shell rebuild re-applies it), and flip WITHOUT a
// broad render (the shell class and aria-expanded are bound to the key).
function createStatefulApp(initial = false) {
  let writes = [];
  let state = new Proxy({ [SIDEBAR_MENU_STATE_KEY]: initial }, {
    set(target, key, value) {
      writes.push([ key, value ]);
      target[key] = value;
      return true;
    },
  });
  return {
    _state: state,
    renders: 0,
    _render() { this.renders++; },
    _requestRender() { this.renders++; },
    writes,
  };
}

test('the menu state key and element id are stable contracts', () => {
  assert.equal(SIDEBAR_MENU_STATE_KEY, 'sidebarMenuOpen');
  assert.equal(SIDEBAR_MENU_ELEMENT_ID, 'kikx-sidebar-menu');
});

test('toggle opens and closes without ever requesting a broad render', () => {
  let app = createStatefulApp();

  assert.equal(isSidebarMenuOpen(app), false);
  toggleSidebarMenu(app);
  assert.equal(isSidebarMenuOpen(app), true);

  toggleSidebarMenu(app);
  assert.equal(isSidebarMenuOpen(app), false);

  assert.equal(app.renders, 0, 'toggling the drawer must paint through bindings, not _render()');
});

test('closing an already-closed menu writes nothing (no render-loop churn)', () => {
  let app = createStatefulApp();
  let writesBefore = app.writes.length;

  closeSidebarMenu(app);
  assert.equal(app.writes.length, writesBefore, 'idempotent close must not assign the key');

  openSidebarMenu(app);
  openSidebarMenu(app);
  assert.equal(isSidebarMenuOpen(app), true);
  assert.equal(app.renders, 0);
});

test('the helpers no-op safely when there is no app or state', () => {
  assert.equal(isSidebarMenuOpen(null), false);
  assert.doesNotThrow(() => closeSidebarMenu(undefined));
  assert.doesNotThrow(() => toggleSidebarMenu({}));
});
