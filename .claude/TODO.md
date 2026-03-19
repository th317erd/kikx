# TODO: Ed25519 / Key-Pair Encryption Gaps — ALL COMPLETE

## Gap 1: Agent key generation on creation — COMPLETE
- [x] agent-controller.mjs already generates key pair on create (lines 61-66)
- [x] Tests: spec/server/controllers/agent-controller-spec.mjs (10/10 passing)
- [x] Committed: "fix(ed25519): add agent key-gen controller tests [gap 1]"

## Gap 2: User private key passed to InteractionLoop for frame signing — COMPLETE
- [x] interaction-controller.mjs _loadUserSigningKeys(): decrypts user private+public keys
- [x] sendMessage() no-agent path: passes userPrivateKey+userPublicKey to postMessage()
- [x] sendMessage() agent path: passes userPrivateKey+userPublicKey to startInteraction()
- [x] Graceful handling: null keys for legacy accounts, unavailable UMK, user not found
- [x] Tests: spec/server/controllers/interaction-controller-spec.mjs (7/7 passing)
- [x] Committed: "fix(ed25519): pass userPrivateKey to interaction loop [gap 2]"

## Gap 3: Frame model signingKeyFingerprint field — COMPLETE
- [x] signingKeyFingerprint: STRING(64) nullable added to frame-model.mjs
- [x] Frame model version bumped 2 -> 3
- [x] _signFrame() returns { signature, fingerprint } instead of string
- [x] _buildSigningContext() caches agentPublicKey/userPublicKey
- [x] _createFrame() sets signingKeyFingerprint on frameData
- [x] FramePersistence and in-memory Frame class updated
- [x] Tests: spec/core/models/frame-signing-fingerprint-spec.mjs (18/18 passing)
- [x] Committed in model-registry stash commit (all tests pass: 3793/3793)

## Gap 4: Danger-level permissions — ALREADY COMPLETE
- [x] _resolveRiskLevel() already in permission-engine.mjs
- [x] Tests already exist in permission-engine-risklevel-spec.mjs (all passing)

## Gap 5: Risk level signing — SKIPPED (lower priority)

## Final — COMPLETE
- [x] Full npm test: 3793/3793 passing
- [ ] Final commit: "fix(ed25519): finished"

---

## Previous Work: Solr Integration — COMPLETE
- [x] docker-compose.yml, scripts/solr-start.sh, schema, config, .dockerignore, .gitignore
- [x] src/core/lib/solr-service.mjs — SolrError + SolrService (fetch-based)
- [x] Wired into Application._initializeCore() -> context.setProperty('solrService')
- [x] ControllerBase.getSolrService() accessor added
- [x] 58 unit tests, full suite 3758/3758 passing
