# P9 dev verification — AeorDB scheduled-frame fallback

Date: 2026-10-04. Commit: `ac5bef5` + `8ca3c21` (legacy kind), not pushed.

## Environment
- Dev AeorDB `127.0.0.1:6830`, build **0.9.5**.
- The dev `kikx-dev` systemd service could NOT be booted for this check: its
  launcher (`scripts/start-kikx-dev.mjs:waitForAeorDBReady`) requires
  `status === 'healthy'`, but the 6-day-old manually-started dev AeorDB reports
  `degraded` (a known-benign 0.9.5 state). This is a pre-existing, unrelated dev
  environment issue, not caused by the P9 change.

## Method
Ran the patched code directly against the live dev AeorDB, exercising exactly
what booting dev would: `new FrameRuntime({ aeordb })` → `frameStore.listScheduledFrames()`
→ `sweepStaleAutonomousWakes()`.

## Results
- `queryFiles` → **HTTP 404** (endpoint absent on 0.9.5); `searchFiles` → 11 matches.
- `listScheduledFrames()` **before fix would be 0**; with the patched store → **1**
  (`7e1a689f`, `scheduledStatus:'firing'`, `continuation.kind:'agent-respond-and-continue'`, ~4 days old).
- `sweepStaleAutonomousWakes()` → **cancelled 1**.
- Re-read of the frame: `scheduledStatus:'cancelled'`.
- `listScheduledFrames()` after → **0** pending.

## Conclusion
- P9 fallback works: the store now finds persisted scheduled frames on AeorDB 0.9.5
  instead of silently returning empty.
- The boot sweep cancels the stale pre-fix wake, and the legacy
  `agent-respond-and-continue` kind is recognised (so it is retired, not fired).

## Not yet run
- A full `kikx-dev` boot on the new commit (blocked by the unrelated dev-AeorDB
  `degraded` gate). Recommend either restarting the dev AeorDB or relaxing the
  launcher's health gate to accept `degraded`, then booting dev for the live
  end-to-end pass.
- A bounded live async-wake chain on dev.

## Deploy status
NOT pushed, NOT deployed (owner ruling R7).
