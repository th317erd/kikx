'use strict';

// The mobile workspace menu (classic hamburger + floating popout).
//
// At <=960px (the width where .kikx-main stacks) -- and on short landscape
// heights, where the sidebar used to be hidden outright -- the sidebar is no
// longer a scrolling band above the session view. It is a drawer that slides
// in from the left over a dimming scrim, opened by the hamburger in the
// topbar's lead cluster.
//
// STATE, NOT DOM. `sidebarMenuOpen` lives in app state so a shell rebuild
// (navigation, event repaint) re-applies the open/closed class from state
// rather than losing it with the old nodes. Toggling must NOT request a broad
// render: the open class and the hamburger's aria-expanded are bound directly
// to the state key, so a menu flip paints without rebuilding the shell.

export const SIDEBAR_MENU_STATE_KEY = 'sidebarMenuOpen';
export const SIDEBAR_MENU_ELEMENT_ID = 'kikx-sidebar-menu';

export function isSidebarMenuOpen(app) {
  return app?._state?.[SIDEBAR_MENU_STATE_KEY] === true;
}

export function openSidebarMenu(app) {
  if (!app?._state || isSidebarMenuOpen(app))
    return;
  app._state[SIDEBAR_MENU_STATE_KEY] = true;
}

// Idempotent: clicking a sidebar row already navigates (and often repaints);
// this must not assign an unchanged value, because even a no-op write is work
// a busy render loop does not need.
export function closeSidebarMenu(app) {
  if (!app?._state || !isSidebarMenuOpen(app))
    return;
  app._state[SIDEBAR_MENU_STATE_KEY] = false;
}

export function toggleSidebarMenu(app) {
  if (isSidebarMenuOpen(app))
    closeSidebarMenu(app);
  else
    openSidebarMenu(app);
}
