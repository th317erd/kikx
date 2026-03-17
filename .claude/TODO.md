# TODO: Fix `/reload` Ghost Message Bug (SSE Auto-Reconnection)

## Problem

The `/reload` command (and all other SSE-dependent features) breaks after a server
restart because the SSE stream disconnects and never reconnects. The user sees:
- Ghost message stays pending (faded)
- No command-result appears
- No agent streaming works
- Status bar shows "Disconnected" but no recovery happens

## Root Cause

`_connectStream()` is called once per session load. When the SSE stream drops (server
restart, network hiccup, timeout), `_readSSEStream()` exits and sets status to
"disconnected" but never attempts to reconnect.

## Fix: SSE Auto-Reconnection

- [x] Step 1: Add reconnection logic to `_readSSEStream` / `_connectStream`
  - When stream ends normally (reader.read() returns done:true), wait and reconnect
  - Use exponential backoff (2s → 4s → 8s → max 30s)
  - Reset backoff on successful reconnection
  - Cap max reconnection attempts (e.g., 20)
  - Don't reconnect if `_disconnectStream()` was called intentionally (abort signal)

- [x] Step 2: Write unit tests for SSE reconnection logic
  - Test: reconnects after stream drop
  - Test: exponential backoff timing
  - Test: stops after max attempts
  - Test: doesn't reconnect after intentional disconnect
  - Test: resets backoff after successful reconnection

## Status: COMPLETE
