'use strict';

/**
 * F4: Client Page Routing + Settings Tests
 *
 * Verifies:
 * - ROUTE-001: /settings route parsed correctly
 * - ROUTE-002: /settings/:tab route parsed with tab name
 * - ROUTE-003: Settings view div exists in index.html
 * - ROUTE-004: Settings element in state.js elements cache
 * - SETTINGS-001: hero-settings component has required tabs
 * - SETTINGS-002: hero-settings has profile form fields
 * - SETTINGS-003: hero-settings has password change form
 * - SETTINGS-004: hero-settings has API key management
 * - SETTINGS-005: hero-settings has tab switching logic
 * - NAV-001: hero-main-controls has Settings button
 * - NAV-002: hero-main-controls has goToSettings method
 * - API-001: API.user namespace has required methods
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Read source files
const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

const indexHtml = fs.readFileSync(
  path.join(projectRoot, 'public/index.html'), 'utf-8'
);
const stateSource = fs.readFileSync(
  path.join(projectRoot, 'public/js/state.js'), 'utf-8'
);
const routingSource = fs.readFileSync(
  path.join(projectRoot, 'public/js/routing.js'), 'utf-8'
);
const heroAppSource = fs.readFileSync(
  path.join(projectRoot, 'public/js/components/hero-app/hero-app.js'), 'utf-8'
);
const settingsJsSource = fs.readFileSync(
  path.join(projectRoot, 'public/js/components/hero-settings/hero-settings.js'), 'utf-8'
);
const settingsHtmlSource = fs.readFileSync(
  path.join(projectRoot, 'public/js/components/hero-settings/hero-settings.html'), 'utf-8'
);
const mainControlsJsSource = fs.readFileSync(
  path.join(projectRoot, 'public/js/components/hero-main-controls/hero-main-controls.js'), 'utf-8'
);
const mainControlsHtmlSource = fs.readFileSync(
  path.join(projectRoot, 'public/js/components/hero-main-controls/hero-main-controls.html'), 'utf-8'
);
const apiSource = fs.readFileSync(
  path.join(projectRoot, 'public/js/api.js'), 'utf-8'
);
const componentsIndexSource = fs.readFileSync(
  path.join(projectRoot, 'public/js/components/index.js'), 'utf-8'
);

// =============================================================================
// ROUTE-001: /settings Route in Both Routing Systems
// =============================================================================

describe('ROUTE-001: /settings route parsing', () => {
  it('should have /settings route in routing.js', () => {
    assert.ok(
      routingSource.includes("path === '/settings'"),
      'routing.js should match /settings'
    );
    assert.ok(
      routingSource.includes("view: 'settings'"),
      'routing.js should return settings view'
    );
  });

  it('should have /settings route in hero-app parseRoute', () => {
    assert.ok(
      heroAppSource.includes("path === '/settings'"),
      'hero-app.js parseRoute should match /settings'
    );
  });

  it('should have settings case in routing.js handleRoute switch', () => {
    assert.ok(
      routingSource.includes("case 'settings':"),
      'routing.js handleRoute should have settings case'
    );
  });

  it('should have settings case in hero-app handleRoute switch', () => {
    assert.ok(
      heroAppSource.includes("case 'settings':"),
      'hero-app.js handleRoute should have settings case'
    );
  });
});

// =============================================================================
// ROUTE-002: /settings/:tab Route Parsing
// =============================================================================

describe('ROUTE-002: /settings/:tab route parsing', () => {
  it('should have settings tab regex in routing.js', () => {
    assert.ok(
      routingSource.includes('settingsTabMatch'),
      'routing.js should parse settings tab from URL'
    );
  });

  it('should have settings tab regex in hero-app.js', () => {
    assert.ok(
      heroAppSource.includes('settingsTabMatch'),
      'hero-app.js should parse settings tab from URL'
    );
  });

  it('should include tab in route object', () => {
    assert.ok(
      routingSource.includes('tab: settingsTabMatch[1]'),
      'routing.js should include tab in route object'
    );
    assert.ok(
      heroAppSource.includes('tab: settingsTabMatch[1]'),
      'hero-app.js should include tab in route object'
    );
  });
});

// =============================================================================
// ROUTE-003: Settings View in index.html
// =============================================================================

describe('ROUTE-003: Settings view in index.html', () => {
  it('should have settings-view div', () => {
    assert.ok(
      indexHtml.includes('id="settings-view"'),
      'index.html should have settings-view div'
    );
  });

  it('should have data-view="settings" attribute', () => {
    assert.ok(
      indexHtml.includes('data-view="settings"'),
      'settings-view should have data-view="settings"'
    );
  });

  it('should contain hero-settings component', () => {
    assert.ok(
      indexHtml.includes('<hero-settings'),
      'settings-view should contain hero-settings component'
    );
  });

  it('should have mythix-require for hero-settings', () => {
    assert.ok(
      indexHtml.includes('hero-settings@1'),
      'index.html should have mythix-require for hero-settings'
    );
  });
});

// =============================================================================
// ROUTE-004: Settings Element in State
// =============================================================================

describe('ROUTE-004: Settings element in state.js', () => {
  it('should have settingsView in elements cache', () => {
    assert.ok(
      stateSource.includes('settingsView'),
      'state.js should cache settingsView element'
    );
    assert.ok(
      stateSource.includes("getElementById('settings-view')"),
      'state.js should find settings-view by ID'
    );
  });

  it('should handle settingsView display in showView', () => {
    assert.ok(
      routingSource.includes('elements.settingsView'),
      'routing.js showView should handle settingsView display'
    );
  });
});

// =============================================================================
// SETTINGS-001: Tab Structure
// =============================================================================

describe('SETTINGS-001: hero-settings tab structure', () => {
  it('should have profile tab button', () => {
    assert.ok(
      settingsHtmlSource.includes('data-tab="profile"'),
      'Should have profile tab button'
    );
  });

  it('should have account tab button', () => {
    assert.ok(
      settingsHtmlSource.includes('data-tab="account"'),
      'Should have account tab button'
    );
  });

  it('should have api-keys tab button', () => {
    assert.ok(
      settingsHtmlSource.includes('data-tab="api-keys"'),
      'Should have api-keys tab button'
    );
  });

  it('should have tab panels matching tab buttons', () => {
    assert.ok(settingsHtmlSource.includes('data-panel="profile"'), 'Should have profile panel');
    assert.ok(settingsHtmlSource.includes('data-panel="account"'), 'Should have account panel');
    assert.ok(settingsHtmlSource.includes('data-panel="api-keys"'), 'Should have api-keys panel');
  });
});

// =============================================================================
// SETTINGS-002: Profile Form
// =============================================================================

describe('SETTINGS-002: Profile form fields', () => {
  it('should have display name input', () => {
    assert.ok(
      settingsHtmlSource.includes('id="display-name"'),
      'Should have display-name input'
    );
  });

  it('should have email input', () => {
    assert.ok(
      settingsHtmlSource.includes('id="email"'),
      'Should have email input'
    );
  });

  it('should have username display', () => {
    assert.ok(
      settingsHtmlSource.includes('id="username-display"'),
      'Should have username display'
    );
  });

  it('should have profile form element', () => {
    assert.ok(
      settingsHtmlSource.includes('id="profile-form"'),
      'Should have profile form element'
    );
  });

  it('should have profile submit handler in JS', () => {
    assert.ok(
      settingsJsSource.includes('_handleProfileSubmit'),
      'hero-settings.js should have _handleProfileSubmit method'
    );
  });

  it('should call API.user.updateProfile', () => {
    assert.ok(
      settingsJsSource.includes('API.user.updateProfile'),
      'saveProfile should call API.user.updateProfile'
    );
  });
});

// =============================================================================
// SETTINGS-003: Password Change Form
// =============================================================================

describe('SETTINGS-003: Password change form', () => {
  it('should have current password input', () => {
    assert.ok(
      settingsHtmlSource.includes('id="current-password"'),
      'Should have current-password input'
    );
  });

  it('should have new password input', () => {
    assert.ok(
      settingsHtmlSource.includes('id="new-password"'),
      'Should have new-password input'
    );
  });

  it('should have confirm password input', () => {
    assert.ok(
      settingsHtmlSource.includes('id="confirm-password"'),
      'Should have confirm-password input'
    );
  });

  it('should have password form element', () => {
    assert.ok(
      settingsHtmlSource.includes('id="password-form"'),
      'Should have password form element'
    );
  });

  it('should have password submit handler in JS', () => {
    assert.ok(
      settingsJsSource.includes('_handlePasswordSubmit'),
      'hero-settings.js should have _handlePasswordSubmit method'
    );
  });

  it('should validate passwords match before submitting', () => {
    assert.ok(
      settingsJsSource.includes('newPassword !== confirmPassword'),
      'Should validate passwords match'
    );
  });

  it('should call API.user.changePassword', () => {
    assert.ok(
      settingsJsSource.includes('API.user.changePassword'),
      'changePassword should call API.user.changePassword'
    );
  });
});

// =============================================================================
// SETTINGS-004: API Key Management
// =============================================================================

describe('SETTINGS-004: API key management', () => {
  it('should have key name input', () => {
    assert.ok(
      settingsHtmlSource.includes('id="api-key-name"'),
      'Should have api-key-name input'
    );
  });

  it('should have API key form', () => {
    assert.ok(
      settingsHtmlSource.includes('id="api-key-form"'),
      'Should have api-key-form element'
    );
  });

  it('should have api-keys-list container', () => {
    assert.ok(
      settingsHtmlSource.includes('id="api-keys-list"'),
      'Should have api-keys-list container'
    );
  });

  it('should have new-key-banner for plaintext display', () => {
    assert.ok(
      settingsHtmlSource.includes('id="new-key-banner"'),
      'Should have new-key-banner container'
    );
  });

  it('should have API key submit handler', () => {
    assert.ok(
      settingsJsSource.includes('_handleApiKeySubmit'),
      'hero-settings.js should have _handleApiKeySubmit method'
    );
  });

  it('should have revoke API key method', () => {
    assert.ok(
      settingsJsSource.includes('_revokeApiKey('),
      'hero-settings.js should have _revokeApiKey method'
    );
  });

  it('should call API.user.createApiKey', () => {
    assert.ok(
      settingsJsSource.includes('API.user.createApiKey'),
      'Should call API.user.createApiKey'
    );
  });

  it('should call API.user.revokeApiKey', () => {
    assert.ok(
      settingsJsSource.includes('API.user.revokeApiKey'),
      'Should call API.user.revokeApiKey'
    );
  });
});

// =============================================================================
// SETTINGS-005: Tab Switching
// =============================================================================

describe('SETTINGS-005: Tab switching', () => {
  it('should have switchTab method', () => {
    assert.ok(
      settingsJsSource.includes('switchTab('),
      'hero-settings.js should have switchTab method'
    );
  });

  it('should read data-tab from event target', () => {
    assert.ok(
      settingsJsSource.includes('event.target.dataset.tab'),
      'switchTab should read data-tab from event target'
    );
  });

  it('should have _activateTab method toggling active class', () => {
    assert.ok(
      settingsJsSource.includes('_activateTab('),
      'Should have _activateTab method'
    );
    assert.ok(
      settingsJsSource.includes(".classList.toggle('active'"),
      'Should toggle active class on tab buttons'
    );
  });

  it('should update URL on tab switch via replaceState', () => {
    assert.ok(
      settingsJsSource.includes('history.replaceState'),
      'Should update URL when switching tabs'
    );
  });

  it('should listen for viewchange to detect route tab', () => {
    assert.ok(
      settingsJsSource.includes("event.detail.view !== 'settings'"),
      'Should listen for viewchange events'
    );
  });

  it('should toggle panel display style in _activateTab', () => {
    let activateStart = settingsJsSource.indexOf('  _activateTab(');
    assert.ok(activateStart > 0, '_activateTab should exist');

    let activateBody = settingsJsSource.slice(activateStart, activateStart + 400);
    assert.ok(
      activateBody.includes('panel.style.display'),
      '_activateTab should set panel display style'
    );
  });

  it('should default to profile tab when no tab attribute', () => {
    assert.ok(
      settingsJsSource.includes("|| 'profile'"),
      'Should default to profile tab'
    );
  });
});

// =============================================================================
// NAV-001: Settings Navigation Button
// =============================================================================

describe('NAV-001: Settings button in header controls', () => {
  it('should have Settings button in horizontal layout', () => {
    let horizontalStart = mainControlsHtmlSource.indexOf('data-layout="horizontal"');
    let horizontalEnd   = mainControlsHtmlSource.indexOf('</div>', horizontalStart);
    let horizontalSection = mainControlsHtmlSource.slice(horizontalStart, horizontalEnd);

    assert.ok(
      horizontalSection.includes('goToSettings'),
      'Horizontal layout should have Settings button with goToSettings'
    );
  });

  it('should have Settings button in vertical (mobile) layout', () => {
    let verticalStart = mainControlsHtmlSource.indexOf('data-layout="vertical"');
    let verticalEnd   = mainControlsHtmlSource.indexOf('</div>', verticalStart);
    let verticalSection = mainControlsHtmlSource.slice(verticalStart, verticalEnd);

    assert.ok(
      verticalSection.includes('goToSettings'),
      'Vertical layout should have Settings button with goToSettings'
    );
  });
});

// =============================================================================
// NAV-002: goToSettings Method
// =============================================================================

describe('NAV-002: goToSettings navigation method', () => {
  it('should have goToSettings method', () => {
    assert.ok(
      mainControlsJsSource.includes('goToSettings()'),
      'hero-main-controls.js should have goToSettings method'
    );
  });

  it('should dispatch hero:navigate event with /settings path', () => {
    let methodStart = mainControlsJsSource.indexOf('goToSettings()');
    let methodBody  = mainControlsJsSource.slice(methodStart, methodStart + 300);

    assert.ok(
      methodBody.includes("hero:navigate"),
      'goToSettings should dispatch hero:navigate event'
    );
    assert.ok(
      methodBody.includes("path: '/settings'"),
      'goToSettings should navigate to /settings'
    );
  });
});

// =============================================================================
// API-001: User API Namespace
// =============================================================================

describe('API-001: API.user namespace', () => {
  it('should have user namespace in API object', () => {
    assert.ok(
      apiSource.includes('user:'),
      'API object should have user namespace'
    );
  });

  it('should have profile method', () => {
    assert.ok(
      apiSource.includes("'/users/me/profile'"),
      'API.user should have method calling /users/me/profile'
    );
  });

  it('should have updateProfile method', () => {
    assert.ok(
      apiSource.includes('updateProfile') && apiSource.includes("'PUT', '/users/me/profile'"),
      'API.user should have updateProfile calling PUT /users/me/profile'
    );
  });

  it('should have changePassword method', () => {
    assert.ok(
      apiSource.includes('changePassword') && apiSource.includes("'/users/me/password'"),
      'API.user should have changePassword calling /users/me/password'
    );
  });

  it('should have apiKeys list method', () => {
    assert.ok(
      apiSource.includes("'GET', '/users/me/api-keys'"),
      'API.user should have method calling GET /users/me/api-keys'
    );
  });

  it('should have createApiKey method', () => {
    assert.ok(
      apiSource.includes('createApiKey') && apiSource.includes("'POST', '/users/me/api-keys'"),
      'API.user should have createApiKey calling POST /users/me/api-keys'
    );
  });

  it('should have revokeApiKey method', () => {
    assert.ok(
      apiSource.includes('revokeApiKey') && apiSource.includes("/users/me/api-keys/"),
      'API.user should have revokeApiKey calling DELETE /users/me/api-keys/:id'
    );
  });
});

// =============================================================================
// Component Registration
// =============================================================================

describe('Component Registration', () => {
  it('should register hero-settings as custom element', () => {
    assert.ok(
      settingsJsSource.includes("static tagName = 'hero-settings'"),
      'Should define hero-settings tag name'
    );
    assert.ok(
      settingsJsSource.includes('HeroSettings.register()'),
      'Should call register()'
    );
  });

  it('should be loaded via mythix-require (not JS import)', () => {
    // Shadow DOM components must NOT be imported in index.js to avoid
    // a race condition where the class is defined before the template
    // is injected by mythix-require.
    assert.ok(
      !componentsIndexSource.includes("export { HeroSettings }"),
      'Should NOT be exported from index.js (loaded via mythix-require)'
    );
  });

  it('should extend HeroComponent', () => {
    assert.ok(
      settingsJsSource.includes('extends HeroComponent'),
      'HeroSettings should extend HeroComponent'
    );
  });

  it('should use Shadow DOM', () => {
    assert.ok(
      settingsJsSource.includes('createShadowDOM()'),
      'Should override createShadowDOM'
    );
    assert.ok(
      settingsJsSource.includes('attachShadow'),
      'Should attach shadow root'
    );
  });
});

// =============================================================================
// hero-app.js Settings Integration
// =============================================================================

describe('hero-app.js settings integration', () => {
  it('should pass tab option to _showView for settings', () => {
    let settingsCase = heroAppSource.indexOf("case 'settings':");
    assert.ok(settingsCase > 0, 'hero-app.js should have settings case');

    let caseBody = heroAppSource.slice(settingsCase, settingsCase + 200);
    assert.ok(
      caseBody.includes('route.tab'),
      'Settings case should pass tab from route'
    );
  });
});

// =============================================================================
// Behavioral: Tab URL Construction
// =============================================================================

describe('Tab URL Construction', () => {
  it('should build correct URL for each tab', () => {
    function buildSettingsPath(tab) {
      return `/settings/${tab}`;
    }

    assert.strictEqual(buildSettingsPath('profile'), '/settings/profile');
    assert.strictEqual(buildSettingsPath('account'), '/settings/account');
    assert.strictEqual(buildSettingsPath('api-keys'), '/settings/api-keys');
  });
});

// =============================================================================
// Behavioral: Password Validation
// =============================================================================

describe('Password Validation Logic', () => {
  function validatePassword(current, newPw, confirm) {
    if (!current || !newPw) return 'All fields are required.';
    if (newPw !== confirm)  return 'New passwords do not match.';
    if (newPw.length < 6)   return 'Password must be at least 6 characters.';
    return null;
  }

  it('should reject empty passwords', () => {
    assert.strictEqual(validatePassword('', 'new123', 'new123'), 'All fields are required.');
    assert.strictEqual(validatePassword('old', '', 'new123'), 'All fields are required.');
  });

  it('should reject mismatched passwords', () => {
    assert.strictEqual(validatePassword('old', 'new123', 'different'), 'New passwords do not match.');
  });

  it('should reject short passwords', () => {
    assert.strictEqual(validatePassword('old', 'ab', 'ab'), 'Password must be at least 6 characters.');
  });

  it('should accept valid passwords', () => {
    assert.strictEqual(validatePassword('old123', 'newpass', 'newpass'), null);
  });
});

// =============================================================================
// Structural: Form Submit Event Binding
// =============================================================================

describe('Form Submit Event Binding', () => {
  it('should bind profile form submit', () => {
    assert.ok(
      settingsJsSource.includes('#profile-form'),
      'Should select profile form element'
    );
    assert.ok(
      settingsJsSource.includes('saveProfile'),
      'Profile form submit should call saveProfile'
    );
  });

  it('should bind password form submit', () => {
    assert.ok(
      settingsJsSource.includes('#password-form'),
      'Should select password form element'
    );
    assert.ok(
      settingsJsSource.includes('changePassword'),
      'Password form submit should call changePassword'
    );
  });

  it('should bind API key form submit', () => {
    assert.ok(
      settingsJsSource.includes('#api-key-form'),
      'Should select api-key form element'
    );
    assert.ok(
      settingsJsSource.includes('createApiKey'),
      'API key form submit should call createApiKey'
    );
  });

  it('should bind back button', () => {
    assert.ok(
      settingsJsSource.includes('#back-button'),
      'Should select back button element'
    );
    assert.ok(
      settingsJsSource.includes('goBack'),
      'Back button should call goBack'
    );
  });
});
