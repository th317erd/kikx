'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setupDOM, teardownDOM, getDocument } from './jsdom-helper.mjs';

// Set up JSDOM ONCE before all tests. Web component definitions are cached by
// Node's module system, so customElements.define() only fires on first import.
// Creating a new JSDOM per test would lose those definitions.

let i18n;
let store;
let router;
let api;
let en;

before(async () => {
  setupDOM();

  i18n   = await import('../../src/client/lib/i18n.mjs');
  en     = (await import('../../src/client/lib/locales/en.mjs')).default;
  store  = await import('../../src/client/lib/store.mjs');
  router = await import('../../src/client/lib/router.mjs');
  api    = await import('../../src/client/lib/api.mjs');

  i18n.setLocale(en, 'en');

  // Import all components to register custom elements
  await import('../../src/client/components/kikx-user-avatar/kikx-user-avatar.mjs');
  await import('../../src/client/components/kikx-friends-list/kikx-friends-list.mjs');
  await import('../../src/client/components/kikx-add-friend-modal/kikx-add-friend-modal.mjs');
  await import('../../src/client/components/kikx-login-page/kikx-login-page.mjs');
  await import('../../src/client/components/kikx-top-bar/kikx-top-bar.mjs');
  await import('../../src/client/components/kikx-status-bar/kikx-status-bar.mjs');
  await import('../../src/client/components/kikx-settings-page/kikx-settings-page.mjs');
  await import('../../src/client/components/kikx-sidebar/kikx-sidebar.mjs');
});

after(() => {
  teardownDOM();
});

// Clean DOM body and reset state between tests
beforeEach(() => {
  let doc = getDocument();
  while (doc.body.firstChild)
    doc.body.removeChild(doc.body.firstChild);

  try { localStorage.clear(); } catch (_e) { /* ignore */ }
  router.reset();
  store.resetStore();
  i18n.setLocale(en, 'en');
});

// =============================================================================
// KikxLoginPage
// =============================================================================

describe('KikxLoginPage', () => {
  it('should render the login form with correct labels', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-login-page');
    doc.body.appendChild(page);

    let shadow       = page.shadowRoot;
    let title        = shadow.querySelector('.title');
    let subtitle     = shadow.querySelector('.subtitle');
    let submitButton = shadow.querySelector('.submit-button');

    assert.equal(title.textContent, 'Kikx');
    assert.equal(subtitle.textContent, en.login.subtitle);
    assert.equal(submitButton.textContent, 'Sign In');
  });

  it('should have "Sign In" as button text, NOT "Send Magic Link"', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-login-page');
    doc.body.appendChild(page);

    let submitButton = page.shadowRoot.querySelector('.submit-button');
    assert.equal(submitButton.textContent, 'Sign In');
    assert.notEqual(submitButton.textContent, 'Send Magic Link');
  });

  it('should have password placeholder text from locale', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-login-page');
    doc.body.appendChild(page);

    let passwordInput = page.shadowRoot.querySelector('.password-input');
    assert.equal(passwordInput.placeholder, 'Password');
  });

  it('should have email placeholder text from locale', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-login-page');
    doc.body.appendChild(page);

    let emailInput = page.shadowRoot.querySelector('.email-input');
    assert.equal(emailInput.placeholder, en.login.emailPlaceholder);
  });

  it('should include box-sizing: border-box in form-input styles', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-login-page');
    doc.body.appendChild(page);

    let styleElement = page.shadowRoot.querySelector('style');
    let cssText      = styleElement.textContent;

    assert.ok(cssText.includes('box-sizing: border-box'), 'CSS should contain box-sizing: border-box');
  });

  it('should include box-sizing: border-box in submit-button styles', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-login-page');
    doc.body.appendChild(page);

    let styleElement = page.shadowRoot.querySelector('style');
    let cssText      = styleElement.textContent;

    // Verify both .form-input and .submit-button have box-sizing
    let formInputSection   = cssText.split('.form-input')[1];
    let submitButtonSection = cssText.split('.submit-button')[1];

    assert.ok(formInputSection.includes('box-sizing'), '.form-input should have box-sizing');
    assert.ok(submitButtonSection.includes('box-sizing'), '.submit-button should have box-sizing');
  });

  it('should show validation error when email is empty on submit', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-login-page');
    doc.body.appendChild(page);

    let form          = page.shadowRoot.querySelector('form');
    let statusMessage = page.shadowRoot.querySelector('.status-message');

    form.dispatchEvent(new globalThis.Event('submit', { cancelable: true }));

    assert.ok(statusMessage.classList.contains('visible'));
    assert.ok(statusMessage.classList.contains('error'));
    assert.equal(statusMessage.textContent, en.login.error.emailRequired);
  });

  it('should show validation error when password is empty on submit', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-login-page');
    doc.body.appendChild(page);

    let emailInput = page.shadowRoot.querySelector('.email-input');
    emailInput.value = 'test@example.com';

    let form          = page.shadowRoot.querySelector('form');
    let statusMessage = page.shadowRoot.querySelector('.status-message');

    form.dispatchEvent(new globalThis.Event('submit', { cancelable: true }));

    assert.ok(statusMessage.classList.contains('visible'));
    assert.ok(statusMessage.classList.contains('error'));
    assert.equal(statusMessage.textContent, 'Password is required.');
  });

  it('should have password input with type="password"', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-login-page');
    doc.body.appendChild(page);

    let passwordInput = page.shadowRoot.querySelector('.password-input');
    assert.equal(passwordInput.type, 'password');
  });
});

// =============================================================================
// KikxTopBar (redesigned: avatar button, no agents/new-session/logout buttons)
// =============================================================================

describe('KikxTopBar', () => {
  it('should NOT have agents, new-session, or logout buttons', () => {
    let doc = getDocument();
    let bar = doc.createElement('kikx-top-bar');
    doc.body.appendChild(bar);

    assert.equal(bar.shadowRoot.querySelector('.agents-button'), null, 'No agents button');
    assert.equal(bar.shadowRoot.querySelector('.new-session-button'), null, 'No new-session button');
    assert.equal(bar.shadowRoot.querySelector('.logout-button'), null, 'No logout button');
  });

  it('should render an avatar button instead of settings gear', () => {
    let doc = getDocument();
    let bar = doc.createElement('kikx-top-bar');
    doc.body.appendChild(bar);

    let avatarButton = bar.shadowRoot.querySelector('.avatar-button');
    assert.ok(avatarButton, 'Avatar button should exist');

    let avatar = bar.shadowRoot.querySelector('kikx-user-avatar');
    assert.ok(avatar, 'Should contain a kikx-user-avatar element');
  });

  it('should have exactly 1 button in right-group (avatar)', () => {
    let doc = getDocument();
    let bar = doc.createElement('kikx-top-bar');
    doc.body.appendChild(bar);

    let rightGroup = bar.shadowRoot.querySelector('.right-group');
    let buttons    = rightGroup.querySelectorAll('button');
    assert.equal(buttons.length, 1, 'Should only have avatar button');
  });

  it('should render back button with correct text', () => {
    let doc = getDocument();
    let bar = doc.createElement('kikx-top-bar');
    doc.body.appendChild(bar);

    let backButton = bar.shadowRoot.querySelector('.back-button');
    assert.ok(backButton, 'Back button should exist');
    assert.equal(backButton.textContent, '\u2190');
  });

  it('should hide back button when hide-back attribute is set', () => {
    let doc = getDocument();
    let bar = doc.createElement('kikx-top-bar');
    bar.setAttribute('hide-back', '');
    doc.body.appendChild(bar);

    // The CSS rule :host([hide-back]) .back-button { display: none } is applied
    // In JSDOM we verify the attribute is present (CSS isn't computed)
    assert.ok(bar.hasAttribute('hide-back'), 'hide-back attribute should be set');
  });

  it('should show session name from attribute', () => {
    let doc = getDocument();
    let bar = doc.createElement('kikx-top-bar');
    bar.setAttribute('session-name', 'My Test Session');
    doc.body.appendChild(bar);

    let sessionName = bar.shadowRoot.querySelector('.session-name');
    assert.equal(sessionName.textContent, 'My Test Session');
  });

  it('should show application title when no session name set', () => {
    let doc = getDocument();
    let bar = doc.createElement('kikx-top-bar');
    doc.body.appendChild(bar);

    let sessionName = bar.shadowRoot.querySelector('.session-name');
    assert.equal(sessionName.textContent, 'Kikx');
  });

  it('should update session name when attribute changes', () => {
    let doc = getDocument();
    let bar = doc.createElement('kikx-top-bar');
    doc.body.appendChild(bar);

    bar.setAttribute('session-name', 'Updated Name');

    let sessionName = bar.shadowRoot.querySelector('.session-name');
    assert.equal(sessionName.textContent, 'Updated Name');
  });

  it('should update avatar attributes when user is in store', () => {
    store.profile.setUser({
      email:     'test@example.com',
      firstName: 'Test',
      lastName:  'User',
    }, 'token123');

    let doc = getDocument();
    let bar = doc.createElement('kikx-top-bar');
    doc.body.appendChild(bar);

    let avatar = bar.shadowRoot.querySelector('kikx-user-avatar');
    assert.equal(avatar.getAttribute('email'), 'test@example.com');
    assert.equal(avatar.getAttribute('first-name'), 'Test');
    assert.equal(avatar.getAttribute('last-name'), 'User');
  });
});

// =============================================================================
// KikxUserAvatar
// =============================================================================

describe('KikxUserAvatar', () => {
  it('should render with default size of 32px', () => {
    let doc    = getDocument();
    let avatar = doc.createElement('kikx-user-avatar');
    doc.body.appendChild(avatar);

    let container = avatar.shadowRoot.querySelector('.avatar');
    assert.equal(container.style.width, '32px');
    assert.equal(container.style.height, '32px');
  });

  it('should render with custom size', () => {
    let doc    = getDocument();
    let avatar = doc.createElement('kikx-user-avatar');
    avatar.setAttribute('size', '64');
    doc.body.appendChild(avatar);

    let container = avatar.shadowRoot.querySelector('.avatar');
    assert.equal(container.style.width, '64px');
    assert.equal(container.style.height, '64px');
  });

  it('should show initials when no email or avatar-data', () => {
    let doc    = getDocument();
    let avatar = doc.createElement('kikx-user-avatar');
    avatar.setAttribute('first-name', 'John');
    avatar.setAttribute('last-name', 'Doe');
    doc.body.appendChild(avatar);

    let initials = avatar.shadowRoot.querySelector('.initials');
    assert.equal(initials.textContent, 'JD');
    assert.notEqual(initials.style.display, 'none');
  });

  it('should show first 2 chars of email when no names set', () => {
    let doc    = getDocument();
    let avatar = doc.createElement('kikx-user-avatar');
    avatar.setAttribute('email', 'alice@example.com');
    doc.body.appendChild(avatar);

    let initials = avatar.shadowRoot.querySelector('.initials');
    // Gravatar img will try to load, but initials are there as fallback
    assert.equal(initials.textContent, 'AL');
  });

  it('should show ?? when nothing is set', () => {
    let doc    = getDocument();
    let avatar = doc.createElement('kikx-user-avatar');
    doc.body.appendChild(avatar);

    let initials = avatar.shadowRoot.querySelector('.initials');
    assert.equal(initials.textContent, '??');
  });

  it('should set img src to base64 when avatar-data is set', () => {
    let doc    = getDocument();
    let avatar = doc.createElement('kikx-user-avatar');
    avatar.setAttribute('avatar-data', 'data:image/png;base64,AAAA');
    doc.body.appendChild(avatar);

    let img = avatar.shadowRoot.querySelector('.avatar-image');
    assert.equal(img.src, 'data:image/png;base64,AAAA');
    assert.equal(img.style.display, 'block');
  });

  it('should set img src to gravatar URL when email is set', () => {
    let doc    = getDocument();
    let avatar = doc.createElement('kikx-user-avatar');
    avatar.setAttribute('email', 'test@example.com');
    doc.body.appendChild(avatar);

    let img = avatar.shadowRoot.querySelector('.avatar-image');
    assert.ok(img.src.includes('gravatar.com/avatar/'), 'Should use gravatar URL');
    assert.ok(img.src.includes('d=blank'), 'Should use blank fallback');
  });

  it('should fall back to initials on image error', () => {
    let doc    = getDocument();
    let avatar = doc.createElement('kikx-user-avatar');
    avatar.setAttribute('email', 'test@example.com');
    avatar.setAttribute('first-name', 'Test');
    avatar.setAttribute('last-name', 'User');
    doc.body.appendChild(avatar);

    let img = avatar.shadowRoot.querySelector('.avatar-image');
    // Simulate image load error
    img.dispatchEvent(new globalThis.Event('error'));

    assert.equal(img.style.display, 'none');
    let initials = avatar.shadowRoot.querySelector('.initials');
    assert.notEqual(initials.style.display, 'none');
    assert.equal(initials.textContent, 'TU');
  });
});

// =============================================================================
// KikxFriendsList
// =============================================================================

describe('KikxFriendsList', () => {
  it('should render empty message when no friends', () => {
    let doc  = getDocument();
    let list = doc.createElement('kikx-friends-list');
    doc.body.appendChild(list);

    let empty = list.shadowRoot.querySelector('.empty-message');
    assert.ok(empty, 'Empty message element should exist');
    assert.equal(empty.textContent, 'No friends yet.');
  });

  it('should render friend rows when friends are set', () => {
    let doc  = getDocument();
    let list = doc.createElement('kikx-friends-list');
    doc.body.appendChild(list);

    list.friends = [
      { id: '1', name: 'Agent One', type: 'agent' },
      { id: '2', name: 'Human Two', type: 'user' },
    ];

    let rows = list.shadowRoot.querySelectorAll('.friend-row');
    assert.equal(rows.length, 2);
  });

  it('should show agent badge for agent type friends', () => {
    let doc  = getDocument();
    let list = doc.createElement('kikx-friends-list');
    doc.body.appendChild(list);

    list.friends = [
      { id: '1', name: 'Agent One', type: 'agent' },
      { id: '2', name: 'Human Two', type: 'user' },
    ];

    let rows   = list.shadowRoot.querySelectorAll('.friend-row');
    let badge1 = rows[0].querySelector('.agent-badge');
    let badge2 = rows[1].querySelector('.agent-badge');

    assert.ok(badge1, 'Agent should have badge');
    assert.equal(badge1.textContent, 'AI');
    assert.equal(badge2, null, 'Human should not have badge');
  });

  it('should dispatch select-friend event on row click', () => {
    let doc  = getDocument();
    let list = doc.createElement('kikx-friends-list');
    doc.body.appendChild(list);

    list.friends = [
      { id: 'friend-1', name: 'Agent One', type: 'agent' },
    ];

    let detail = null;
    list.addEventListener('select-friend', (event) => { detail = event.detail; });

    let row = list.shadowRoot.querySelector('.friend-row');
    row.click();

    assert.ok(detail, 'Event should have been dispatched');
    assert.equal(detail.id, 'friend-1');
    assert.equal(detail.type, 'agent');
  });

  it('should include kikx-user-avatar in each row', () => {
    let doc  = getDocument();
    let list = doc.createElement('kikx-friends-list');
    doc.body.appendChild(list);

    list.friends = [
      { id: '1', name: 'Agent One', type: 'agent' },
    ];

    let row    = list.shadowRoot.querySelector('.friend-row');
    let avatar = row.querySelector('kikx-user-avatar');
    assert.ok(avatar, 'Row should contain avatar element');
    assert.equal(avatar.getAttribute('size'), '28');
  });
});

// =============================================================================
// KikxAddFriendModal
// =============================================================================

describe('KikxAddFriendModal', () => {
  it('should show type selection step by default', () => {
    let doc    = getDocument();
    let wizard = doc.createElement('kikx-add-friend-modal');
    doc.body.appendChild(wizard);

    let typeStep  = wizard.shadowRoot.querySelector('.step-type');
    let agentStep = wizard.shadowRoot.querySelector('.step-agent');

    assert.ok(typeStep.classList.contains('active'), 'Type step should be active');
    assert.ok(!agentStep.classList.contains('active'), 'Agent step should be hidden');
  });

  it('should show agent step when AI Agent button clicked', () => {
    let doc    = getDocument();
    let wizard = doc.createElement('kikx-add-friend-modal');
    doc.body.appendChild(wizard);

    let agentButton = wizard.shadowRoot.querySelector('.agent-type-button');
    agentButton.click();

    let typeStep  = wizard.shadowRoot.querySelector('.step-type');
    let agentStep = wizard.shadowRoot.querySelector('.step-agent');

    assert.ok(!typeStep.classList.contains('active'), 'Type step should be hidden');
    assert.ok(agentStep.classList.contains('active'), 'Agent step should be active');
  });

  it('should show user step when Human button clicked', () => {
    let doc    = getDocument();
    let wizard = doc.createElement('kikx-add-friend-modal');
    doc.body.appendChild(wizard);

    let userButton = wizard.shadowRoot.querySelector('.user-type-button');
    userButton.click();

    let userStep = wizard.shadowRoot.querySelector('.step-user');
    assert.ok(userStep.classList.contains('active'), 'User step should be active');
  });

  it('should go back to type step when back button clicked', () => {
    let doc    = getDocument();
    let wizard = doc.createElement('kikx-add-friend-modal');
    doc.body.appendChild(wizard);

    // Go to agent step
    wizard.shadowRoot.querySelector('.agent-type-button').click();
    assert.ok(wizard.shadowRoot.querySelector('.step-agent').classList.contains('active'));

    // Click back
    let backButton = wizard.shadowRoot.querySelector('.step-agent .back-button');
    backButton.click();

    assert.ok(wizard.shadowRoot.querySelector('.step-type').classList.contains('active'), 'Should be back on type step');
  });

  it('should dispatch friend-save with agent data on save', () => {
    let doc    = getDocument();
    let wizard = doc.createElement('kikx-add-friend-modal');
    doc.body.appendChild(wizard);

    // Go to agent step
    wizard.shadowRoot.querySelector('.agent-type-button').click();

    // Fill fields
    wizard.shadowRoot.querySelector('.name-input').value    = 'Test Agent';
    wizard.shadowRoot.querySelector('.api-key-input').value = 'sk-test-123';

    let detail = null;
    wizard.addEventListener('friend-save', (event) => { detail = event.detail; });

    wizard.shadowRoot.querySelector('.save-button').click();

    assert.ok(detail, 'friend-save event should fire');
    assert.equal(detail.type, 'agent');
    assert.equal(detail.name, 'Test Agent');
    assert.equal(detail.apiKey, 'sk-test-123');
    assert.equal(detail.pluginID, 'claude');
  });

  it('should dispatch friend-save with user data on invite', () => {
    let doc    = getDocument();
    let wizard = doc.createElement('kikx-add-friend-modal');
    doc.body.appendChild(wizard);

    // Go to user step
    wizard.shadowRoot.querySelector('.user-type-button').click();

    wizard.shadowRoot.querySelector('.user-email-input').value = 'friend@example.com';
    wizard.shadowRoot.querySelector('.user-name-input').value  = 'Friend Name';

    let detail = null;
    wizard.addEventListener('friend-save', (event) => { detail = event.detail; });

    wizard.shadowRoot.querySelector('.invite-button').click();

    assert.ok(detail, 'friend-save event should fire');
    assert.equal(detail.type, 'user');
    assert.equal(detail.email, 'friend@example.com');
    assert.equal(detail.name, 'Friend Name');
  });

  it('should dispatch friend-cancel on cancel click', () => {
    let doc    = getDocument();
    let wizard = doc.createElement('kikx-add-friend-modal');
    doc.body.appendChild(wizard);

    // Go to agent step
    wizard.shadowRoot.querySelector('.agent-type-button').click();

    let cancelled = false;
    wizard.addEventListener('friend-cancel', () => { cancelled = true; });

    wizard.shadowRoot.querySelector('.step-agent .cancel-button').click();

    assert.ok(cancelled, 'friend-cancel event should fire');
  });

  it('should reset to type step on reset()', () => {
    let doc    = getDocument();
    let wizard = doc.createElement('kikx-add-friend-modal');
    doc.body.appendChild(wizard);

    // Go to agent step and fill fields
    wizard.shadowRoot.querySelector('.agent-type-button').click();
    wizard.shadowRoot.querySelector('.name-input').value = 'Something';

    wizard.reset();

    assert.ok(wizard.shadowRoot.querySelector('.step-type').classList.contains('active'));
    assert.equal(wizard.shadowRoot.querySelector('.name-input').value, '');
  });
});

// =============================================================================
// KikxSidebar (redesigned: Friends + Sessions sections with "+" buttons)
// =============================================================================

describe('KikxSidebar', () => {
  it('should render Friends and Sessions section headers', () => {
    let doc     = getDocument();
    let sidebar = doc.createElement('kikx-sidebar');
    doc.body.appendChild(sidebar);

    let friendsLabel  = sidebar.shadowRoot.querySelector('.friends-label');
    let sessionsLabel = sidebar.shadowRoot.querySelector('.sessions-label');

    assert.equal(friendsLabel.textContent, 'Friends');
    assert.equal(sessionsLabel.textContent, 'Sessions');
  });

  it('should render "+" buttons for add-friend and add-session', () => {
    let doc     = getDocument();
    let sidebar = doc.createElement('kikx-sidebar');
    doc.body.appendChild(sidebar);

    let addFriendButton  = sidebar.shadowRoot.querySelector('.add-friend-button');
    let addSessionButton = sidebar.shadowRoot.querySelector('.add-session-button');

    assert.ok(addFriendButton, 'Add friend button should exist');
    assert.ok(addSessionButton, 'Add session button should exist');
    assert.equal(addFriendButton.textContent, '+');
    assert.equal(addSessionButton.textContent, '+');
  });

  it('should NOT have participants section', () => {
    let doc     = getDocument();
    let sidebar = doc.createElement('kikx-sidebar');
    doc.body.appendChild(sidebar);

    let participantsHeader = sidebar.shadowRoot.querySelector('.participants-header');
    assert.equal(participantsHeader, null, 'Participants header should not exist');
  });

  it('should contain a kikx-friends-list element', () => {
    let doc     = getDocument();
    let sidebar = doc.createElement('kikx-sidebar');
    doc.body.appendChild(sidebar);

    let friendsList = sidebar.shadowRoot.querySelector('kikx-friends-list');
    assert.ok(friendsList, 'Should contain friends list component');
  });

  it('should dispatch add-friend event when "+" button clicked', () => {
    let doc     = getDocument();
    let sidebar = doc.createElement('kikx-sidebar');
    doc.body.appendChild(sidebar);

    let dispatched = false;
    sidebar.addEventListener('add-friend', () => { dispatched = true; });

    sidebar.shadowRoot.querySelector('.add-friend-button').click();
    assert.ok(dispatched, 'add-friend event should fire');
  });

  it('should dispatch add-session event when "+" button clicked', () => {
    let doc     = getDocument();
    let sidebar = doc.createElement('kikx-sidebar');
    doc.body.appendChild(sidebar);

    let dispatched = false;
    sidebar.addEventListener('add-session', () => { dispatched = true; });

    sidebar.shadowRoot.querySelector('.add-session-button').click();
    assert.ok(dispatched, 'add-session event should fire');
  });

  it('should pass friends to the friends list via setter', () => {
    let doc     = getDocument();
    let sidebar = doc.createElement('kikx-sidebar');
    doc.body.appendChild(sidebar);

    sidebar.friends = [
      { id: '1', name: 'Agent A', type: 'agent' },
    ];

    let friendsList = sidebar.shadowRoot.querySelector('kikx-friends-list');
    let rows = friendsList.shadowRoot.querySelectorAll('.friend-row');
    assert.equal(rows.length, 1);
  });

  it('should have search input with correct placeholder', () => {
    let doc     = getDocument();
    let sidebar = doc.createElement('kikx-sidebar');
    doc.body.appendChild(sidebar);

    let searchInput = sidebar.shadowRoot.querySelector('.search-input');
    assert.equal(searchInput.placeholder, 'Search...');
  });

  it('should toggle archive on button click', () => {
    let doc     = getDocument();
    let sidebar = doc.createElement('kikx-sidebar');
    doc.body.appendChild(sidebar);

    let detail = null;
    sidebar.addEventListener('toggle-archive', (event) => { detail = event.detail; });

    sidebar.shadowRoot.querySelector('.archive-toggle').click();
    assert.ok(detail, 'toggle-archive event should fire');
    assert.equal(detail.visible, true);
  });
});

// =============================================================================
// KikxStatusBar
// =============================================================================

describe('KikxStatusBar', () => {
  it('should render without errors (no subscribe method needed)', () => {
    let doc = getDocument();
    let bar = doc.createElement('kikx-status-bar');

    assert.doesNotThrow(() => {
      doc.body.appendChild(bar);
    });
  });

  it('should show disconnected status by default', () => {
    let doc = getDocument();
    let bar = doc.createElement('kikx-status-bar');
    doc.body.appendChild(bar);

    let statusText = bar.shadowRoot.querySelector('.status-text');
    assert.equal(statusText.textContent, en.statusBar.disconnected);
  });

  it('should show cost display with zero costs by default', () => {
    let doc = getDocument();
    let bar = doc.createElement('kikx-status-bar');
    doc.body.appendChild(bar);

    let costDisplay = bar.shadowRoot.querySelector('.cost-display');
    assert.ok(costDisplay.innerHTML.includes('$0.00'), 'Should show default zero costs');
  });

  it('should update when store connection status changes', async () => {
    let doc = getDocument();
    let bar = doc.createElement('kikx-status-bar');
    doc.body.appendChild(bar);

    store.connection.setStatus('connected');

    // seqda emits update events asynchronously (microtask)
    await new Promise((resolve) => setTimeout(resolve, 20));

    let statusText = bar.shadowRoot.querySelector('.status-text');
    assert.equal(statusText.textContent, en.statusBar.connected);
  });

  it('should update when costs change in store', async () => {
    let doc = getDocument();
    let bar = doc.createElement('kikx-status-bar');
    doc.body.appendChild(bar);

    store.connection.updateCosts({ global: 1.23, service: 0.45, session: 0.12 });

    // seqda emits update events asynchronously (microtask)
    await new Promise((resolve) => setTimeout(resolve, 20));

    let costDisplay = bar.shadowRoot.querySelector('.cost-display');
    assert.ok(costDisplay.innerHTML.includes('$1.23'), 'Should show global cost');
    assert.ok(costDisplay.innerHTML.includes('$0.45'), 'Should show service cost');
    assert.ok(costDisplay.innerHTML.includes('$0.12'), 'Should show session cost');
  });

  it('should clean up store listener on disconnect', () => {
    let doc = getDocument();
    let bar = doc.createElement('kikx-status-bar');
    doc.body.appendChild(bar);

    assert.ok(bar._onStoreUpdate, 'Should have listener registered');

    doc.body.removeChild(bar);

    assert.equal(bar._onStoreUpdate, null, 'Listener should be cleaned up');
  });

  it('should show status dot element', () => {
    let doc = getDocument();
    let bar = doc.createElement('kikx-status-bar');
    doc.body.appendChild(bar);

    let statusDot = bar.shadowRoot.querySelector('.status-dot');
    assert.ok(statusDot, 'Status dot should exist');
  });
});

// =============================================================================
// KikxSettingsPage (redesigned: 6 tabs incl. logout, avatar, editable email)
// =============================================================================

describe('KikxSettingsPage', () => {
  it('should render with settings title', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-settings-page');
    doc.body.appendChild(page);

    let title = page.shadowRoot.querySelector('.settings-title');
    assert.equal(title.textContent, 'Settings');
  });

  it('should render 6 tab buttons (including Logout)', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-settings-page');
    doc.body.appendChild(page);

    let tabs = page.shadowRoot.querySelectorAll('.tab-button');
    assert.equal(tabs.length, 6);
  });

  it('should render tabs with correct labels including Logout', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-settings-page');
    doc.body.appendChild(page);

    let tabs   = page.shadowRoot.querySelectorAll('.tab-button');
    let labels = Array.from(tabs).map((tab) => tab.textContent);

    assert.deepStrictEqual(labels, ['Profile', 'Account', 'API Keys', 'Permissions', 'Appearance', 'Logout']);
  });

  it('should have Profile tab active by default', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-settings-page');
    doc.body.appendChild(page);

    let activeTab = page.shadowRoot.querySelector('.tab-button.active');
    assert.equal(activeTab.textContent, 'Profile');

    let activePanel = page.shadowRoot.querySelector('.tab-panel.active');
    assert.equal(activePanel.dataset.tab, 'profile');
  });

  it('should NOT contain placeholder "settings content" text', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-settings-page');
    doc.body.appendChild(page);

    let panels = page.shadowRoot.querySelectorAll('.tab-panel');
    for (let panel of panels) {
      assert.ok(
        !panel.textContent.includes('settings content'),
        `Panel ${panel.dataset.tab} should not contain placeholder text`,
      );
    }
  });

  it('should render Profile tab with avatar section', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-settings-page');
    doc.body.appendChild(page);

    let profilePanel = page.shadowRoot.querySelector('.tab-panel[data-tab="profile"]');
    let avatarRow    = profilePanel.querySelector('.avatar-row');
    let avatar       = profilePanel.querySelector('kikx-user-avatar');

    assert.ok(avatarRow, 'Avatar row should exist');
    assert.ok(avatar, 'Avatar element should exist');
    assert.equal(avatar.getAttribute('size'), '64');
  });

  it('should render Profile tab with upload and remove avatar buttons', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-settings-page');
    doc.body.appendChild(page);

    let profilePanel = page.shadowRoot.querySelector('.tab-panel[data-tab="profile"]');
    let uploadButton = profilePanel.querySelector('.upload-avatar');
    let removeButton = profilePanel.querySelector('.remove-avatar');

    assert.ok(uploadButton, 'Upload button should exist');
    assert.ok(removeButton, 'Remove button should exist');
    assert.equal(uploadButton.textContent, 'Upload Photo');
    assert.equal(removeButton.textContent, 'Remove');
  });

  it('should have email input ENABLED (not disabled) on profile tab', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-settings-page');
    doc.body.appendChild(page);

    let profilePanel = page.shadowRoot.querySelector('.tab-panel[data-tab="profile"]');
    let emailInput   = profilePanel.querySelector('.email-input');

    assert.ok(!emailInput.disabled, 'Email input should be enabled');
  });

  it('should show email verification hint', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-settings-page');
    doc.body.appendChild(page);

    let profilePanel = page.shadowRoot.querySelector('.tab-panel[data-tab="profile"]');
    let hint = profilePanel.querySelector('.form-hint');

    assert.ok(hint, 'Email hint should exist');
    assert.equal(hint.textContent, 'Changes require email verification.');
  });

  it('should render Account tab with password fields when clicked', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-settings-page');
    doc.body.appendChild(page);

    let accountTab = page.shadowRoot.querySelector('.tab-button[data-tab="account"]');
    accountTab.click();

    let accountPanel  = page.shadowRoot.querySelector('.tab-panel[data-tab="account"]');
    assert.ok(accountPanel.classList.contains('active'), 'Account panel should be active');

    let passwordInputs = accountPanel.querySelectorAll('.form-input[type="password"]');
    assert.equal(passwordInputs.length, 3, 'Should have current, new, and confirm password inputs');
  });

  it('should render Logout tab with logout button', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-settings-page');
    doc.body.appendChild(page);

    let logoutPanel = page.shadowRoot.querySelector('.tab-panel[data-tab="logout"]');
    assert.ok(logoutPanel, 'Logout panel should exist');

    let logoutButton = logoutPanel.querySelector('.logout-action');
    assert.ok(logoutButton, 'Logout button should exist');
    assert.equal(logoutButton.textContent, 'Logout');
    assert.ok(logoutButton.classList.contains('danger'), 'Should have danger class');
  });

  it('should render Logout tab description text', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-settings-page');
    doc.body.appendChild(page);

    let logoutPanel = page.shadowRoot.querySelector('.tab-panel[data-tab="logout"]');
    assert.ok(logoutPanel.textContent.includes('You will be returned to the login page'));
  });

  it('should clear auth and navigate to login when logout button clicked', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-settings-page');
    doc.body.appendChild(page);

    // Set up auth
    localStorage.setItem('kikx_auth', JSON.stringify({ token: 'test', user: {} }));
    store.profile.setUser({ id: '1' }, 'test');

    // Switch to logout tab
    let logoutTab = page.shadowRoot.querySelector('.tab-button[data-tab="logout"]');
    logoutTab.click();

    let logoutButton = page.shadowRoot.querySelector('.tab-panel[data-tab="logout"] .logout-action');
    logoutButton.click();

    assert.equal(localStorage.getItem('kikx_auth'), null, 'Auth should be cleared');
    assert.equal(store.profile.isAuthenticated(), false, 'Should be logged out');
  });

  it('should populate profile form with user data from store', () => {
    store.profile.setUser({
      firstName: 'Test',
      lastName:  'User',
      email:     'test@example.com',
    }, 'token123');

    let doc  = getDocument();
    let page = doc.createElement('kikx-settings-page');
    doc.body.appendChild(page);

    let profilePanel = page.shadowRoot.querySelector('.tab-panel[data-tab="profile"]');
    let firstName    = profilePanel.querySelector('.first-name-input');
    let lastName     = profilePanel.querySelector('.last-name-input');
    let email        = profilePanel.querySelector('.email-input');

    assert.equal(firstName.value, 'Test');
    assert.equal(lastName.value, 'User');
    assert.equal(email.value, 'test@example.com');
  });

  it('should switch tabs when clicked', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-settings-page');
    doc.body.appendChild(page);

    let accountTab = page.shadowRoot.querySelector('.tab-button[data-tab="account"]');
    accountTab.click();

    let profileTab = page.shadowRoot.querySelector('.tab-button[data-tab="profile"]');
    assert.ok(!profileTab.classList.contains('active'), 'Profile tab should be inactive');
    assert.ok(accountTab.classList.contains('active'), 'Account tab should be active');

    let profilePanel = page.shadowRoot.querySelector('.tab-panel[data-tab="profile"]');
    let accountPanel = page.shadowRoot.querySelector('.tab-panel[data-tab="account"]');
    assert.ok(!profilePanel.classList.contains('active'), 'Profile panel should be hidden');
    assert.ok(accountPanel.classList.contains('active'), 'Account panel should be visible');
  });

  it('should navigate to /kikx/ when back button is clicked', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-settings-page');
    doc.body.appendChild(page);

    router.defineRoute('/kikx/', 'sessions');
    router.defineRoute('/kikx/settings', 'settings');

    let backButton = page.shadowRoot.querySelector('.back-button');
    backButton.click();

    assert.equal(globalThis.window.location.pathname, '/kikx/');
  });

  it('should show back arrow button', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-settings-page');
    doc.body.appendChild(page);

    let backButton = page.shadowRoot.querySelector('.back-button');
    assert.ok(backButton, 'Back button should exist');
    assert.equal(backButton.textContent, '\u2190');
  });
});

// =============================================================================
// Store — profile.updateUser
// =============================================================================

describe('Store profile.updateUser', () => {
  it('should update user properties in store', () => {
    store.profile.setUser({ firstName: 'Old', lastName: 'Name', email: 'old@test.com' }, 'tok');
    store.profile.updateUser({ firstName: 'New' });

    let user = store.profile.getUser();
    assert.equal(user.firstName, 'New');
    assert.equal(user.lastName, 'Name');
  });

  it('should do nothing if no user set', () => {
    store.profile.updateUser({ firstName: 'New' });
    assert.equal(store.profile.getUser(), null);
  });
});

// =============================================================================
// Locale: en.mjs
// =============================================================================

describe('en.mjs locale', () => {
  it('should have "Sign In" as login submit button text', () => {
    assert.equal(en.login.submitButton, 'Sign In');
  });

  it('should have "Signing in..." as login loading text', () => {
    assert.equal(en.login.loading, 'Signing in...');
  });

  it('should NOT contain "Send Magic Link" anywhere in login', () => {
    let loginValues = JSON.stringify(en.login);
    assert.ok(!loginValues.includes('Magic Link'), 'Locale should not reference magic links');
  });

  it('should have password placeholder', () => {
    assert.equal(en.login.passwordPlaceholder, 'Password');
  });

  it('should NOT have abilities in topBar', () => {
    assert.equal(en.topBar.abilities, undefined);
  });

  it('should NOT have agents or logout in topBar', () => {
    assert.equal(en.topBar.agents, undefined);
    assert.equal(en.topBar.logout, undefined);
  });

  it('should have friends locale section', () => {
    assert.ok(en.friends, 'Should have friends section');
    assert.equal(en.friends.title, 'Friends');
    assert.equal(en.friends.agentBadge, 'AI');
    assert.ok(en.friends.wizard, 'Should have friends.wizard');
    assert.equal(en.friends.wizard.title, 'Add Friend');
  });

  it('should have sidebar.friends and sidebar.sessions', () => {
    assert.equal(en.sidebar.friends, 'Friends');
    assert.equal(en.sidebar.sessions, 'Sessions');
    assert.equal(en.sidebar.addFriend, '+');
    assert.equal(en.sidebar.addSession, '+');
    assert.equal(en.sidebar.participants, undefined, 'Should NOT have participants');
  });

  it('should have settings.logout section', () => {
    assert.equal(en.settings.tabs.logout, 'Logout');
    assert.equal(en.settings.logout.heading, 'Sign Out');
    assert.equal(en.settings.logout.button, 'Logout');
  });

  it('should have avatar-related profile strings', () => {
    assert.equal(en.settings.profile.avatarLabel, 'Avatar');
    assert.equal(en.settings.profile.avatarUploadButton, 'Upload Photo');
    assert.equal(en.settings.profile.avatarRemoveButton, 'Remove');
    assert.equal(en.settings.profile.emailHint, 'Changes require email verification.');
  });

  it('should have settings form locale keys', () => {
    assert.ok(en.settings.profile, 'Should have settings.profile');
    assert.ok(en.settings.account, 'Should have settings.account');
    assert.ok(en.settings.apiKeys, 'Should have settings.apiKeys');
    assert.ok(en.settings.permissions, 'Should have settings.permissions');
    assert.ok(en.settings.appearance, 'Should have settings.appearance');
  });

  it('should have profile form labels', () => {
    assert.equal(en.settings.profile.displayName, 'First Name');
    assert.equal(en.settings.profile.lastName, 'Last Name');
    assert.equal(en.settings.profile.email, 'Email Address');
  });

  it('should have account form labels', () => {
    assert.equal(en.settings.account.currentPassword, 'Current Password');
    assert.equal(en.settings.account.newPassword, 'New Password');
    assert.equal(en.settings.account.confirmPassword, 'Confirm New Password');
    assert.equal(en.settings.account.changePassword, 'Update Password');
  });
});

// =============================================================================
// MD5 (used by kikx-user-avatar for Gravatar)
// =============================================================================

describe('MD5 hash function', () => {
  it('should produce correct MD5 hash for empty string', async () => {
    let { md5 } = await import('../../src/client/components/kikx-user-avatar/kikx-user-avatar.mjs');
    assert.equal(md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
  });

  it('should produce correct MD5 hash for "hello"', async () => {
    let { md5 } = await import('../../src/client/components/kikx-user-avatar/kikx-user-avatar.mjs');
    assert.equal(md5('hello'), '5d41402abc4b2a76b9719d911017c592');
  });

  it('should produce correct hash for an email address', async () => {
    let { md5 } = await import('../../src/client/components/kikx-user-avatar/kikx-user-avatar.mjs');
    // MD5 of "test@example.com" (verified against our implementation)
    assert.equal(md5('test@example.com'), '55502f40dc8b7c769880b10874abc9d0');
  });
});

// =============================================================================
// Client API — updateProfile
// =============================================================================

describe('API updateProfile', () => {
  it('should be exported as a function', () => {
    assert.equal(typeof api.updateProfile, 'function');
  });
});
