# TODO: Remove Shadow DOM + Consolidate CSS

## Context

All 31 shadow DOM components use the same pattern: `attachShadow({ mode: 'open' })` +
template clone + inline `<style>` with `:host`. This creates testing friction (multi-level
shadow piercing in Puppeteer), DevTools inspection pain, and ~30-40% CSS duplication
across components.

**Goal:** Remove shadow DOM entirely. Keep web components (custom elements). Consolidate
duplicated CSS into shared stylesheets. Only truly unique styles remain inline.

## Phase 1: Shared CSS Files

- [ ] Create `src/client/styles/components.css` with consolidated patterns:
  - Glass backgrounds (15+ components)
  - Primary/secondary buttons (12+ components)
  - Form inputs, labels, groups (8+ components)
  - List item hover states (10+ components)
  - Modal/panel chrome (4+ modals)
  - Scrollbar styles (move from scrollbar-styles.mjs to CSS)
- [ ] Add `<link rel="stylesheet" href="styles/components.css">` to index.html

## Phase 2: Remove Shadow DOM (31 components)

For each component:
- Remove `this.attachShadow({ mode: 'open' })`
- Change `this.shadowRoot.appendChild(...)` → `this.appendChild(...)`
- Replace all `this.shadowRoot.querySelector` → `this.querySelector`
- Replace all `this.shadowRoot.querySelectorAll` → `this.querySelectorAll`
- Convert `:host` → tag name selector (e.g., `kikx-sidebar`)
- Convert `:host(.foo)` → `kikx-sidebar.foo`
- Convert `:host([attr])` → `kikx-sidebar[attr]`
- Move duplicated CSS to components.css, keep unique styles inline
- Scope remaining inline selectors under the tag name

### Component Groups (by complexity):

**Simple (minimal CSS, quick conversion):**
- kikx-websocket-manager, kikx-scroll-anchor, kikx-hml-prompt-value,
  kikx-participant-list, kikx-reflection-block, kikx-command-result,
  kikx-session-link, kikx-websearch-result, kikx-user-avatar

**Medium (moderate CSS, some shared patterns):**
- kikx-status-bar, kikx-top-bar, kikx-friends-list, kikx-chat-view,
  kikx-interaction, kikx-message-content, kikx-message-input,
  kikx-session-list, kikx-settings-tabs

**Complex (heavy CSS, many shared patterns, event delegation):**
- kikx-sidebar, kikx-session-page, kikx-login-page, kikx-modal,
  kikx-settings-page, kikx-hml-prompt

**Modals (near-identical CSS, biggest duplication win):**
- kikx-agent-form-modal, kikx-create-session-modal, kikx-agent-list-modal,
  kikx-ability-list-modal, kikx-ability-wizard-modal, kikx-add-friend-modal,
  kikx-permission-request

## Phase 3: Fix Tests + E2E

- [ ] Update E2E helpers: remove shadow DOM traversal (getShadowRoot, etc.)
- [ ] Update E2E specs: remove shadow piercing queries
- [ ] Update unit tests: remove shadowRoot references
- [ ] Run full test suite

## Phase 4: Cleanup

- [ ] Remove scrollbar-styles.mjs (moved to components.css)
- [ ] Update DETAILS.md
