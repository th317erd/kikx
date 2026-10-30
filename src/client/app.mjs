'use strict';

import { selectMainAppDescriptor } from './components/frame-component-registry.mjs';

// The server's plugin inventory is read before the main application module is
// imported. A plugin may replace the shell by registering a `main-app` descriptor;
// when none is present, or the plugin module fails to define <kikx-app>, the
// built-in shell is the fallback. The <kikx-app> element in index.html is upgraded
// by whichever module defines the tag first.
async function boot() {
  let mainAppURL = '';
  try {
    let response = await fetch('/api/v1/client-components', { credentials: 'same-origin' });
    if (response.ok) {
      let body = await response.json().catch(() => null);
      mainAppURL = selectMainAppDescriptor(body?.data?.components || [])?.moduleURL || '';
    }
  } catch (_error) {
    mainAppURL = '';
  }

  if (mainAppURL) {
    try {
      await import(mainAppURL);
    } catch (error) {
      console.warn(`[kikx] plugin main app failed to load: ${error.message}`);
    }
  }

  if (!customElements.get('kikx-app'))
    await import('./components/kikx-app.mjs');
  await import('./components/kikx-typing-indicator.mjs');
}

boot().catch((error) => {
  console.error('[kikx] client boot failed', error);
});
