'use strict';

// A plugin that contributes a VIEW surface, so the browser spec can prove focus
// and selection survive the shell's empty-and-rebuild cycle (campaign P4).
//
// The surface id is deliberately not a core name (inbox/agents/teams are
// reserved), because a colliding id is refused at registration.

export function setup(provide) {
  provide(({ registerClientSurface, pluginName }) => {
    registerClientSurface('view', 'notes', {
      surfaceID: 'notes',
      tagName: 'kikx-focus-probe-view',
      moduleURL: '/api/v1/plugin-assets/' + pluginName + '/view.mjs',
    }, { pluginName });
  });
}
