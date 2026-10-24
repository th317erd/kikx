'use strict';

// The Inbox row and the in-thread Question frame are ONE renderer (owner's
// screenshot: "the Inbox should use real Question frames").
//
// These two surfaces used to be two renderers, and they drifted exactly as two
// renderers do: the frame showed the answer the Inbox row would not, and the
// Inbox row had a settle fuse the thread had no equivalent of. Unifying them is
// only worth anything if the specific things that must NOT collapse stay
// distinct, so this spec pins both halves:
//
//   - the row is a real `kikx-question-frame`, not a second card;
//   - the row keeps the `<article class="kikx-question-card" data-question-id>`
//     shape the reconciler and the Playwright lane address, and the frame inside
//     does NOT also carry that class (or every row is counted twice);
//   - the Inbox vocabulary is used inside the row, because that is what the
//     existing specs and the stylesheet address;
//   - the thread keeps its own vocabulary, so the transcript does not start
//     speaking Inbox class names;
//   - answering settles BOTH surfaces; the difference is only what happens
//     after — the Inbox row drains a receipt window and closes, the thread keeps
//     the frame and minimises;
//   - batch position and context references are Inbox-only, because a thread
//     already has the conversation around it.

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);

installDom();

const { KikxQuestionFrame, renderInboxQuestionRow } = await import('../../src/client/components/kikx-question-frame.mjs');
const { buildInboxList } = await import('../../src/client/components/kikx-inbox-list.mjs');

// --- helpers ---------------------------------------------------------------

function walk(node, out = []) {
  for (let child of node?.childNodes || []) {
    out.push(child);
    walk(child, out);
  }
  return out;
}

function byClass(root, className) {
  return walk(root).filter((node) => {
    let cls = typeof node.className === 'string' ? node.className : '';
    return cls.split(/\s+/).includes(className);
  });
}

function byTag(root, tagName) {
  return walk(root).filter((node) => node.localName === tagName);
}

function textOf(node) {
  if (!node)
    return '';
  if (node.nodeType === 3)
    return String(node.textContent ?? node.data ?? '');
  return (node.childNodes || []).map(textOf).join('');
}

function question(overrides = {}) {
  return {
    id: 'q_1',
    groupID: 'grp_1',
    index: 1,
    status: 'open',
    mode: 'wait',
    sessionID: 'ses_1',
    agentID: 'agent-1',
    text: 'Which database should we use?',
    priority: 'normal',
    askedAt: Date.now() - 60_000,
    ...overrides,
  };
}

function appWith(questions) {
  return {
    _state: {
      questionsState: { questions, counts: { open: questions.length }, loaded: true },
    },
  };
}

function mountFrame(overrides = {}, options = {}) {
  let el = document.createElement('kikx-question-frame');
  el.updateFrame({ id: 'f_1', type: 'Question', content: { question: question(overrides) } }, {}, options);
  return el;
}

// --- the row is a real frame ----------------------------------------------

test('an Inbox row mounts a real kikx-question-frame rather than a second renderer', () => {
  let row = renderInboxQuestionRow({}, question());

  assert.ok(row, 'the adapter returns a row');
  let frames = byTag(row, 'kikx-question-frame');
  assert.equal(frames.length, 1, 'exactly one Question frame per row');
  assert.ok(frames[0] instanceof KikxQuestionFrame, 'and it is the registered component, not a lookalike');
});

test('the row keeps the article shape the reconciler and the browser lane address', () => {
  let row = renderInboxQuestionRow({}, question());

  assert.equal(row.localName, 'article', 'Playwright selects article.kikx-question-card[data-question-id]');
  assert.equal(row.getAttribute('data-question-id'), 'q_1');
  assert.equal(row.getAttribute('data-question-status'), 'open');
  assert.equal(row.getAttribute('data-question-settled'), 'false');
});

test('the frame inside a row does NOT carry .kikx-question-card, or rows are counted twice', () => {
  let row = renderInboxQuestionRow({}, question());
  let frame = byTag(row, 'kikx-question-frame')[0];

  let classes = String(frame.className).split(/\s+/);
  assert.ok(classes.includes('kikx-question-frame'), 'the frame keeps its own name');
  assert.ok(classes.includes('kikx-question-frame--inbox'), 'and marks itself as the Inbox variant');
  assert.ok(!classes.includes('kikx-question-card'),
    'a frame carrying the row class would be collected as a second row by querySelectorAll');
});

// --- vocabulary -----------------------------------------------------------

test('the row speaks the Inbox vocabulary, which is what the specs and stylesheet address', () => {
  let row = renderInboxQuestionRow({}, question());

  assert.equal(byClass(row, 'kikx-question-card__header').length, 1);
  assert.equal(byClass(row, 'kikx-question-card__text').length, 1);
  assert.equal(byClass(row, 'kikx-question-card__input').length, 1, 'the textarea keeps the Inbox name');
  assert.equal(byClass(row, 'kikx-question-card__submit').length, 1);
  assert.equal(byClass(row, 'kikx-question-card__answer').length, 1, 'and the form keeps the Inbox name');
});

test('the thread keeps its own vocabulary, so the transcript does not speak Inbox names', () => {
  let el = mountFrame();

  assert.equal(byClass(el, 'kikx-question-frame__card').length, 1);
  assert.equal(byClass(el, 'kikx-question-frame__answer').length, 1);
  assert.equal(byClass(el, 'kikx-question-frame__submit').length, 1);
  assert.equal(byClass(el, 'kikx-question-card__input').length, 0, 'no Inbox names leak into the thread');
  assert.equal(byClass(el, 'kikx-question-card__answer').length, 0);
});

// --- Inbox-only chrome ----------------------------------------------------

test('batch position and context references appear in the Inbox row and not in the thread', () => {
  let refs = [ { type: 'file', id: 'src/app.mjs', label: 'src/app.mjs' } ];
  let row = renderInboxQuestionRow({}, question({ index: 2, contextRefs: refs }), { groupCount: 3 });
  let thread = mountFrame({ index: 2, contextRefs: refs });

  assert.match(textOf(byClass(row, 'kikx-question-card__position')[0]), /2 of 3/);
  assert.equal(byClass(row, 'kikx-question-card__ref').length, 1);

  assert.equal(byClass(thread, 'kikx-question-frame__position').length, 0,
    'a question alone in a thread has nothing to be positioned against');
  assert.equal(byClass(thread, 'kikx-question-frame__ref').length, 0,
    'the thread already has the conversation around it');
});

test('the Inbox row offers the settle fuse only once its receipt window is open', () => {
  let closedAt = Date.now();
  let settled = renderInboxQuestionRow({}, question({
    status: 'answered',
    answer: 'Postgres.',
    answerSource: 'user',
    closedAt,
    settleAfter: 60_000,
  }));

  assert.equal(settled.getAttribute('data-question-settled'), 'true');
  assert.equal(settled.getAttribute('data-settled-until'), String(closedAt + 60_000));
  assert.equal(byClass(settled, 'kikx-question-card__dismiss-close--settle').length, 1,
    'the draining ring is what lets a person see their answer landed before the row closes');

  // A terminal row learned from the server has no window and therefore no fuse.
  let learned = renderInboxQuestionRow({}, question({ status: 'answered', answer: 'Postgres.' }));
  assert.equal(learned.getAttribute('data-question-settled'), 'false');
  assert.equal(byClass(learned, 'kikx-question-card__dismiss-close--settle').length, 0);
});

// --- answering: same behaviour, different ending --------------------------

test('a row and a thread answer through the same path, given the same question', async () => {
  let seen = [];
  let handlers = { onSubmit: (questionID, text) => { seen.push([ questionID, text ]); } };

  let row = renderInboxQuestionRow({}, question(), { handlers });
  let rowInput = byClass(row, 'kikx-question-card__input')[0];
  rowInput.value = 'Postgres.';
  let rowForm = byClass(row, 'kikx-question-card__answer')[0];
  rowForm.dispatchEvent(new CustomEvent('submit', { bubbles: true, cancelable: true }));

  let thread = mountFrame();
  let threadInput = byClass(thread, 'kikx-question-frame__answer')[0];
  threadInput.value = 'Postgres.';
  let threadForm = byClass(thread, 'kikx-question-frame__card')[0];
  threadForm.dispatchEvent(new CustomEvent('submit', { bubbles: true, cancelable: true }));

  assert.equal(seen.length, 1, 'the Inbox row reports intent through the caller handler');
  assert.deepEqual(seen[0], [ 'q_1', 'Postgres.' ]);
});

test('an answered question shows what was said on both surfaces, not just the word', () => {
  let overrides = { status: 'answered', answer: 'Postgres.', answerSource: 'user' };

  let row = renderInboxQuestionRow({}, question(overrides));
  let thread = mountFrame(overrides);

  assert.match(textOf(byClass(row, 'kikx-question-card__receipt-text')[0]), /Postgres\./);
  assert.match(textOf(byClass(thread, 'kikx-question-frame__answer-text')[0]), /Postgres\./);
});

test('a delivered default is never labelled as the user\'s words on either surface', () => {
  let overrides = { status: 'answered', answer: 'Postgres.', answerSource: 'default' };

  let row = renderInboxQuestionRow({}, question(overrides));
  let thread = mountFrame(overrides);

  assert.equal(byClass(row, 'kikx-question-card__receipt-label')[0]?.textContent,
    byClass(thread, 'kikx-question-frame__answer-label')[0]?.textContent,
    'the two surfaces cannot disagree about who spoke');
  assert.match(textOf(byClass(row, 'kikx-question-card__receipt-label')[0]), /Default answer/);
});

// --- the list actually uses it -------------------------------------------

test('buildInboxList renders rows through the adapter, one frame each', () => {
  let list = buildInboxList(appWith([ question({ id: 'q_1' }), question({ id: 'q_2', groupID: 'grp_2' }) ]));

  assert.equal(byClass(list, 'kikx-question-card').length, 2, 'two rows');
  assert.equal(byTag(list, 'kikx-question-frame').length, 2, 'each row holds one real frame');
  assert.equal(byClass(list, 'kikx-question-card__input').length, 2, 'and each row is answerable');
});

// --- the three behaviours that only the dead binder had -------------------
//
// When the Inbox stopped calling `bindAnswerForm` and started mounting frames
// instead, three behaviours existed in the binder and nowhere else. The full
// suite stayed green, because every spec drove the CARD directly rather than
// through `buildInboxList` -- so nothing observed the production path.
//
// These tests drive the ROW, which is the path the app actually takes.

test('focusing the answer box clears the unread badge, and only once', () => {
  let read = [];
  let row = renderInboxQuestionRow({}, question(), {
    handlers: { onRead: (questionID) => read.push(questionID) },
  });

  let input = byClass(row, 'kikx-question-card__input')[0];
  input.dispatchEvent(new CustomEvent('focus'));
  input.dispatchEvent(new CustomEvent('focus'));

  assert.deepEqual(read, [ 'q_1' ],
    'a row looked at is read once; refocusing is not a second read');
});

test('a row with no read handler still focuses without throwing', () => {
  let row = renderInboxQuestionRow({}, question());
  let input = byClass(row, 'kikx-question-card__input')[0];

  assert.doesNotThrow(() => input.dispatchEvent(new CustomEvent('focus')));
});

test('the settle fuse retires the row instead of recording a refusal', () => {
  let retired = [];
  let dismissed = [];
  let closedAt = 1_000;

  let row = renderInboxQuestionRow({}, question({
    status: 'answered',
    answer: 'Postgres.',
    answerSource: 'user',
    closedAt,
    settleAfter: 60_000,
  }), {
    now: closedAt,
    handlers: {
      onSettleExpired: (questionID) => retired.push(questionID),
      onDismissAnswer: (questionID) => dismissed.push(questionID),
    },
  });

  let ring = byClass(row, 'kikx-question-card__dismiss-close--settle')[0];
  assert.ok(ring, 'the row has a fuse to fire');
  ring.dispatchEvent(new CustomEvent('auto-complete'));

  assert.deepEqual(retired, [ 'q_1' ], 'the row has had its window and leaves');
  assert.deepEqual(dismissed, [],
    'the fuse must not run the dismissal path, which would overwrite the answer with "chose not to respond"');
});

test('pressing the still-draining ring retires the row the same way', () => {
  let retired = [];
  let dismissed = [];
  let closedAt = 1_000;

  let row = renderInboxQuestionRow({}, question({
    status: 'answered',
    answer: 'Postgres.',
    answerSource: 'user',
    closedAt,
    settleAfter: 60_000,
  }), {
    now: closedAt,
    handlers: {
      onSettleExpired: (questionID) => retired.push(questionID),
      onDismissAnswer: (questionID) => dismissed.push(questionID),
    },
  });

  byClass(row, 'kikx-question-card__dismiss-close--settle')[0]
    .dispatchEvent(new CustomEvent('confirm'));

  assert.deepEqual(retired, [ 'q_1' ], 'close-now and the elapsed window are the same ending');
  assert.deepEqual(dismissed, []);
});

test('Escape abandons an untouched box but never throws away typed text', () => {
  let withdrawn = [];
  let handlers = { onDismissAnswer: (questionID) => withdrawn.push(questionID) };
  let row = renderInboxQuestionRow({}, question(), { handlers });

  let input = byClass(row, 'kikx-question-card__input')[0];
  let form = byClass(row, 'kikx-question-card__answer')[0];

  // A real KeyboardEvent carries `key`; Node ships a native CustomEvent whose
  // init dictionary drops it, so building one that way would test nothing.
  function escape() {
    let event = new Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'key', { configurable: true, value: 'Escape' });
    return event;
  }

  input.value = 'not yet sent';
  form.dispatchEvent(escape());
  assert.deepEqual(withdrawn, [], 'Escape over a half-typed answer would discard work');

  input.value = '';
  form.dispatchEvent(escape());
  assert.deepEqual(withdrawn, [ 'q_1' ], 'an untouched box is abandoned the way the card always allowed');
});
