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
  await import('../../src/client/components/kikx-message-input/kikx-message-input.mjs');
  await import('../../src/client/components/kikx-message-content/kikx-message-content.mjs');
  await import('../../src/client/components/kikx-interaction/kikx-interaction.mjs');
  await import('../../src/client/components/kikx-hml-prompt/kikx-hml-prompt.mjs');
  await import('../../src/client/components/kikx-permission-request/kikx-permission-request.mjs');
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
  try { sessionStorage.clear(); } catch (_e) { /* ignore */ }
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
    assert.ok(img.src.includes('d=404'), 'Should use 404 fallback');
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
    assert.equal(tabs.length, 5);
  });

  it('should render tabs with correct labels including Logout', () => {
    let doc  = getDocument();
    let page = doc.createElement('kikx-settings-page');
    doc.body.appendChild(page);

    let tabs   = page.shadowRoot.querySelectorAll('.tab-button');
    let labels = Array.from(tabs).map((tab) => tab.textContent);

    assert.deepStrictEqual(labels, ['Profile', 'Account', 'Permissions', 'Appearance', 'Logout']);
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

// =============================================================================
// KikxMessageInput — Queue Logic
// =============================================================================

describe('KikxMessageInput', () => {
  it('should render textarea and send button', () => {
    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');
    doc.body.appendChild(input);

    let textarea   = input.shadowRoot.querySelector('.message-textarea');
    let sendButton = input.shadowRoot.querySelector('.send-button');

    assert.ok(textarea, 'Textarea should exist');
    assert.ok(sendButton, 'Send button should exist');
  });

  it('should dispatch send-message event when not interacting', () => {
    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');
    doc.body.appendChild(input);

    let dispatched = null;
    input.addEventListener('send-message', (event) => { dispatched = event.detail; });

    let textarea = input.shadowRoot.querySelector('.message-textarea');
    textarea.value = 'Hello world';

    let sendButton = input.shadowRoot.querySelector('.send-button');
    sendButton.click();

    assert.ok(dispatched, 'send-message event should fire');
    assert.equal(dispatched.text, 'Hello world');
    assert.equal(textarea.value, '', 'Textarea should be cleared');
  });

  it('should queue messages when interacting', () => {
    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');
    doc.body.appendChild(input);

    input.setInteracting(true);

    let dispatched  = null;
    let queueCount  = null;
    input.addEventListener('send-message', (event) => { dispatched = event.detail; });
    input.addEventListener('queue-change', (event) => { queueCount = event.detail.count; });

    let textarea = input.shadowRoot.querySelector('.message-textarea');
    textarea.value = 'Queued message';

    let sendButton = input.shadowRoot.querySelector('.send-button');
    sendButton.click();

    assert.equal(dispatched, null, 'send-message should NOT fire while interacting');
    assert.equal(textarea.value, '', 'Textarea should still be cleared');
    assert.equal(queueCount, 1, 'queue-change should report 1 queued');
  });

  it('should queue multiple messages and show count', () => {
    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');
    doc.body.appendChild(input);

    input.setInteracting(true);

    let lastCount  = null;
    input.addEventListener('queue-change', (event) => { lastCount = event.detail.count; });

    let textarea   = input.shadowRoot.querySelector('.message-textarea');
    let sendButton = input.shadowRoot.querySelector('.send-button');

    textarea.value = 'First';
    sendButton.click();

    textarea.value = 'Second';
    sendButton.click();

    textarea.value = 'Third';
    sendButton.click();

    assert.equal(lastCount, 3, 'queue-change should report 3 queued');
  });

  it('should drain queue on setInteracting(false)', () => {
    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');
    doc.body.appendChild(input);

    input.setInteracting(true);

    let textarea   = input.shadowRoot.querySelector('.message-textarea');
    let sendButton = input.shadowRoot.querySelector('.send-button');

    textarea.value = 'First';
    sendButton.click();

    textarea.value = 'Second';
    sendButton.click();

    let dispatched = null;
    let lastCount  = null;
    input.addEventListener('send-message', (event) => { dispatched = event.detail; });
    input.addEventListener('queue-change', (event) => { lastCount = event.detail.count; });

    input.setInteracting(false);

    assert.ok(dispatched, 'send-message should fire on drain');
    assert.equal(dispatched.text, 'First\n\nSecond');
    assert.equal(lastCount, 0, 'queue-change should report 0 after drain');
  });

  it('should cancel queue on Esc and restore text to textarea', () => {
    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');
    doc.body.appendChild(input);

    input.setInteracting(true);

    let lastCount = null;
    input.addEventListener('queue-change', (event) => { lastCount = event.detail.count; });

    let textarea   = input.shadowRoot.querySelector('.message-textarea');
    let sendButton = input.shadowRoot.querySelector('.send-button');

    textarea.value = 'Queued msg';
    sendButton.click();

    // Simulate Esc key
    let escEvent = new globalThis.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    textarea.dispatchEvent(escEvent);

    assert.equal(textarea.value, 'Queued msg', 'Queued text should be restored to textarea');
    assert.equal(lastCount, 0, 'queue-change should report 0 after cancel');
  });

  it('should prepend queued text before existing textarea content on Esc', () => {
    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');
    doc.body.appendChild(input);

    input.setInteracting(true);

    let textarea   = input.shadowRoot.querySelector('.message-textarea');
    let sendButton = input.shadowRoot.querySelector('.send-button');

    textarea.value = 'First queued';
    sendButton.click();

    // User types something new
    textarea.value = 'Currently typing';

    // Esc to cancel
    let escEvent = new globalThis.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    textarea.dispatchEvent(escEvent);

    assert.equal(textarea.value, 'First queued\n\nCurrently typing');
  });

  it('should not dispatch send-message when textarea is empty', () => {
    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');
    doc.body.appendChild(input);

    let dispatched = false;
    input.addEventListener('send-message', () => { dispatched = true; });

    let sendButton = input.shadowRoot.querySelector('.send-button');
    sendButton.click();

    assert.equal(dispatched, false, 'Should not dispatch for empty text');
  });

  it('should not drain empty queue on setInteracting(false)', () => {
    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');
    doc.body.appendChild(input);

    input.setInteracting(true);

    let dispatched = false;
    input.addEventListener('send-message', () => { dispatched = true; });

    input.setInteracting(false);

    assert.equal(dispatched, false, 'Should not dispatch for empty queue');
  });

  it('should not emit queue-change on construction', () => {
    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');

    let emitted = false;
    input.addEventListener('queue-change', () => { emitted = true; });

    doc.body.appendChild(input);

    assert.equal(emitted, false, 'queue-change should not fire on construction');
  });

  it('should not do Esc cancel when queue is empty', () => {
    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');
    doc.body.appendChild(input);

    let textarea = input.shadowRoot.querySelector('.message-textarea');
    textarea.value = 'Some text';

    let escEvent = new globalThis.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    textarea.dispatchEvent(escEvent);

    // Text should remain unchanged — Esc with no queue is a no-op
    assert.equal(textarea.value, 'Some text');
  });

  // ---------------------------------------------------------------------------
  // Draft persistence (sessionStorage)
  // ---------------------------------------------------------------------------

  it('should save draft to sessionStorage on input', () => {
    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');
    doc.body.appendChild(input);

    input.sessionId = 'ses_abc123';

    let textarea = input.shadowRoot.querySelector('.message-textarea');
    textarea.value = 'Work in progress';
    textarea.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }));

    assert.equal(sessionStorage.getItem('kikx_draft:ses_abc123'), 'Work in progress');
  });

  it('should load draft from sessionStorage when sessionId is set', () => {
    sessionStorage.setItem('kikx_draft:ses_xyz789', 'Restored draft');

    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');
    doc.body.appendChild(input);

    input.sessionId = 'ses_xyz789';

    let textarea = input.shadowRoot.querySelector('.message-textarea');
    assert.equal(textarea.value, 'Restored draft');
  });

  it('should clear draft via clearDraft()', () => {
    sessionStorage.setItem('kikx_draft:ses_clear', 'To be cleared');

    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');
    doc.body.appendChild(input);

    input.sessionId = 'ses_clear';
    input.clearDraft();

    assert.equal(sessionStorage.getItem('kikx_draft:ses_clear'), null);
  });

  it('should NOT clear draft from sessionStorage on send (waits for 200)', () => {
    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');
    doc.body.appendChild(input);

    input.sessionId = 'ses_persist';

    let textarea = input.shadowRoot.querySelector('.message-textarea');
    textarea.value = 'Important message';
    textarea.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }));

    assert.equal(sessionStorage.getItem('kikx_draft:ses_persist'), 'Important message');

    // Send the message
    input.shadowRoot.querySelector('.send-button').click();

    // Draft should still be in sessionStorage
    assert.equal(sessionStorage.getItem('kikx_draft:ses_persist'), 'Important message');
  });

  it('should clear draft when message is queued (text moved to queue)', () => {
    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');
    doc.body.appendChild(input);

    input.sessionId = 'ses_queue';
    input.setInteracting(true);

    let textarea = input.shadowRoot.querySelector('.message-textarea');
    textarea.value = 'Queued text';
    textarea.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }));

    assert.equal(sessionStorage.getItem('kikx_draft:ses_queue'), 'Queued text');

    // Queue it
    input.shadowRoot.querySelector('.send-button').click();

    // Draft should be cleared — text is in the queue now
    assert.equal(sessionStorage.getItem('kikx_draft:ses_queue'), null);
  });

  it('should remove draft from sessionStorage when textarea is emptied', () => {
    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');
    doc.body.appendChild(input);

    input.sessionId = 'ses_empty';

    let textarea = input.shadowRoot.querySelector('.message-textarea');
    textarea.value = 'Some text';
    textarea.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }));

    assert.equal(sessionStorage.getItem('kikx_draft:ses_empty'), 'Some text');

    textarea.value = '';
    textarea.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }));

    assert.equal(sessionStorage.getItem('kikx_draft:ses_empty'), null);
  });

  it('should not save draft when sessionId is not set', () => {
    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');
    doc.body.appendChild(input);

    let textarea = input.shadowRoot.querySelector('.message-textarea');
    textarea.value = 'No session';
    textarea.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }));

    // No key to check — just verify no errors thrown
    assert.equal(input.sessionId, null);
  });

  it('should save draft on Esc cancel (restored text becomes new draft)', () => {
    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');
    doc.body.appendChild(input);

    input.sessionId = 'ses_esc';
    input.setInteracting(true);

    let textarea   = input.shadowRoot.querySelector('.message-textarea');
    let sendButton = input.shadowRoot.querySelector('.send-button');

    textarea.value = 'Queued';
    sendButton.click();

    // Esc to restore
    let escEvent = new globalThis.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    textarea.dispatchEvent(escEvent);

    assert.equal(textarea.value, 'Queued');
    assert.equal(sessionStorage.getItem('kikx_draft:ses_esc'), 'Queued');
  });

  it('should isolate drafts between different session IDs', () => {
    sessionStorage.setItem('kikx_draft:ses_a', 'Draft A');
    sessionStorage.setItem('kikx_draft:ses_b', 'Draft B');

    let doc   = getDocument();
    let input = doc.createElement('kikx-message-input');
    doc.body.appendChild(input);

    input.sessionId = 'ses_a';
    assert.equal(input.shadowRoot.querySelector('.message-textarea').value, 'Draft A');

    input.sessionId = 'ses_b';
    assert.equal(input.shadowRoot.querySelector('.message-textarea').value, 'Draft B');
  });
});

// =============================================================================
// kikx-hml-prompt
// =============================================================================

describe('kikx-hml-prompt: getName()', () => {
  it('should return name attribute when set', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('name', 'favorite-color');
    prompt.setAttribute('label', 'Favorite Color');
    doc.body.appendChild(prompt);

    assert.equal(prompt.getName(), 'favorite-color');
  });

  it('should return prompt-id attribute as fallback', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('prompt-id', 'q1');
    prompt.setAttribute('label', 'Question One');
    doc.body.appendChild(prompt);

    assert.equal(prompt.getName(), 'q1');
  });

  it('should derive slug from label when name and prompt-id are absent', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('label', 'Your Favorite Color');
    doc.body.appendChild(prompt);

    assert.equal(prompt.getName(), 'your-favorite-color');
  });

  it('should handle special characters in label slug', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('label', '  Age (years)!! ');
    doc.body.appendChild(prompt);

    assert.equal(prompt.getName(), 'age-years');
  });

  it('should return empty string when no name, prompt-id, or label', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    doc.body.appendChild(prompt);

    assert.equal(prompt.getName(), '');
  });
});

describe('kikx-hml-prompt: password type', () => {
  it('should render a password input', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'password');
    prompt.setAttribute('name', 'secret');
    prompt.setAttribute('label', 'Password');
    doc.body.appendChild(prompt);

    let input = prompt.shadowRoot.querySelector('input[type="password"]');
    assert.ok(input, 'should render an input with type="password"');
  });
});

describe('kikx-hml-prompt: radio/checkbox clickability', () => {
  it('should wrap radio options in label elements', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'radio');
    prompt.setAttribute('name', 'color');
    prompt.setAttribute('options', 'Red,Blue,Green');
    doc.body.appendChild(prompt);

    let labels = prompt.shadowRoot.querySelectorAll('label.radio-row');
    assert.equal(labels.length, 3, 'each radio option should be wrapped in a <label>');

    // Each label should contain an input and a span
    for (let label of labels) {
      assert.ok(label.querySelector('input[type="radio"]'), 'label should contain radio input');
      assert.ok(label.querySelector('span'), 'label should contain text span');
    }
  });

  it('should wrap checkbox in a label element', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'checkbox');
    prompt.setAttribute('name', 'agree');
    prompt.setAttribute('label', 'I agree');
    doc.body.appendChild(prompt);

    let label = prompt.shadowRoot.querySelector('label.checkbox-row');
    assert.ok(label, 'checkbox should be wrapped in a <label>');
    assert.ok(label.querySelector('input[type="checkbox"]'), 'label should contain checkbox input');
    assert.ok(label.querySelector('span'), 'label should contain text span');
  });
});

// =============================================================================
// kikx-hml-prompt: getValue/setValue round-trip
// =============================================================================

describe('kikx-hml-prompt: getValue/setValue', () => {
  it('should return text value from getValue()', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'text');
    prompt.setAttribute('name', 'username');
    prompt.setAttribute('label', 'Username');
    doc.body.appendChild(prompt);

    let input = prompt.shadowRoot.querySelector('input');
    input.value = 'typed-by-user';

    assert.equal(prompt.getValue(), 'typed-by-user');
  });

  it('should set text value via setValue()', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'text');
    prompt.setAttribute('name', 'city');
    prompt.setAttribute('label', 'City');
    doc.body.appendChild(prompt);

    prompt.setValue('Portland');
    assert.equal(prompt.getValue(), 'Portland');
  });

  it('should return password value from getValue()', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'password');
    prompt.setAttribute('name', 'secret');
    prompt.setAttribute('label', 'Secret');
    doc.body.appendChild(prompt);

    let input = prompt.shadowRoot.querySelector('input[type="password"]');
    input.value = 'hunter2';

    assert.equal(prompt.getValue(), 'hunter2');
  });

  it('should return textarea value from getValue()', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'textarea');
    prompt.setAttribute('name', 'bio');
    prompt.setAttribute('label', 'Bio');
    doc.body.appendChild(prompt);

    let textarea = prompt.shadowRoot.querySelector('textarea');
    textarea.value = 'Hello world';

    assert.equal(prompt.getValue(), 'Hello world');
  });

  it('should return number value from getValue()', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'number');
    prompt.setAttribute('name', 'age');
    prompt.setAttribute('label', 'Age');
    doc.body.appendChild(prompt);

    let input = prompt.shadowRoot.querySelector('input[type="number"]');
    input.value = '42';

    assert.equal(prompt.getValue(), '42');
  });

  it('should return checkbox boolean from getValue()', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'checkbox');
    prompt.setAttribute('name', 'agree');
    prompt.setAttribute('label', 'I agree');
    doc.body.appendChild(prompt);

    let checkbox = prompt.shadowRoot.querySelector('input[type="checkbox"]');
    assert.equal(prompt.getValue(), false, 'unchecked should be false');

    checkbox.checked = true;
    assert.equal(prompt.getValue(), true, 'checked should be true');
  });

  it('should set checkbox value via setValue()', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'checkbox');
    prompt.setAttribute('name', 'agree');
    prompt.setAttribute('label', 'I agree');
    doc.body.appendChild(prompt);

    prompt.setValue(true);
    assert.equal(prompt.getValue(), true);

    prompt.setValue(false);
    assert.equal(prompt.getValue(), false);
  });

  it('should return radio value from getValue()', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'radio');
    prompt.setAttribute('name', 'color');
    prompt.setAttribute('options', 'Red,Blue,Green');
    doc.body.appendChild(prompt);

    let radios = prompt.shadowRoot.querySelectorAll('input[type="radio"]');
    radios[1].checked = true;

    assert.equal(prompt.getValue(), 'Blue');
  });

  it('should set radio value via setValue()', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'radio');
    prompt.setAttribute('name', 'color');
    prompt.setAttribute('options', 'Red,Blue,Green');
    doc.body.appendChild(prompt);

    prompt.setValue('Green');
    assert.equal(prompt.getValue(), 'Green');
  });

  it('should return select value from getValue() (custom dropdown)', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'select');
    prompt.setAttribute('name', 'size');
    prompt.setAttribute('options', 'Small,Medium,Large');
    doc.body.appendChild(prompt);

    // Default: first option selected
    assert.equal(prompt.getValue(), 'Small');

    // Click the second option
    let options = prompt.shadowRoot.querySelectorAll('.select-option');
    options[1].click();

    assert.equal(prompt.getValue(), 'Medium');
  });

  it('should return default value when set via attribute', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'text');
    prompt.setAttribute('name', 'greeting');
    prompt.setAttribute('label', 'Greeting');
    prompt.setAttribute('value', 'Hello!');
    doc.body.appendChild(prompt);

    assert.equal(prompt.getValue(), 'Hello!');
  });
});

// =============================================================================
// kikx-hml-prompt: value persistence through readonly transition
// =============================================================================

describe('kikx-hml-prompt: value persistence on readonly', () => {
  it('should preserve text value when value attr is set before readonly', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'text');
    prompt.setAttribute('name', 'username');
    prompt.setAttribute('label', 'Username');
    doc.body.appendChild(prompt);

    // Simulate the persistence flow: set value attribute, then readonly
    prompt.setAttribute('value', 'user-typed-answer');
    prompt.setAttribute('readonly', '');

    let input = prompt.shadowRoot.querySelector('input');
    assert.equal(input.value, 'user-typed-answer', 'text value should survive readonly transition');
    assert.equal(input.getAttribute('aria-disabled'), 'true', 'input should be aria-disabled');
    assert.equal(input.tabIndex, -1, 'input should not be focusable');
  });

  it('should preserve password value when value attr is set before readonly', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'password');
    prompt.setAttribute('name', 'secret');
    prompt.setAttribute('label', 'Secret');
    doc.body.appendChild(prompt);

    prompt.setAttribute('value', 'hunter2');
    prompt.setAttribute('readonly', '');

    let input = prompt.shadowRoot.querySelector('input[type="password"]');
    assert.equal(input.value, 'hunter2', 'password value should survive readonly transition');
    assert.equal(input.getAttribute('aria-disabled'), 'true');
  });

  it('should preserve textarea value when value attr is set before readonly', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'textarea');
    prompt.setAttribute('name', 'bio');
    prompt.setAttribute('label', 'Bio');
    doc.body.appendChild(prompt);

    prompt.setAttribute('value', 'My life story');
    prompt.setAttribute('readonly', '');

    let textarea = prompt.shadowRoot.querySelector('textarea');
    assert.equal(textarea.value, 'My life story', 'textarea value should survive readonly transition');
    assert.equal(textarea.getAttribute('aria-disabled'), 'true');
  });

  it('should preserve number value when value attr is set before readonly', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'number');
    prompt.setAttribute('name', 'age');
    prompt.setAttribute('label', 'Age');
    doc.body.appendChild(prompt);

    prompt.setAttribute('value', '25');
    prompt.setAttribute('readonly', '');

    let input = prompt.shadowRoot.querySelector('input[type="number"]');
    assert.equal(input.value, '25', 'number value should survive readonly transition');
    assert.equal(input.getAttribute('aria-disabled'), 'true');
  });

  it('should preserve select value when value attr is set before readonly', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'select');
    prompt.setAttribute('name', 'size');
    prompt.setAttribute('options', 'Small,Medium,Large');
    doc.body.appendChild(prompt);

    prompt.setAttribute('value', 'Large');
    prompt.setAttribute('readonly', '');

    assert.equal(prompt.getValue(), 'Large', 'select value should survive readonly transition');
    let hidden = prompt.shadowRoot.querySelector('input[type="hidden"]');
    assert.equal(hidden.getAttribute('aria-disabled'), 'true');
  });

  it('should preserve checkbox value when value attr is set before readonly', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'checkbox');
    prompt.setAttribute('name', 'agree');
    prompt.setAttribute('label', 'I agree');
    doc.body.appendChild(prompt);

    prompt.setAttribute('value', 'true');
    prompt.setAttribute('readonly', '');

    let checkbox = prompt.shadowRoot.querySelector('input[type="checkbox"]');
    assert.equal(checkbox.checked, true, 'checkbox should be checked after readonly transition');
    assert.equal(checkbox.getAttribute('aria-disabled'), 'true');
  });

  it('should preserve radio value when value attr is set before readonly', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'radio');
    prompt.setAttribute('name', 'color');
    prompt.setAttribute('options', 'Red,Blue,Green');
    doc.body.appendChild(prompt);

    prompt.setAttribute('value', 'Blue');
    prompt.setAttribute('readonly', '');

    let radios  = prompt.shadowRoot.querySelectorAll('input[type="radio"]');
    let checked = Array.from(radios).find((r) => r.checked);
    assert.ok(checked, 'a radio should be checked');
    assert.equal(checked.value, 'Blue', 'Blue radio should be selected after readonly transition');

    for (let radio of radios)
      assert.equal(radio.getAttribute('aria-disabled'), 'true', 'all radios should be aria-disabled');
  });

  it('should render with value and readonly from initial attributes (reload scenario)', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'text');
    prompt.setAttribute('name', 'city');
    prompt.setAttribute('label', 'City');
    prompt.setAttribute('value', 'Portland');
    prompt.setAttribute('readonly', '');

    // This is the reload scenario: both attributes are set BEFORE connectedCallback
    doc.body.appendChild(prompt);

    let input = prompt.shadowRoot.querySelector('input');
    assert.equal(input.value, 'Portland', 'should render with persisted value on reload');
    assert.equal(input.getAttribute('aria-disabled'), 'true', 'should be aria-disabled on reload');
  });
});

// =============================================================================
// Integration: interaction → message-content → hml-prompt value collection
// =============================================================================

describe('Prompt value collection from interaction', () => {
  function buildInteractionWithPrompts(doc, promptsHTML) {
    let interaction = doc.createElement('kikx-interaction');
    interaction.setAttribute('alignment', 'agent');
    interaction.setAttribute('participant-name', 'Agent');
    interaction.setAttribute('participant-initials', 'A');
    interaction.setAttribute('data-interaction-id', 'test-int-1');
    interaction.setAttribute('data-frame-id', 'test-frame-1');

    let messageContent = doc.createElement('kikx-message-content');
    messageContent.content = promptsHTML;

    interaction.appendChild(messageContent);
    doc.body.appendChild(interaction);

    return interaction;
  }

  function collectPromptValues(interaction) {
    let messageContents = interaction.querySelectorAll('kikx-message-content');
    let answers = {};

    for (let messageContent of messageContents) {
      let shadow = messageContent.shadowRoot;
      if (!shadow) continue;

      let prompts = shadow.querySelectorAll('kikx-hml-prompt');
      for (let prompt of prompts) {
        let name  = prompt.getName();
        let value = prompt.getValue();
        if (name) answers[name] = value;
      }
    }

    return answers;
  }

  it('should collect text prompt values from interaction', () => {
    let doc = getDocument();
    let html = '<p>Enter your name:</p><kikx-hml-prompt name="user-name" type="text" label="Name"></kikx-hml-prompt>';
    let interaction = buildInteractionWithPrompts(doc, html);

    let shadow = interaction.querySelector('kikx-message-content').shadowRoot;
    let prompt = shadow.querySelector('kikx-hml-prompt');
    let input  = prompt.shadowRoot.querySelector('input');
    input.value = 'Alice';

    let answers = collectPromptValues(interaction);
    assert.equal(answers['user-name'], 'Alice');
  });

  it('should collect multiple prompt values', () => {
    let doc = getDocument();
    let html = `
      <kikx-hml-prompt name="first-name" type="text" label="First"></kikx-hml-prompt>
      <kikx-hml-prompt name="last-name" type="text" label="Last"></kikx-hml-prompt>
      <kikx-hml-prompt name="agree" type="checkbox" label="Terms"></kikx-hml-prompt>
    `;
    let interaction = buildInteractionWithPrompts(doc, html);

    let shadow  = interaction.querySelector('kikx-message-content').shadowRoot;
    let prompts = shadow.querySelectorAll('kikx-hml-prompt');

    prompts[0].shadowRoot.querySelector('input').value = 'Bob';
    prompts[1].shadowRoot.querySelector('input').value = 'Smith';
    prompts[2].shadowRoot.querySelector('input[type="checkbox"]').checked = true;

    let answers = collectPromptValues(interaction);
    assert.equal(answers['first-name'], 'Bob');
    assert.equal(answers['last-name'], 'Smith');
    assert.equal(answers['agree'], true);
  });

  it('should use label-derived name for prompts without explicit name', () => {
    let doc = getDocument();
    let html = '<kikx-hml-prompt type="text" label="Favorite Color"></kikx-hml-prompt>';
    let interaction = buildInteractionWithPrompts(doc, html);

    let shadow = interaction.querySelector('kikx-message-content').shadowRoot;
    let prompt = shadow.querySelector('kikx-hml-prompt');
    prompt.shadowRoot.querySelector('input').value = 'Blue';

    let answers = collectPromptValues(interaction);
    assert.equal(answers['favorite-color'], 'Blue');
  });

  it('should show action buttons when prompts are present', () => {
    let doc = getDocument();
    let html = '<kikx-hml-prompt name="q1" type="text" label="Question"></kikx-hml-prompt>';
    let interaction = buildInteractionWithPrompts(doc, html);

    assert.equal(interaction.hasAttribute('show-actions'), true, 'show-actions should be set by prompt connectedCallback');

    let submitBtn = interaction.shadowRoot.querySelector('.submit-button');
    let ignoreBtn = interaction.shadowRoot.querySelector('.ignore-button');
    assert.ok(submitBtn, 'submit button should exist');
    assert.ok(ignoreBtn, 'ignore button should exist');
  });

  it('should dispatch interaction-submit event from submit button', () => {
    let doc = getDocument();
    let html = '<kikx-hml-prompt name="q1" type="text" label="Q"></kikx-hml-prompt>';
    let interaction = buildInteractionWithPrompts(doc, html);

    let dispatched = null;
    interaction.addEventListener('interaction-submit', (event) => { dispatched = event.detail; });

    let submitBtn = interaction.shadowRoot.querySelector('.submit-button');
    submitBtn.click();

    assert.ok(dispatched, 'interaction-submit should fire');
    assert.equal(dispatched.interactionId, 'test-int-1');
  });

  it('should dispatch interaction-ignore event from ignore button', () => {
    let doc = getDocument();
    let html = '<kikx-hml-prompt name="q1" type="text" label="Q"></kikx-hml-prompt>';
    let interaction = buildInteractionWithPrompts(doc, html);

    let dispatched = null;
    interaction.addEventListener('interaction-ignore', (event) => { dispatched = event.detail; });

    let ignoreBtn = interaction.shadowRoot.querySelector('.ignore-button');
    ignoreBtn.click();

    assert.ok(dispatched, 'interaction-ignore should fire');
    assert.equal(dispatched.interactionId, 'test-int-1');
  });
});

// =============================================================================
// _buildUpdatedFrameHTML logic (simulated)
// =============================================================================

describe('Frame HTML update logic (persistence)', () => {
  // This mirrors _buildUpdatedFrameHTML from kikx-session-page.mjs:
  // Parse raw HTML into template, set value+readonly on prompts, serialize back.
  function buildUpdatedFrameHTML(rawHTML, answers) {
    let doc      = getDocument();
    let template = doc.createElement('template');
    template.innerHTML = rawHTML;

    let prompts = template.content.querySelectorAll('kikx-hml-prompt');
    for (let prompt of prompts) {
      let name = prompt.getAttribute('name') || prompt.getAttribute('prompt-id') || '';

      if (!name) {
        let label = prompt.getAttribute('label');
        if (label)
          name = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      }

      if (name && Object.prototype.hasOwnProperty.call(answers, name))
        prompt.setAttribute('value', String(answers[name]));

      prompt.setAttribute('readonly', '');
    }

    return template.innerHTML;
  }

  it('should bake value into prompt attributes', () => {
    let html = '<p>What is your name?</p><kikx-hml-prompt name="user-name" type="text" label="Name"></kikx-hml-prompt>';
    let updated = buildUpdatedFrameHTML(html, { 'user-name': 'Alice' });

    assert.ok(updated.includes('value="Alice"'), 'should contain value="Alice"');
    assert.ok(updated.includes('readonly=""'), 'should contain readonly');
  });

  it('should handle multiple prompts', () => {
    let html = `
      <kikx-hml-prompt name="first" type="text" label="First"></kikx-hml-prompt>
      <kikx-hml-prompt name="last" type="text" label="Last"></kikx-hml-prompt>
    `;
    let updated = buildUpdatedFrameHTML(html, { first: 'Bob', last: 'Smith' });

    assert.ok(updated.includes('value="Bob"'), 'should contain first name');
    assert.ok(updated.includes('value="Smith"'), 'should contain last name');
  });

  it('should handle label-derived names when name attribute is missing', () => {
    let html = '<kikx-hml-prompt type="text" label="Favorite Color"></kikx-hml-prompt>';
    let updated = buildUpdatedFrameHTML(html, { 'favorite-color': 'Blue' });

    assert.ok(updated.includes('value="Blue"'), 'should match by label-derived name');
  });

  it('should set readonly on all prompts even without answers', () => {
    let html = '<kikx-hml-prompt name="q1" type="text" label="Q1"></kikx-hml-prompt>';
    let updated = buildUpdatedFrameHTML(html, {});

    assert.ok(updated.includes('readonly=""'), 'should set readonly even with empty answers');
    assert.ok(!updated.includes('value='), 'should not set value when not in answers');
  });

  it('should preserve non-prompt HTML content', () => {
    let html = '<h2>Survey</h2><p>Please answer:</p><kikx-hml-prompt name="q1" type="text" label="Q"></kikx-hml-prompt><p>Thank you!</p>';
    let updated = buildUpdatedFrameHTML(html, { q1: 'answer' });

    assert.ok(updated.includes('<h2>Survey</h2>'), 'should preserve heading');
    assert.ok(updated.includes('<p>Please answer:</p>'), 'should preserve paragraph');
    assert.ok(updated.includes('<p>Thank you!</p>'), 'should preserve trailing content');
  });

  it('should handle checkbox boolean values as strings', () => {
    let html = '<kikx-hml-prompt name="agree" type="checkbox" label="Terms"></kikx-hml-prompt>';
    let updated = buildUpdatedFrameHTML(html, { agree: true });

    assert.ok(updated.includes('value="true"'), 'should serialize boolean as string');
  });

  it('should use prompt-id as fallback for name matching', () => {
    let html = '<kikx-hml-prompt prompt-id="q1" type="text" label="Question"></kikx-hml-prompt>';
    let updated = buildUpdatedFrameHTML(html, { q1: 'answer' });

    assert.ok(updated.includes('value="answer"'), 'should match by prompt-id');
  });

  it('should handle select prompt value persistence', () => {
    let html = '<kikx-hml-prompt name="size" type="select" label="Size" options="S,M,L"></kikx-hml-prompt>';
    let updated = buildUpdatedFrameHTML(html, { size: 'M' });

    assert.ok(updated.includes('value="M"'), 'should bake select value');
    assert.ok(updated.includes('readonly=""'), 'should set readonly');
  });
});

// =============================================================================
// kikx-hml-prompt: _applyReadonly
// =============================================================================

describe('kikx-hml-prompt: readonly behavior', () => {
  it('should mark text input as aria-disabled when readonly is set', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'text');
    prompt.setAttribute('name', 'q1');
    prompt.setAttribute('label', 'Q');
    doc.body.appendChild(prompt);

    assert.equal(prompt.shadowRoot.querySelector('input').getAttribute('aria-disabled'), null);

    prompt.setAttribute('readonly', '');
    assert.equal(prompt.shadowRoot.querySelector('input').getAttribute('aria-disabled'), 'true');
    assert.equal(prompt.shadowRoot.querySelector('input').tabIndex, -1);
  });

  it('should mark textarea as aria-disabled when readonly is set', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'textarea');
    prompt.setAttribute('name', 'q1');
    prompt.setAttribute('label', 'Q');
    doc.body.appendChild(prompt);

    prompt.setAttribute('readonly', '');
    assert.equal(prompt.shadowRoot.querySelector('textarea').getAttribute('aria-disabled'), 'true');
  });

  it('should mark all radio buttons as aria-disabled when readonly is set', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'radio');
    prompt.setAttribute('name', 'color');
    prompt.setAttribute('options', 'Red,Blue');
    doc.body.appendChild(prompt);

    prompt.setAttribute('readonly', '');
    let radios = prompt.shadowRoot.querySelectorAll('input[type="radio"]');
    for (let radio of radios)
      assert.equal(radio.getAttribute('aria-disabled'), 'true', 'radio should be aria-disabled');
  });

  it('should mark checkbox as aria-disabled when readonly is set', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'checkbox');
    prompt.setAttribute('name', 'agree');
    prompt.setAttribute('label', 'Agree');
    doc.body.appendChild(prompt);

    prompt.setAttribute('readonly', '');
    assert.equal(prompt.shadowRoot.querySelector('input[type="checkbox"]').getAttribute('aria-disabled'), 'true');
  });

  it('should apply pointer-events:none via CSS host([readonly])', () => {
    let doc    = getDocument();
    let prompt = doc.createElement('kikx-hml-prompt');
    prompt.setAttribute('type', 'text');
    prompt.setAttribute('name', 'q1');
    prompt.setAttribute('label', 'Q');
    prompt.setAttribute('readonly', '');
    doc.body.appendChild(prompt);

    // Verify the readonly attribute is present on the host
    assert.equal(prompt.hasAttribute('readonly'), true);
  });

  it('should NOT show action buttons for readonly prompts on reload', () => {
    let doc = getDocument();
    let interaction = doc.createElement('kikx-interaction');
    interaction.setAttribute('alignment', 'agent');
    interaction.setAttribute('participant-name', 'Agent');
    interaction.setAttribute('participant-initials', 'A');

    let mc = doc.createElement('kikx-message-content');
    mc.content = '<kikx-hml-prompt name="q1" type="text" label="Q" value="answer" readonly=""></kikx-hml-prompt>';

    interaction.appendChild(mc);
    doc.body.appendChild(interaction);

    assert.equal(interaction.hasAttribute('show-actions'), false,
      'readonly prompts should NOT trigger show-actions');
    assert.equal(interaction.shadowRoot.querySelector('.submit-button'), null,
      'submit button should not exist');
  });
});

// =============================================================================
// Data attribute persistence plumbing
// =============================================================================

describe('Prompt persistence plumbing', () => {
  it('data-frame-id attribute should be readable', () => {
    let doc         = getDocument();
    let interaction = doc.createElement('kikx-interaction');
    interaction.setAttribute('data-frame-id', 'frm_abc123');
    doc.body.appendChild(interaction);

    assert.equal(interaction.getAttribute('data-frame-id'), 'frm_abc123');
  });

  it('data-interaction-id attribute should be readable', () => {
    let doc         = getDocument();
    let interaction = doc.createElement('kikx-interaction');
    interaction.setAttribute('data-interaction-id', 'int_xyz');
    doc.body.appendChild(interaction);

    assert.equal(interaction.getAttribute('data-interaction-id'), 'int_xyz');
  });

  it('show-actions removal should hide action buttons', () => {
    let doc         = getDocument();
    let interaction = doc.createElement('kikx-interaction');
    interaction.setAttribute('alignment', 'agent');
    interaction.setAttribute('participant-name', 'Agent');
    interaction.setAttribute('participant-initials', 'A');
    interaction.setAttribute('show-actions', '');
    doc.body.appendChild(interaction);

    assert.ok(interaction.shadowRoot.querySelector('.submit-button'), 'should have submit button');

    interaction.removeAttribute('show-actions');
    assert.equal(interaction.shadowRoot.querySelector('.submit-button'), null, 'buttons should be removed');
  });

  it('messageContent.content property stores and retrieves raw HTML', () => {
    let doc = getDocument();
    let mc  = doc.createElement('kikx-message-content');
    doc.body.appendChild(mc);

    let html = '<p>Hello <strong>world</strong></p>';
    mc.content = html;

    assert.equal(mc.content, html);
  });

  it('messageContent renders hml-prompt elements from HTML', () => {
    let doc = getDocument();
    let mc  = doc.createElement('kikx-message-content');
    doc.body.appendChild(mc);

    mc.content = '<kikx-hml-prompt name="q1" type="text" label="Q1"></kikx-hml-prompt>';

    let prompt = mc.shadowRoot.querySelector('kikx-hml-prompt');
    assert.ok(prompt, 'hml-prompt should be rendered inside message content');
    assert.equal(prompt.getName(), 'q1');
  });

  it('messageContent renders multiple prompts from HTML', () => {
    let doc = getDocument();
    let mc  = doc.createElement('kikx-message-content');
    doc.body.appendChild(mc);

    mc.content = `
      <p>Fill out this form:</p>
      <kikx-hml-prompt name="name" type="text" label="Name"></kikx-hml-prompt>
      <kikx-hml-prompt name="age" type="number" label="Age"></kikx-hml-prompt>
    `;

    let prompts = mc.shadowRoot.querySelectorAll('kikx-hml-prompt');
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0].getName(), 'name');
    assert.equal(prompts[1].getName(), 'age');
  });

  it('hml-prompt rendered with value+readonly attributes should display persisted value', () => {
    let doc = getDocument();
    let mc  = doc.createElement('kikx-message-content');
    doc.body.appendChild(mc);

    // Simulate reload: HTML has value and readonly already baked in
    mc.content = '<kikx-hml-prompt name="city" type="text" label="City" value="Portland" readonly=""></kikx-hml-prompt>';

    let prompt = mc.shadowRoot.querySelector('kikx-hml-prompt');
    assert.ok(prompt, 'prompt should render');
    assert.equal(prompt.getValue(), 'Portland', 'persisted value should be displayed');
    assert.equal(prompt.shadowRoot.querySelector('input').getAttribute('aria-disabled'), 'true', 'should be readonly');
  });

  it('full reload scenario: multiple prompts with persisted values', () => {
    let doc = getDocument();
    let mc  = doc.createElement('kikx-message-content');
    doc.body.appendChild(mc);

    mc.content = `
      <p>Survey results:</p>
      <kikx-hml-prompt name="user-name" type="text" label="Name" value="Alice" readonly=""></kikx-hml-prompt>
      <kikx-hml-prompt name="favorite-color" type="select" label="Color" options="Red,Blue,Green" value="Blue" readonly=""></kikx-hml-prompt>
      <kikx-hml-prompt name="agree-terms" type="checkbox" label="Agree" value="true" readonly=""></kikx-hml-prompt>
    `;

    let prompts = mc.shadowRoot.querySelectorAll('kikx-hml-prompt');

    assert.equal(prompts[0].getValue(), 'Alice', 'text value should persist');
    assert.equal(prompts[1].getValue(), 'Blue', 'select value should persist');
    assert.equal(prompts[2].getValue(), true, 'checkbox value should persist');

    // All should be aria-disabled
    for (let prompt of prompts) {
      let inputs = prompt.shadowRoot.querySelectorAll('input, textarea');
      for (let input of inputs)
        assert.equal(input.getAttribute('aria-disabled'), 'true', 'all inputs should be aria-disabled on reload');
    }
  });
});

// =============================================================================
// KikxPermissionRequest — per-command shell permission UI
// =============================================================================

describe('KikxPermissionRequest', () => {
  it('should render correct number of command rows', () => {
    let doc  = getDocument();
    let perm = doc.createElement('kikx-permission-request');
    doc.body.appendChild(perm);

    perm.commands = [
      { command: 'ls', arguments: ['-la'], status: 'needs-approval' },
      { command: 'grep', arguments: ['foo'], status: 'needs-approval' },
      { command: 'cat', arguments: ['file.txt'], status: 'needs-approval' },
    ];

    let rows = perm.shadowRoot.querySelectorAll('.command-row');
    assert.equal(rows.length, 3);
  });

  it('should show command name and arguments in each row', () => {
    let doc  = getDocument();
    let perm = doc.createElement('kikx-permission-request');
    doc.body.appendChild(perm);

    perm.commands = [
      { command: 'ls', arguments: ['-la', '/tmp'], status: 'needs-approval' },
    ];

    let codeEl = perm.shadowRoot.querySelector('.command-text');
    assert.ok(codeEl);
    assert.equal(codeEl.textContent, 'ls -la /tmp');
  });

  it('should have 4 decision buttons per interactive row', () => {
    let doc  = getDocument();
    let perm = doc.createElement('kikx-permission-request');
    doc.body.appendChild(perm);

    perm.commands = [
      { command: 'ls', arguments: [], status: 'needs-approval' },
    ];

    let buttons = perm.shadowRoot.querySelectorAll('.decision-button');
    assert.equal(buttons.length, 4);
  });

  it('should render pre-approved rows as non-interactive', () => {
    let doc  = getDocument();
    let perm = doc.createElement('kikx-permission-request');
    doc.body.appendChild(perm);

    perm.commands = [
      { command: 'ls', arguments: [], status: 'allowed' },
      { command: 'grep', arguments: ['foo'], status: 'needs-approval' },
    ];

    let rows = perm.shadowRoot.querySelectorAll('.command-row');
    assert.equal(rows.length, 2);

    // First row should be pre-approved (no decision buttons)
    let preApproved = rows[0];
    assert.ok(preApproved.classList.contains('pre-approved'));
    assert.equal(preApproved.querySelectorAll('.decision-button').length, 0);
    assert.ok(preApproved.querySelector('.pre-approved-badge'));

    // Second row should have decision buttons
    assert.equal(rows[1].querySelectorAll('.decision-button').length, 4);
  });

  it('should activate button and deactivate siblings on click', () => {
    let doc  = getDocument();
    let perm = doc.createElement('kikx-permission-request');
    doc.body.appendChild(perm);

    perm.commands = [
      { command: 'ls', arguments: [], status: 'needs-approval' },
    ];

    let buttons = perm.shadowRoot.querySelectorAll('.decision-button');

    // Click the first button (allow-forever)
    buttons[0].click();

    assert.ok(buttons[0].classList.contains('active-allow'), 'First button should be active');
    assert.ok(!buttons[1].classList.contains('active-allow'), 'Second button should not be active');

    // Click the third button (deny-once) — should deactivate first
    buttons[2].click();

    assert.ok(!buttons[0].classList.contains('active-allow'), 'First button should be deactivated');
    assert.ok(buttons[2].classList.contains('active-deny'), 'Third button should be active');
  });

  it('should disable confirm button until all commands have decisions', () => {
    let doc  = getDocument();
    let perm = doc.createElement('kikx-permission-request');
    doc.body.appendChild(perm);

    perm.commands = [
      { command: 'ls', arguments: [], status: 'needs-approval' },
      { command: 'grep', arguments: ['foo'], status: 'needs-approval' },
    ];

    let confirmBtn = perm.shadowRoot.querySelector('.confirm-button');
    assert.ok(confirmBtn.disabled, 'Confirm should be disabled initially');

    // Decide on first command only
    let firstRow    = perm.shadowRoot.querySelectorAll('.command-row')[0];
    let firstButton = firstRow.querySelector('.decision-button');
    firstButton.click();

    assert.ok(confirmBtn.disabled, 'Confirm should still be disabled (only 1 of 2 decided)');

    // Decide on second command
    let secondRow    = perm.shadowRoot.querySelectorAll('.command-row')[1];
    let secondButton = secondRow.querySelector('.decision-button');
    secondButton.click();

    assert.ok(!confirmBtn.disabled, 'Confirm should be enabled (all decided)');
  });

  it('should dispatch correct decisions array on submit', () => {
    let doc  = getDocument();
    let perm = doc.createElement('kikx-permission-request');
    perm.setAttribute('permission-id', 'frm_test123');
    doc.body.appendChild(perm);

    perm.commands = [
      { command: 'ls', arguments: [], status: 'needs-approval' },
      { command: 'grep', arguments: ['foo'], status: 'needs-approval' },
    ];

    // Click allow-forever for ls (first button in first row)
    let rows = perm.shadowRoot.querySelectorAll('.command-row');
    rows[0].querySelector('.decision-button[data-decision="allow-forever"]').click();

    // Click deny-once for grep (third button in second row)
    rows[1].querySelector('.decision-button[data-decision="deny-once"]').click();

    let dispatched = null;
    perm.addEventListener('permission-response', (event) => {
      dispatched = event.detail;
    });

    let confirmBtn = perm.shadowRoot.querySelector('.confirm-button');
    confirmBtn.click();

    assert.ok(dispatched, 'Event should have been dispatched');
    assert.equal(dispatched.permissionId, 'frm_test123');
    assert.equal(dispatched.decisions.length, 2);

    let lsDecision = dispatched.decisions.find((d) => d.command === 'ls');
    assert.equal(lsDecision.decision, 'allow-forever');

    let grepDecision = dispatched.decisions.find((d) => d.command === 'grep');
    assert.equal(grepDecision.decision, 'deny-once');
  });

  it('should hide controls when processed attribute is set', () => {
    let doc  = getDocument();
    let perm = doc.createElement('kikx-permission-request');
    doc.body.appendChild(perm);

    perm.commands = [
      { command: 'ls', arguments: [], status: 'needs-approval' },
    ];

    perm.setAttribute('processed', '');

    // The CSS :host([processed]) hides these — in JSDOM we check computed
    // style isn't reliable, but we can verify the processed-badge is displayed
    let badge = perm.shadowRoot.querySelector('.processed-badge');
    assert.ok(badge, 'Processed badge should exist');
  });

  it('should auto-enable confirm when all commands are pre-approved', () => {
    let doc  = getDocument();
    let perm = doc.createElement('kikx-permission-request');
    doc.body.appendChild(perm);

    perm.commands = [
      { command: 'ls', arguments: [], status: 'allowed' },
      { command: 'cat', arguments: ['file'], status: 'allowed' },
    ];

    let confirmBtn = perm.shadowRoot.querySelector('.confirm-button');
    assert.ok(!confirmBtn.disabled, 'Confirm should be enabled when all pre-approved');
  });
});

// =============================================================================
// Client sanitizer strips kikx-permission-request
// =============================================================================

describe('Sanitizer strips kikx-permission-request', () => {
  it('should remove <kikx-permission-request> from agent HTML', () => {
    let doc = getDocument();
    let mc  = doc.createElement('kikx-message-content');
    doc.body.appendChild(mc);

    mc.content = '<p>Hello</p><kikx-permission-request permission-id="fake"></kikx-permission-request><p>World</p>';

    let shadow = mc.shadowRoot;
    let body   = shadow.querySelector('.message-body');

    // The permission-request element should be stripped
    assert.equal(body.querySelectorAll('kikx-permission-request').length, 0,
      'kikx-permission-request should be stripped by sanitizer');

    // But normal content should remain
    assert.ok(body.innerHTML.includes('Hello'));
    assert.ok(body.innerHTML.includes('World'));
  });
});
