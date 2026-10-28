'use strict';

// The "the system woke this bot" card.
//
// Shown for a coordination wake that `isCoordinationWakeFrame` admits — today
// that is the invite wake a coordinator writes when it hands work to a bot
// (src/core/runtime/frame-runtime-sessions.mjs:667-720). The owner's complaint
// was that a worker bot appeared mid-thread with no visible handoff and no
// visible instruction; this is the handoff and the instruction, in the thread,
// where it happened.
//
// It must read as NEITHER owner chat nor agent output. Owner messages render
// through `kikx-user-message-frame` on the right with a chat bubble; agent
// output renders as markdown prose. This is a full-width, dashed, muted banner
// that names both parties ("Kikx session invite woke Kikx-Node-Eng") and keeps
// the instruction behind a <details> so a long brief cannot regress the density
// of the thread.
//
// The instruction text is untrusted-ish in the sense that it is generated, not
// typed by the owner, so it is set as TEXT, never as markdown or HTML. Nothing
// in this file writes to the frame.

import { describeCoordinationWake } from '../../shared/coordination-visibility.mjs';

const SUMMARY_CLOSED = 'Show instruction';
const SUMMARY_OPEN = 'Hide instruction';
const AUTHOR_LABEL = 'Kikx session invite';

export class KikxCoordinationFrame extends HTMLElement {
  constructor() {
    super();
    this._frame = null;
    this._text = null;
    this._structureReady = false;
    this._headline = null;
    this._meta = null;
    this._summary = null;
    this._instruction = null;
    this._details = null;
  }

  updateFrame(frame) {
    this._frame = frame || null;
    this._ensureStructure();
    this._render();
  }

  _ensureStructure() {
    if (this._structureReady)
      return;

    this._structureReady = true;
    let root = document.createElement('div');
    root.className = 'kikx-coordination';

    let header = document.createElement('div');
    header.className = 'kikx-coordination__header';

    let eyebrow = document.createElement('span');
    eyebrow.className = 'kikx-coordination__eyebrow';
    // Says plainly that this is machine coordination, not a person speaking.
    eyebrow.textContent = 'System handoff';

    this._headline = document.createElement('p');
    this._headline.className = 'kikx-coordination__headline';

    this._meta = document.createElement('p');
    this._meta.className = 'kikx-coordination__meta';

    header.append(eyebrow, this._headline, this._meta);

    this._details = document.createElement('details');
    this._details.className = 'kikx-coordination__details';

    this._summary = document.createElement('summary');
    this._summary.className = 'kikx-coordination__summary';
    this._summary.textContent = SUMMARY_CLOSED;

    this._instruction = document.createElement('div');
    this._instruction.className = 'kikx-coordination__instruction';

    // A native <details> flips `open` itself when the summary is clicked; it does
    // not call back into this component. Without this listener the label stays on
    // "Show instruction" after the reader opens the body. `kikx-user-message-frame`
    // listens to `toggle` for the same reason.
    this._details.addEventListener('toggle', () => {
      this._summary.textContent = this._details.open ? SUMMARY_OPEN : SUMMARY_CLOSED;
    });

    this._details.append(this._summary, this._instruction);

    root.append(header, this._details);
    this.append(root);
  }

  _render() {
    let described = describeCoordinationWake(this._frame);
    let text = described.text;
    if (this._text === text)
      return;

    this._text = text;

    // "Kikx session invite woke Kikx-Node-Eng" — subject is the machine actor,
    // object is the bot, so the pair is readable without opening anything.
    this._headline.textContent = described.invitee
      ? `${AUTHOR_LABEL} woke ${described.invitee}`
      : `${AUTHOR_LABEL} woke an agent`;

    this._meta.textContent = metaLine(described);
    // Keep an empty meta line out of the layout rather than reserving a gap.
    this._meta.hidden = this._meta.textContent === '';

    this._instruction.textContent = described.instruction || text;
    this._summary.textContent = SUMMARY_CLOSED;
    this._details.open = false;
    this._details.hidden = this._instruction.textContent.trim() === '';
  }

  // Read back by the collapse summary and by specs.
  get expanded() {
    return this._details?.open === true;
  }

  toggleExpanded() {
    if (!this._details || this._details.hidden)
      return this.expanded;

    this._details.open = !this._details.open;
    this._summary.textContent = this._details.open ? SUMMARY_OPEN : SUMMARY_CLOSED;
    return this._details.open;
  }
}

function metaLine(described) {
  let parts = [];
  if (described.inviter)
    parts.push(`from ${described.inviter}`);
  if (described.sessionTitle)
    parts.push(`session “${described.sessionTitle}”`);
  return parts.join(' · ');
}

if (typeof customElements !== 'undefined' && !customElements.get('kikx-coordination-frame'))
  customElements.define('kikx-coordination-frame', KikxCoordinationFrame);
