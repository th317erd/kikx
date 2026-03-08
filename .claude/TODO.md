# Reactive Frame Engine — Status

## Completed Phases

### Phase A: Commit Log, Refs, Diff, Windowed Loading (COMPLETE)
### Phase B: Multi-Agent Infrastructure (COMPLETE)
### Phase C: Event Routing Layer (COMPLETE)

| Sub-phase | Description | Commit | Tests |
|-----------|-------------|--------|-------|
| C1 | Frame Event Router Foundation | `e2da672` | 99 new (1530 total) |
| C2 | Migrate scheduling to router | `29b670c` | 36 new (1566 total) |
| C3 | Permission service + envelope signing | `9cc8f9d` | 50 new (1587 total) |
| C4 | Hook system → routing plugins | `f9f82d9` | 21 new (1595 total) |
| C5 | Slim InteractionLoop (1151→566 lines) | `482683d` | 55 new (1659 total) |

### E2E Verification (API-level)
- Login → create session → add agent → send message → agent responds with tool use → frames persisted ✅
- All frame types correct, order sequential, author attribution correct ✅
- Puppeteer test blocked by pre-existing nginx config issue (see below)

---

## Next: Phase D (Streaming) — NEEDS DISCUSSION

Phase D requires design decisions the user should weigh in on:

1. **Browser EventEmitter**: Shared FrameManager uses `node:events`.
   Client needs either a polyfill (importmap) or adapter pattern.

2. **Wire protocol**: Current WS sends `{ type: 'frame', frame }`.
   Phase D implies commit streaming. Format needs agreement.

3. **Storage adapter**: Interface designed but not implemented.
   SQLite via Mythix ORM is the planned implementation.

4. **Client FrameManager ↔ DOM wiring**: Which component owns the
   FrameManager? How do commits drive re-renders?

---

## Nginx Fix (needs sudo reload)

Fixed `/kikx/shared/` location block in `nginx/locations.nginx-include`.
The nested `location ~* \.mjs$` inside an `alias` block caused path
resolution failure (nginx alias + nested regex = broken). Replaced with
a `types` directive in the parent block. Needs `sudo nginx -s reload`.

---

## Future Plans Assessment

After reviewing all items in `bot-docs/plan/kikx/future-plans.yaml`:

| Plan | Priority | Ready Now? | Notes |
|------|----------|------------|-------|
| `checkPermission-api-naming` | Low | Yes | Simple rename, good cleanup |
| `sessions-as-frames` | Medium | No | Major architecture change |
| `generator-suspension` | Medium | Not yet | Needs Phase D streaming first |
| `general-re-feed-recovery` | Low | After D | Needs router + frame load patterns |
| `configurable-plugin-ordering` | Low | No | Wait for third-party plugins |
| `abilities-system` | Medium | Partial | DM sessions exist, needs DM summary wiring |
| `signatures-federation` | Low | No | Post-launch |
| `key-rotation` | Medium | Yes | Natural extension of C3 signing work |

**Recommendation**: `key-rotation` is the most valuable to implement soon —
it extends the envelope signing from C3 and hardens the crypto foundation
before Phase D adds streaming. `checkPermission-api-naming` is a quick win
for code clarity.
