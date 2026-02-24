# Client Plan — Conversation Round 7

## Round 6 Resolved
- Message content: simple HTML only (b, i, s, ol, ul, li, table, etc.). Server parser handles format. Client whitelists.
- Sub-sessions: flexible parentId. Don't over-design. Navigation = swap + breadcrumb (debug feature mostly).
- Categories: auto by participant count. Private = 2. Channel = 3+. Purely organizational. Expandable/collapsible sections.
- JSON-to-HTML: server-side concern. Not client architecture. Don't over-engineer.

---

## Status

We've completed 6 rounds of design Q&A. The plan (`client-plan.yaml`) now has:

- **35+ resolved questions** spanning layout, theming, state, routing, testing, components, error handling, scrolling, i18n, @mentions, multi-user, sessions, categories, sub-sessions, archive/revive, DOM utilities, and more
- **35+ components** in the tree with clear descriptions
- **3-tier test strategy** with 6 test helpers, showcase demo pages, mock strategy, coverage goals
- **4-wave dependency graph** with clear ordering
- **Full feature specs** for all 10 areas (C1-C10)

The only open question is accessibility (keyboard nav, screen readers).

## My Questions

### Q1: Ready to Move Forward?

You left Q4 blank last round. I want to check: are we done designing, or do you have more areas you want to explore?

If we're done designing, my next step would be to create a detailed implementation plan — the concrete TODO list for Phase 4 (Foundation), which would be:

1. Adapt query-engine.mjs + elements.mjs from mythix-ui-core
2. FrameManager (already spec'd — 9 phases in frame-manager.yaml)
3. Design system CSS (black-glass theme, scrollbar theme, base reset)
4. i18n.mjs + en.mjs locale
5. store.mjs (global seqda store with scopes)
6. api.mjs (REST client layer)
7. router.mjs (history-based)
8. hero-application.mjs (root router + auth guard)
9. hero-login-page.mjs
10. nginx config update (static file serving)

Each of these would get a detailed task breakdown in TODO.md before we start building.

### Q2: Accessibility — Quick Take

The one open question. For V2 launch, what's the minimum?

**A: Basics** — Semantic HTML, ARIA labels on interactive elements, keyboard-navigable forms (tab order, Enter to submit). No screen reader optimization beyond what semantic HTML gives us for free.

**B: Full** — ARIA live regions for streaming content, screen reader announcements for new messages, keyboard shortcuts for navigation, focus management for modals, skip-to-content links.

I'd recommend A for launch, with the architecture set up so B is achievable later. Semantic HTML + proper tab order + ARIA labels on buttons/inputs covers the most ground with the least effort. Thoughts?

<!-- 
I agree, but I don't want to forget this, so please put it into "future-plans"
 -->

---

*Answer inline and I'll fold into the plan.*

<!-- RESPOND BELOW
I think we are ready to go. Please be the coordinator, and use your AGIS skills to coordinate sub-agents to implement this plan. Please make sure you commit everything before you start.
-->
