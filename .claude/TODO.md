# TODO: Ed25519 / Key-Pair Encryption Gaps

## Gap 1: Agent key generation on creation — COMPLETE
- [x] agent-controller.mjs already generates key pair on create (lines 61-66)
- [x] Write tests verifying controller-created agents have publicKey + encryptedPrivateKey
  - File: spec/server/controllers/agent-controller-spec.mjs (new, 10/10 passing)
- [ ] Commit: "fix(ed25519): add agent key-gen controller tests [gap 1]"

## Gap 2: User private key passed to InteractionLoop for frame signing — IN PROGRESS
- [ ] interaction-controller.mjs sendMessage() no-agent path: decrypt user private key, pass to postMessage()
- [ ] interaction-controller.mjs sendMessage() agent path: decrypt user private key, pass userPrivateKey to startInteraction()
- [ ] Handle gracefully: user has no encryptedPrivateKey -> pass null (best-effort)
- [ ] Write tests verifying user-authored frames have signature set
- [ ] Run tests + commit: "fix(ed25519): pass userPrivateKey to interaction loop [gap 2]"

## Gap 3: Frame model signingKeyFingerprint field — PENDING
- [ ] Add signingKeyFingerprint: { type: Types.STRING(64), allowNull: true } to frame-model.mjs
- [ ] Bump frame model version 2 -> 3
- [ ] Update _signFrame() in interaction/index.mjs to compute and return { signature, fingerprint }
- [ ] Update _createFrame() in interaction/index.mjs to set signingKeyFingerprint on frameData
- [ ] Write tests for signingKeyFingerprint field
- [ ] Run tests + commit: "fix(ed25519): add signingKeyFingerprint to frame model [gap 3]"

## Gap 4: Danger-level permissions — ALREADY COMPLETE
- [x] _resolveRiskLevel() already in permission-engine.mjs
- [x] Tests already exist in permission-engine-risklevel-spec.mjs (all passing)

## Gap 5: Risk level signing — SKIPPED (lower priority)

## Final
- [ ] Run full npm test
- [ ] commit: "fix(ed25519): finished"

---

## Previous Work: Solr Integration — COMPLETE
- [x] docker-compose.yml, scripts/solr-start.sh, schema, config, .dockerignore, .gitignore
- [x] src/core/lib/solr-service.mjs — SolrError + SolrService (fetch-based)
- [x] Wired into Application._initializeCore() -> context.setProperty('solrService')
- [x] ControllerBase.getSolrService() accessor added
- [x] 58 unit tests, full suite 3758/3758 passing
