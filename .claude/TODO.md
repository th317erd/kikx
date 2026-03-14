# TODO: Ed25519 Identity + ValueStore + Danger Level Permissions

## Status Key
- [ ] Not started
- [~] In progress
- [x] Complete

---

## Wave 1 — Complete
- [x] A1+A2: SMK + Ed25519 on Keystore
- [x] B1: ValueStore Model

## Wave 2 — Complete
- [x] A3: System Key Pair
- [x] A4+A5: User + Agent Key Pairs
- [x] B2: ValueStoreService

## Wave 3 — Complete
- [x] B3: Agent Config → ValueStore
- [x] B4: Session Context → ValueStore
- [x] B5: User Settings via ValueStore
- [x] B6: Memory Tools
- [x] C1: Frame Signature Field

## Wave 4 — Complete
- [x] C2: PermissionService → Ed25519
- [x] C3: PermissionEngine Fingerprint → Ed25519
- [x] C4: PermissionPlugin Update
- [x] C5: Frame Authorship Signing

## Wave 5 — Complete

- [x] **D1: Permission Engine 3-Way Branch** (51 tests)
  - Resolution chain: agent config → user settings → 'strict'
  - strict/normal/permissive, 'medium' → 'normal' backward compat
  - Tests: spec/core/permissions/permission-engine-risklevel-spec.mjs

- [x] **D2: API Endpoints** (36 tests)
  - Agent controller: accept riskLevel, sign via ValueStore
  - Auth controller: accept riskLevel, sign via ValueStore
  - Tests: spec/server/controllers/risklevel-api-spec.mjs

- [x] **D3: UI** (11 tests)
  - Agent form modal: dropdown (Account Default, Strict, Normal, Permissive)
  - Settings page: permissions tab (Strict, Normal, Permissive)

## Wave 6 — Complete

- [x] Tamper Detection Integration Tests (39 tests)
- [x] Existing Test Updates (handled by Wave 3-5 agents)
- [x] Full Test Suite Run — 2863 tests, 0 failures
- [x] Puppeteer E2E Testing
  - Login, settings permissions tab, agent form dropdown, API round-trip
  - Bug found + fixed: pre-existing users without Ed25519 keys crash on riskLevel save
  - Fix: generate keys on-the-fly during login and updateProfile
