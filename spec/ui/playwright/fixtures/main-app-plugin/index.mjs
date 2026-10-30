'use strict';

export function setup(provide) {
  provide(({ registerMainApp, pluginName }) => {
    registerMainApp('shell', {
      tagName: 'kikx-app',
      moduleURL: '/api/v1/plugin-assets/' + pluginName + '/app.mjs',
    }, { pluginName });
  });
}
