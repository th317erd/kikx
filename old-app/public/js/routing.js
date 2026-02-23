'use strict';

// ============================================================================
// Routing
// ============================================================================

/**
 * Wait for custom elements to be defined.
 */
async function waitForComponents() {
  let components = ['hero-header', 'hero-sessions-list', 'hero-input'];
  await Promise.all(components.map((name) => customElements.whenDefined(name)));
}

function getRoute() {
  let path = window.location.pathname;

  // Strip base path
  if (path.startsWith(BASE_PATH))
    path = path.slice(BASE_PATH.length) || '/';

  if (path === '/login')
    return { view: 'login' };

  if (path === '/' || path === '')
    return { view: 'sessions' };

  if (path === '/settings')
    return { view: 'settings' };

  let settingsTabMatch = path.match(/^\/settings\/([\w-]+)$/);

  if (settingsTabMatch)
    return { view: 'settings', tab: settingsTabMatch[1] };

  let sessionMatch = path.match(/^\/sessions\/(\d+)$/);

  if (sessionMatch)
    return { view: 'chat', sessionId: parseInt(sessionMatch[1], 10) };

  // Unknown route, default to sessions
  return { view: 'sessions' };
}

function navigate(path) {
  window.history.pushState({}, '', BASE_PATH + path);
  handleRoute();
}

async function handleRoute() {
  let route = getRoute();

  // Wait for components to be ready before rendering views
  await waitForComponents();

  // Check auth for non-login routes
  if (route.view !== 'login') {
    try {
      let me     = await fetchMe();
      state.user = me;
      connectWebSocket();
      // Load global usage when authenticated
      loadGlobalUsage();
    } catch (error) {
      // Not authenticated, show login
      disconnectWebSocket();
      showView('login');
      return;
    }
  }

  switch (route.view) {
    case 'login':
      disconnectWebSocket();
      showView('login');
      break;

    case 'sessions':
      await loadSessions();
      showView('sessions');
      break;

    case 'chat':
      await loadSession(route.sessionId);
      showView('chat');
      break;

    case 'settings':
      showView('settings', route);
      break;

    default:
      showView('sessions');
  }
}

// ============================================================================
// Views
// ============================================================================

function showView(viewName, route) {
  elements.loginView.style.display    = (viewName === 'login') ? 'flex' : 'none';
  elements.sessionsView.style.display = (viewName === 'sessions') ? 'flex' : 'none';
  elements.chatView.style.display     = (viewName === 'chat') ? 'flex' : 'none';

  if (elements.settingsView)
    elements.settingsView.style.display = (viewName === 'settings') ? 'flex' : 'none';

  // Pass tab to hero-settings component when settings view is active
  if (viewName === 'settings') {
    let settingsComponent = document.getElementById('settings');
    if (settingsComponent)
      settingsComponent.tab = route?.tab || 'profile';
  }

  // Notify hero-header components of view change
  document.dispatchEvent(new CustomEvent('viewchange', {
    detail: { view: viewName, tab: route?.tab },
  }));
}
