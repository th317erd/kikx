'use strict';

// Patch the stored `Question` frame once its question has been answered.
//
// WHY THIS EXISTS
//
// `ask-user-tool` writes one `Question` frame per question, with the question
// document copied into `content` at ask time. Nothing ever rewrote that content
// afterwards, so the frame stayed frozen at `status: 'open'` with no `answer`
// field for the rest of the session's life.
//
// The inline frame in the thread renders from that content (`_question()` in
// `kikx-question-frame.mjs` reads `frame.content`), so:
//
//   - answering updated the store and the Inbox,
//   - but the thread's copy still said `open`, with no answer,
// and the next render of that frame put the textarea and Submit button back on
// a question that had already been answered. The user saw a form they had just
// filled in, empty again — and could submit a second time into a 409.
//
// The client also keeps the sent answer in the DOM after a successful submit,
// which covers the common case, but that is per-node state: any full rebuild
// (session switch, reload, reconnect) discarded it and re-derived `open` from
// the frozen frame. Patching the frame is what makes the answered state
// durable, so every renderer — inline frame, a fresh browser, a reload — sees
// the same thing.
//
// HOW
//
// The engine's supported in-place mutation is `merge()` with the existing frame
// spread in, which `frameRuntime.recoverStaleRuntimeFrames()` already does for
// stale frames. `deepMerge` copies untouched keys, so the patch below only has
// to name the fields it changes; `text`, `askedAt`, `priority` and the rest
// survive. The merge is `silent` so it does not route an agent turn: this is a
// record update, not a message.

const PATCH_AUTHOR_ID = 'question-answer-patch';

/**
 * Merge the answered state into a stored `Question` frame.
 *
 * Returns `true` when a frame was patched, `false` when there was nothing to
 * patch (no `frameID`, or the frame is not loaded in this session's engine).
 * Never throws: a missing patch is a display downgrade, and failing the
 * user's answer because a cosmetic record could not be updated would be worse
 * than the cosmetic record being stale.
 */
export async function patchQuestionFrameContent(context = {}, question = null, options = {}) {
  let frameID = typeof question?.frameID === 'string' ? question.frameID : '';
  let sessionID = typeof question?.sessionID === 'string' ? question.sessionID : '';
  if (frameID === '' || sessionID === '')
    return false;

  let runtime = options.frameRuntime || context?.services?.frameRuntime || context?.frameRuntime;
  if (!runtime || typeof runtime.ensureSessionEntry !== 'function')
    return false;

  try {
    let entry = await runtime.ensureSessionEntry(sessionID);
    let existing = entry?.frameEngine?.get?.(frameID);
    if (!existing || typeof entry.frameEngine.merge !== 'function')
      return false;

    entry.frameEngine.merge([ {
      ...existing,
      // Spread the existing content back in. A same-id `merge()` is handled by
      // `_storeFrame`, which REPLACES the frame rather than running the
      // `MERGEABLE_FIELDS` deep-merge path (that one only runs for `targets`).
      // Passing a partial `content` here therefore drops `text`, `id`,
      // `priority` and the rest — which rendered the card as
      // "Question unavailable." The spec caught exactly that.
      content: {
        ...existing.content,
        status: question.status,
        answer: question.answer ?? null,
        answeredAt: question.answeredAt ?? null,
      },
    } ], {
      authorType: 'system',
      authorID: PATCH_AUTHOR_ID,
      silent: true,
    });

    await runtime.frameStore?.flush?.();
    return true;
  } catch {
    // Deliberately swallowed: see the doc comment. The answer is already
    // durable in the questions store by the time this runs.
    return false;
  }
}

export default patchQuestionFrameContent;
