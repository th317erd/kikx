'use strict';

// Kikx owns several direct scrollTop writes on the shared scrollview's
// viewport (bottom-follow loop, focus/anchor corrections, growth
// compensation). The component cannot see those, and to it they arrive as
// USER scrolls whenever its 1.5s intent window is warm — enough to flip
// `follow` off while Kikx still shows a pinned lock (owner report,
// 2026-11-05: "pinned/locked... I send a message, it breaks").
//
// Every such write must pass through this marker, which extends BOTH ignore
// windows: the consumer's (per-module, for its own scroll handler) and the
// component's ignore window (for `follow` classification). The consumer's
// own handler only breaks the lock on an explicit user GESTURE (wheel/touch/
// scrollbar/keys), which layout writes never set, so only the component's
// window needs extending here.
export function markFrameListProgrammaticWrite(frameList, ms = 220) {
  if (!frameList || typeof ms !== 'number' || ms <= 0)
    return;
  let host = frameList.closest?.('aeor-scrollview');
  host?.markProgrammaticScroll?.(ms);
}
