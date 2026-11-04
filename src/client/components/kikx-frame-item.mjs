'use strict';

import './kikx-user-message-frame.mjs';
import './kikx-coordination-frame.mjs';
import { isCoordinationWakeFrame } from '../../shared/coordination-visibility.mjs';
import { buildFrameQuickActions, quickActionSpecForFrame, syncExpandCollapseButton } from './kikx-frame-quick-actions.mjs';
import { elements, $, cleanupBindings } from '../lib/aeor-ui.mjs';
import { guardClientOperation } from '../lib/error-boundary.mjs';
import { renderMarkdownToElement } from '../lib/markdown-renderer.mjs';
import { highlightSearchMatches } from '../lib/search-highlight.mjs';
import { frameMatchesQuery } from '../../shared/frame-window-filters.mjs';
import {
  frameDisplayLabel,
  frameTimestamp,
} from './frame-labels.mjs';
import { resolveFrameComponentDescriptor } from './frame-component-registry.mjs';
import { sessionReferenceFromFrame } from './kikx-sub-session-frame.mjs';
import { buildCompactFrameDisclosure, updateCompactSummary } from './compact-frame-view.mjs';
import {
  compactFrameHeader,
  frameMoodBand,
  frameStatus,
  frameStatusClass,
  isBotCommunicationFrame,
  isCompactFrame,
} from './tool-frame-summary.mjs';
import { applyFrameDelivery } from './frame-delivery-status.mjs';
import { setIcon } from '../lib/icons.mjs';
import { countRebuild } from './render-stats.mjs';
import { isFrameExpanded, isFrameRevealed, revealFrame, setFrameExpanded, setFrameRevealed } from '../state/frame-expansion.mjs';
import './kikx-typing-indicator.mjs';
import './kikx-sub-session-frame.mjs';
import {
  MINIMIZED_EXCEPTIONS,
  buildHeaderStatus,
  frameDebugClass,
  frameHeaderStatus,
  frameKey,
  hasTagName,
  isToolFrame,
  renderHeaderStatusLabel,
  setTextIfChanged,
  typingAgentName,
  typingThinkingText,
} from './kikx-frame-item-helpers.mjs';
import {
  bindFrameSearchObserver,
  frameSearchQuery,
  frameSearchRoot,
  highlightFrameSearch,
  onFrameContentToggle,
  onFrameSearchMutation,
  syncFrameSearchHint,
} from './frame-item-search.mjs';
import { buildFrameContent, reconcileFrameContent } from './kikx-frame-item-content.mjs';

const { div, span, strong, time } = elements;

export class KikxFrameItem extends HTMLElement {
  constructor() {
    super();
    this._frame = null;
    this._appState = null;
    this._frameKey = null;
    this._metaElement = null;
    this._contentElement = null;
    this._contentKind = null;
    this._contentTag = null;
    this._lastMarkdownText = null;
    this._compact = false;
    this._minimized = false;
    this._compactView = null;
    this._contentParent = null;
    this._quickActions = null;
    this._renderEpoch = 0;
    this._searchObserver = null;
    this._searchObserverRoot = null;
    this._searchHighlightScheduled = false;
    this._searchHighlighting = false;
  }

  updateFrame(frame, appState = {}, options = {}) {
    let nextFrame = frame || null;
    let nextAppState = appState || {};
    let nextKey = frameKey(nextFrame);
    let keyChanged = this._frameKey !== nextKey;
    let appStateChanged = this._appState !== nextAppState;

    if (
      options.force !== true
      && !keyChanged
      && !appStateChanged
      && this._frame === nextFrame
    )
      return;

    this._frame = nextFrame;
    this._appState = nextAppState;
    this._frameKey = nextKey;

    // Object identity is only one rebuild trigger: a different key or app state
    // requires a wholesale rebuild, but a fresh frame object for the same logical
    // frame is reconciled in place so the subtree (and its animations) survive.
    // A different app-state object is not a reason to rebuild the frame. The
    // scoped stores and the frame record own the values this item renders; the
    // item can reconcile them in place. Only an explicit force or a changed
    // frame identity is structural.
    if (options.force === true || keyChanged)
      this._render();
    else
      this._reconcile();

    if (this._quickActions)
      this._quickActions._frame = nextFrame;
  }

  connectedCallback() {
    if (!this._compactClickBound) {
      this._compactClickBound = true;
      this.addEventListener('click', this._onCompactClick);
      this.addEventListener('keydown', this._onCompactKeydown);
      this.addEventListener('toggle', this._onContentToggle, true);
    }

    if (this._frame && this.childNodes.length === 0)
      this._render();
  }

  // Compact frames toggle when clicked anywhere (not just the short summary
  // line), except while selecting text or interacting with a control.
  _onCompactClick(event) {
    let details = this._compactView?.element;
    if (!details)
      return;

    // Only the frame header bar may expand/collapse the row. Clicks anywhere
    // else (content, controls, scrollbars) are selection/interaction, not a
    // toggle request.
    let headerTarget = false;
    if (typeof event.target?.closest === 'function') {
      headerTarget = !!event.target.closest('.kikx-frame__meta, .kikx-frame__compact-summary');
    } else {
      headerTarget = event.target === this._metaElement
        || !!this._metaElement?.contains?.(event.target)
        || event.target === this._compactView?.summary
        || !!this._compactView?.summary?.contains?.(event.target);
    }
    if (!headerTarget)
      return;

    // Clicking inside expanded content is selection/scroll interaction, not a
    // request to collapse the row. In particular, the horizontal scrollbar on
    // a <pre> must not close the disclosure under the pointer.
    if (event.target?.closest?.('a, button, input, textarea, select, summary, pre, code, .kikx-frame__compact-body'))
      return;

    let selection = globalThis.getSelection?.();
    if (selection && selection.isCollapsed === false)
      return;

    if (this._minimized) {
      this._revealMinimized();
      return;
    }

    details.open = !details.open;
  }

  _onCompactKeydown(event) {
    if (!this._minimized || (event.key !== 'Enter' && event.key !== ' '))
      return;
    if (event.target?.closest?.('a, button, input, textarea, select, summary'))
      return;

    event.preventDefault();
    this._revealMinimized();
  }

  _revealMinimized() {
    let frameID = this._frame?.id;
    if (frameID)
      revealFrame(frameID);
    this._minimized = false;
    this.classList.remove('kikx-frame--minimized');
    if (this._compactView) {
      this._compactView.element.hidden = false;
      this._compactView.element.open = false;
    }
    this._syncMinimizedAccessibility();
  }

  _syncMinimizedAccessibility() {
    if (!this._metaElement)
      return;

    if (this._minimized) {
      this._metaElement.setAttribute('role', 'button');
      this._metaElement.setAttribute('tabindex', '0');
      this._metaElement.setAttribute('aria-expanded', 'false');
      this._metaElement.setAttribute('aria-label', 'Expand message');
    } else {
      this._metaElement.removeAttribute('role');
      this._metaElement.removeAttribute('tabindex');
      this._metaElement.removeAttribute('aria-expanded');
      this._metaElement.removeAttribute('aria-label');
    }
  }

  disconnectedCallback() {
    this._searchObserver?.disconnect();
    this._searchObserver = null;
    this._searchObserverRoot = null;
    cleanupBindings(this);
  }

  _render() {
    let frame = this._frame;
    if (!frame)
      return;

    countRebuild('frameItem');
    let previous = {
      contentKind: this._contentKind,
      contentTag: this._contentTag,
      lastMarkdownText: this._lastMarkdownText,
    };

    // Build the new subtree against a detached tree first, then swap it in. A
    // throwing renderer must leave the previous DOM (and its refs) untouched.
    let rendered = guardClientOperation('kikx-frame-item.render', () => {
      let compact = this._shouldCompact(frame);
      let meta = null;
      let content = null;
      if (frame.type === 'BeginTyping') {
        content = this._buildTypingIndicator(frame);
        this._contentKind = null;
        this._contentTag = null;
        this._lastMarkdownText = null;
      } else {
        meta = this._buildFrameMeta(frame, compact);
        // Compact frames keep only their summary and command preview in the DOM.
        // The tool card/output subtree is built on first expansion, not eagerly.
        if (!compact)
          content = buildFrameContent(this, frame);
      }

      cleanupBindings(this);
      $(this).empty();
      this._appendHoverTarget();
      this._metaElement = meta;
      this._contentElement = content;
      this._compact = compact;
      this._compactView = null;
      this._contentParent = this;
      this._minimized = compact
        && this._shouldMinimize(frame)
        && !isFrameRevealed(frame.id)
        && !isFrameExpanded(frame.id);

      this._applyFrameState(frame, compact);

      if (compact) {
        this._compactView = buildCompactFrameDisclosure(frame, [], document);
        this._contentParent = this._compactView.body;
        // Rebuilding this item must not collapse a frame the user opened.
        // Expansion lives in a module-level store keyed by frame id, not in
        // the DOM, because `_render()` throws the whole subtree away. The
        // store never opens anything on its own: an id the user never
        // expanded reports false, so the default stays collapsed.
        this._compactView.element.open = !this._minimized && isFrameExpanded(frame.id);
        // Keep the "{Name} {time}" header visible above the compact line.
        if (meta)
          this.appendChild(meta);
        this._syncMinimizedAccessibility();
        // Expanding the compact row builds the details; nested output/arguments
        // disclosures stay lazy until the user opens them too. Collapsing removes
        // the whole details subtree again.
        let detailsElement = this._compactView.element;
        let renderEpoch = ++this._renderEpoch;
        detailsElement.addEventListener('toggle', () => this._onCompactToggle(renderEpoch, detailsElement));
        this.appendChild(this._compactView.element);
        this._highlightSearch(this._compactView.element);
        if (this._compactView.element.open)
          this._ensureCompactContent();
      } else {
        if (meta)
          this.appendChild(meta);
        if (content)
          this.appendChild(content);
      }

      if (content)
        this._highlightSearch(content);
      this._bindSearchObserver();
      // Only frames whose subtree carries disclosures get the expand button —
      // see quickActionSpecForFrame. A button with no <details> to toggle is
      // a dead affordance: its handler iterates an empty list forever.
      this._quickActions = buildFrameQuickActions(
        frame,
        document,
        quickActionSpecForFrame(frame, this._frameTreeHasDetails()),
      );
      this.appendChild(this._quickActions);
      syncExpandCollapseButton(this._quickActions);

      return true;
    }, { frameID: frame.id, frameType: frame.type });

    if (!rendered) {
      this._contentKind = previous.contentKind;
      this._contentTag = previous.contentTag;
      this._lastMarkdownText = previous.lastMarkdownText;
    }
  }

  // Does this frame's rendered subtree carry disclosures? Called while the
  // subtree is detached (mid-_render) or already attached (reconcile) — never
  // mid-`$(this).empty()` mutation.
  _frameTreeHasDetails() {
    let probe = this._compactView
      ? this._compactView.element
      : this._contentElement;
    if (!probe)
      return this.querySelectorAll('details').length > 0;
    // The compact view root IS a <details>, and querySelectorAll never matches
    // the root itself — count it explicitly or every compact frame would look
    // disclosure-free.
    if (probe.localName === 'details')
      return true;
    return probe.querySelectorAll('details').length > 0;
  }

  _appendHoverTarget() {
    let target = document.createElement('div');
    target.className = 'kikx-frame__hover-target';
    target.setAttribute('aria-hidden', 'true');
    this.appendChild(target);
  }

  _applyFrameState(frame, compact) {
    let status = frameStatus(frame);
    let tinted = compact || isBotCommunicationFrame(frame) || frame.type === 'Question';
    let className = `kikx-frame kikx-frame--${frame.type}`;
    // A coordination wake is persisted as a UserMessage, and `.kikx-frame--
    // UserMessage` right-aligns the frame for owner chat (app.css:678). The wake
    // is a system event, not a message from a person, so it carries a modifier
    // that resets that alignment and the bubble treatment.
    if (isCoordinationWakeFrame(frame))
      className += ' kikx-frame--coordination';
    if (compact)
      className += ' kikx-frame--compact';
    if (this._minimized)
      className += ' kikx-frame--minimized';
    if (tinted)
      className += ` ${frameStatusClass(status)}`;

    this.className = className;
    this.setAttribute('role', 'listitem');
    this.dataset.frameId = frame.id || '';
    this.dataset.frameType = frame.type || '';
    this.dataset.toolName = frame.content?.toolName || '';
    let moodBand = frameMoodBand(frame);
    if (moodBand)
      this.dataset.moodBand = moodBand;
    else
      this.removeAttribute('data-mood-band');

    if (tinted)
      this.dataset.frameStatus = status;
    else
      this.removeAttribute('data-frame-status');

    // A user message is never `tinted` (BOT_COMMUNICATION_TYPES excludes it),
    // so delivery needs its own code path or the state would be stored, reach
    // `frame.updated`, and never appear. No-op for every other frame type.
    // Apply it last: delivery intentionally promotes a UserMessage to the
    // shared success status, which the generic tinted/status branch above would
    // otherwise clear again.
    applyFrameDelivery(this, frame);
  }

  _shouldCompact(frame) {
    return isCompactFrame(frame) && !sessionReferenceFromFrame(frame);
  }

  _shouldMinimize(frame) {
    if (!isToolFrame(frame) || sessionReferenceFromFrame(frame))
      return false;

    let toolName = String(frame?.content?.toolName || '');
    return !MINIMIZED_EXCEPTIONS.has(toolName);
  }

  _reconcile() {
    let frame = this._frame;
    if (!frame) {
      this._render();
      return;
    }

    let compact = this._shouldCompact(frame);
    if (compact !== this._compact || (compact && !this._compactView)) {
      this._render();
      return;
    }

    guardClientOperation('kikx-frame-item.reconcile', () => {
      this._applyFrameState(frame, compact);

      if (frame.type === 'BeginTyping') {
        this._reconcileTypingIndicator(frame);
        return;
      }

      if (!this._metaElement) {
        this._render();
        return;
      }

      // A frame whose class or content gained disclosures (or lost them) gets
      // the expand button added or removed with it — a toolbar built while the
      // subtree was empty must not keep a button that toggles nothing.
      this._syncQuickActionsToTree();

      if (compact) {
        updateCompactSummary(this._compactView, frame);
        this._highlightSearch(this._compactView.element);
        this._bindSearchObserver();
        this._reconcileFrameMeta(frame);
        if (this._compactView.element.open) {
          this._ensureCompactContent();
          if (this._contentElement)
            reconcileFrameContent(this, frame);
        } else {
          this._discardContentElement();
        }
        return;
      }

      this._reconcileFrameMeta(frame);
      reconcileFrameContent(this, frame);
    }, { frameID: frame.id, frameType: frame.type });
  }

  // Rebuild only the quick-action bar when the measured spec changed. The bar
  // is cheap (two buttons), so rebuilding on spec change keeps `_frame` wiring
  // correct without a partial-button sync.
  _syncQuickActionsToTree() {
    if (!this._quickActions)
      return;
    let spec = quickActionSpecForFrame(this._frame, this._frameTreeHasDetails());
    let hasQuote = !!this._quickActions.querySelector('.kikx-frame__quick-action--quote');
    let hasExpand = !!this._quickActions.querySelector('.kikx-frame__quick-action--expand-collapse');
    if (hasQuote === spec.quote && hasExpand === spec.expand) {
      this._quickActions._frame = this._frame;
      return;
    }

    this._quickActions = buildFrameQuickActions(this._frame, document, spec);
    this.appendChild(this._quickActions);
    syncExpandCollapseButton(this._quickActions);
  }

  _onCompactToggle(renderEpoch = this._renderEpoch, detailsElement = this._compactView?.element) {
    let details = this._compactView?.element;
    // A removed <details> can still deliver a queued toggle after its owner has
    // been rebuilt. Only the current render's element may mutate expansion.
    if (!details
      || renderEpoch !== this._renderEpoch
      || detailsElement !== details)
      return;

    // Record what the user just did so a later rebuild can restore it.
    setFrameExpanded(this._frame?.id, details.open);
    if (this._quickActions)
      syncExpandCollapseButton(this._quickActions);

    if (!details.open) {
      this._discardContentElement();
      if (this._shouldMinimize(this._frame)) {
        this._minimizeFrame();
        return;
      }
      return;
    }

    this._ensureCompactContent();
    this._highlightSearch(this._compactView?.element);
  }

  _onContentToggle(event) {
    return onFrameContentToggle(this, event);
  }

  _minimizeFrame() {
    let frameID = this._frame?.id;
    if (frameID)
      setFrameRevealed(frameID, false);
    this._minimized = true;
    this.classList.add('kikx-frame--minimized');
    this._discardContentElement();
    if (this._compactView) {
      this._compactView.element.open = false;
      this._compactView.body.replaceChildren();
    }
    this._syncMinimizedAccessibility();
  }

  _ensureCompactContent() {
    if (this._contentElement || !this._compactView)
      return;

    let content = buildFrameContent(this, this._frame);
    if (!content)
      return;

    this._contentElement = content;
    this._contentParent = this._compactView.body;
    this._contentParent.appendChild(content);
    this._highlightSearch(content);
    this._bindSearchObserver();
    // The lazy-built tool card may carry disclosures (nested output/argument
    // folds). The toolbar was built before this content existed, so a frame
    // that starts disclosure-free can become expandable here.
    this._syncQuickActionsToTree();
  }

  _reconcileTypingIndicator(frame) {
    let indicator = this._contentElement;
    if (!hasTagName(indicator, 'kikx-typing-indicator')) {
      this._discardContentElement();
      this._contentElement = this._buildTypingIndicator(frame);
      this.appendChild(this._contentElement);
      return;
    }

    indicator.agentName = typingAgentName(frame);
    indicator.thinkingText = typingThinkingText(frame);
  }

  _reconcileFrameMeta(frame) {
    let main = this._metaElement.querySelector('.kikx-frame__meta-main');
    let label = main?.querySelector('strong');
    if (label)
      setTextIfChanged(label, frameDisplayLabel(frame, this._appState));

    let status = this._metaElement.querySelector('.kikx-frame__meta-status');
    let statusData = frameHeaderStatus(frame, this._compact, this._appState);
    if (status && statusData) {
      let statusLabel = status.querySelector('.kikx-frame__meta-status-label');
      if (statusLabel)
        renderHeaderStatusLabel(statusLabel, statusData);

      let icon = status.querySelector('.kikx-frame__compact-icon');
      if (icon && icon.dataset.icon !== statusData.icon)
        setIcon(icon, statusData.icon, { ownerDocument: icon.ownerDocument || document });
    }

    let timestamp = frameTimestamp(frame);
    let timeElement = main?.querySelector('.kikx-frame__timestamp');
    if (timestamp) {
      if (!timeElement) {
        timeElement = time.class('kikx-frame__timestamp')
          .datetime(timestamp.dateTime)
          .title(timestamp.title)('')
          .build(document);
        main?.appendChild(timeElement);
      }
      if (timeElement.getAttribute('datetime') !== timestamp.dateTime)
        timeElement.setAttribute('datetime', timestamp.dateTime);
      if (timeElement.getAttribute('title') !== timestamp.title)
        timeElement.setAttribute('title', timestamp.title);
      setTextIfChanged(timeElement, timestamp.label);
    } else if (timeElement) {
      timeElement.remove();
    }

    let debugClass = main?.querySelector('.kikx-frame__debug-class');
    let debugLabel = frameDebugClass(frame);
    if (!debugClass && main) {
      debugClass = span.class('kikx-frame__debug-class')(debugLabel).build(document);
      main.appendChild(debugClass);
    } else if (debugClass) {
      setTextIfChanged(debugClass, debugLabel);
    }
  }

  _searchQuery() {
    return frameSearchQuery(this);
  }

  _searchRoot() {
    return frameSearchRoot(this);
  }

  _highlightSearch(root = this._searchRoot()) {
    return highlightFrameSearch(this, root);
  }

  _syncSearchHint(visibleCount = 0) {
    return syncFrameSearchHint(this, visibleCount);
  }

  _bindSearchObserver() {
    return bindFrameSearchObserver(this);
  }

  _onSearchMutation() {
    return onFrameSearchMutation(this);
  }

  _discardContentElement() {
    if (!this._contentElement)
      return;

    cleanupBindings(this._contentElement);
    this._contentElement.remove();
    this._contentElement = null;
    this._contentKind = null;
    this._contentTag = null;
    this._lastMarkdownText = null;
  }

  _buildTypingIndicator(frame) {
    let indicator = document.createElement('kikx-typing-indicator');
    indicator.agentName = typingAgentName(frame);
    indicator.thinkingText = typingThinkingText(frame);
    return indicator;
  }

  _buildFrameMeta(frame, compact = false) {
    let timestamp = frameTimestamp(frame);
    let main = div.class('kikx-frame__meta-main')(
      strong(frameDisplayLabel(frame, this._appState)),
      timestamp
        ? time
          .class('kikx-frame__timestamp')
          .datetime(timestamp.dateTime)
          .title(timestamp.title)(timestamp.label)
        : null,
      span.class('kikx-frame__debug-class')(frameDebugClass(frame)),
    ).build(document);

    return div.class('kikx-frame__meta')(
      main,
      buildHeaderStatus(frame, compact, this._appState),
    ).build(document);
  }


}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-frame-item'))
  customElements.define('kikx-frame-item', KikxFrameItem);
