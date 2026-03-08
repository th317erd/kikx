# Phase C3: Migrate Permission Flow to Router

## Status: COMPLETE

## Overview
System envelope signing (HMAC-SHA256 on deterministic blobs) on Keystore.
PermissionService wrapping PermissionEngine + signing with standing approval support.
BasePluginClass.checkPermission() wired to real permission system.
Permission routing plugin observes tool-call frames and verifies signatures.

## Steps

### Step 1: Envelope signing on Keystore
- [x] Add `canonicalize(data)` — deterministic JSON (sorted keys, recursive)
- [x] Add `sign(data)` — HMAC-SHA256 with REK
- [x] Add `verify(data, signature)` — timing-safe HMAC verification
- [x] 19 tests

### Step 2: PermissionService
- [x] Create `src/core/permissions/permission-service.mjs`
- [x] `check(featureName, args, options)` — evaluate + sign if allowed
- [x] `createStandingApproval(options)` — session-scoped signed allow rules
- [x] `revokeStandingApproval(sessionID, options)` — remove standing approvals
- [x] `signApproval(featureName, args, sessionID)` — envelope signing
- [x] `verifyApproval(featureName, args, signature, sessionID)` — verification
- [x] 18 tests

### Step 3: Wire BasePluginClass.checkPermission()
- [x] Accesses PermissionService from context
- [x] Returns { approved: true, signature } or { approved: false, reason }
- [x] Graceful fallback when no PermissionService available
- [x] Handles PermissionDeniedError
- [x] 6 tests

### Step 4: Create permission internal plugin
- [x] `src/core/internal-plugins/permissions/index.mjs`
- [x] Registers for `type:tool-call` via routing
- [x] Verifies signatures on tool-call frames
- [x] Warns on invalid signatures
- [x] 7 tests

### Step 5: Wire into Application
- [x] PermissionService created after Keystore initialization
- [x] Stored on context as 'permissionService'

### Step 6: Full test suite verification
- [x] All 1587 tests pass (0 failures)
- [x] Commit
