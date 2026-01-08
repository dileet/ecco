# Pull Request Breakdown

## Tier 1: Critical Security (59 Issues)

| Issue | Branch | Files | Fix | Priority |
| --- | --- | --- | --- | --- |
| [x] #563 Deployment leaves core contract ownership with deployer (dupes: #10) | fix/issue-563-deployment-leaves-core-contract-ownership-with-d | deploy.ts | Transfer ownership of token, registry, fee collector, work rewards to timelock | Tier 1 |
| [x] #555 Timelock admin can bypass governance controls | fix/issue-555-timelock-admin-can-bypass-governance-controls | EccoTimelock.sol | Require admin = timelock or zero, enforce role setup | Tier 1 |
| [x] #564 Timelock canceller role not assigned in deployment | fix/issue-564-timelock-canceller-role-not-assigned-in-deployme | deploy.ts | Grant CANCELLER_ROLE to governor or guardian | Tier 1 |
| [x] #140 Empty proposers/executors arrays | fix/issue-140-empty-proposers-executors-arrays | packages/contracts/src/EccoTimelock.sol | Validate non-empty | Tier 1 |
| [x] #141 minDelay can be set to 0 | fix/issue-141-mindelay-can-be-set-to-0 | packages/contracts/src/EccoTimelock.sol | Enforce minimum | Tier 1 |
| [x] #142 Admin renunciation locks contract | fix/issue-142-admin-renunciation-locks-contract | packages/contracts/src/EccoTimelock.sol | Prevent full renunciation | Tier 1 |
| [x] #136 Voting power snapshot race | fix/issue-136-voting-power-snapshot-race | packages/contracts/src/EccoGovernor.sol | Snapshot at block-1 | Tier 1 |
| [x] #137 Proposal threshold bypass via transfer | fix/issue-137-proposal-threshold-bypass-via-transfer | packages/contracts/src/EccoGovernor.sol | Lock tokens during proposal | Tier 1 |
| [x] #138 votingDelay=0 allows same-block voting | fix/issue-138-votingdelay-0-allows-same-block-voting | packages/contracts/src/EccoGovernor.sol | Enforce min delay | Tier 1 |
| [x] #557 Quorum counts staked/locked tokens that cannot vote | fix/issue-557-quorum-counts-staked-locked-tokens-that-cannot-v | EccoGovernor.sol; ReputationRegistry.sol | Exclude locked balances from quorum or delegate staked votes | Tier 1 |
| [x] #139 Quorum unachievable if tokens burned | fix/issue-139-quorum-unachievable-if-tokens-burned | packages/contracts/src/EccoGovernor.sol | Track circulating supply | Tier 1 |
| [x] #558 Burn reopens mint capacity, undermining deflation/quorum | fix/issue-558-burn-reopens-mint-capacity-undermining-deflation | EccoToken.sol; FeeCollector.sol | Track cumulative minted supply or reduce cap on burn | Tier 1 |
| [x] #532 Handshake never initiated or enforced | fix/issue-532-handshake-never-initiated-or-enforced | message-bridge.ts; lifecycle.ts | Wire handshake, gate messaging on validation | Tier 1 |
| [x] #533 Auth enabled but unsigned pubsub/broadcast accepted | fix/issue-533-auth-enabled-but-unsigned-pubsub-broadcast-accep | messaging.ts; message-bridge.ts | Require signatures when auth enabled | Tier 1 |
| [x] #53 Handshake auto-validates when config missing (dupes: #316) | fix/issue-053-handshake-auto-validates-when-config-missing | packages/core/src/transport/message-bridge.ts | Require config | Tier 1 |
| [x] #515 Queued messages bypass signature verification | fix/issue-515-queued-messages-bypass-signature-verification | packages/core/src/transport/message-bridge.ts | Re-verify on flush | Tier 1 |
| [x] #246 Public key not derived from signature | fix/issue-246-public-key-not-derived-from-signature | packages/core/src/services/auth.ts | Derive and verify | Tier 1 |
| [x] #199 JSON.stringify non-deterministic signatures | fix/issue-199-json-stringify-non-deterministic-signatures | packages/core/src/services/auth.ts | Use canonical JSON | Tier 1 |
| [x] #201 Unsafe Base64 decoding | fix/issue-201-unsafe-base64-decoding | packages/core/src/services/auth.ts | Validate format | Tier 1 |
| [x] #202 Missing signature length validation | fix/issue-202-missing-signature-length-validation | packages/core/src/services/auth.ts | Check length = 64 | Tier 1 |
| [x] #393 Base64 silent truncation | fix/issue-393-base64-silent-truncation | packages/core/src/services/auth.ts | Validate before decode | Tier 1 |
| [x] #51 Message 'from' not validated against signer (dupes: #75) | fix/issue-051-message-from-not-validated-against-signer | packages/core/src/node/messaging.ts | Verify match | Tier 1 |
| [x] #52 Rate limiting uses claimed sender (dupes: #74) | fix/issue-052-rate-limiting-uses-claimed-sender | packages/core/src/node/messaging.ts | Use transport peer ID | Tier 1 |
| [x] #221 Clock skew in message freshness | fix/issue-221-clock-skew-in-message-freshness | packages/core/src/services/auth.ts | Add tolerance | Tier 1 |
| [x] #205 Case-sensitive PeerId comparison | fix/issue-205-case-sensitive-peerid-comparison | Multiple files | Normalize case | Tier 1 |
| [x] #203 PeerId hash collision without canonicalization | fix/issue-203-peerid-hash-collision-without-canonicalization | packages/core/src/services/peer-binding.ts | Canonicalize first | Tier 1 |
| [x] #200 Timing attack in constitution hash | fix/issue-200-timing-attack-in-constitution-hash | packages/core/src/protocol/constitution.ts | Constant-time compare | Tier 1 |
| [x] #55 Plaintext private key storage | fix/issue-055-plaintext-private-key-storage | packages/core/src/node/identity.ts | Encrypt keys | Tier 1 |
| [x] #229 Identity file permissions not set | fix/issue-229-identity-file-permissions-not-set | packages/core/src/node/identity.ts | Set 0600 | Tier 1 |
| [x] #223 Insufficient key generation entropy | fix/issue-223-insufficient-key-generation-entropy | packages/core/src/node/identity.ts | Validate CSPRNG | Tier 1 |
| [x] #49 Math.random() for crypto operations | fix/issue-049-math-random-for-crypto-operations | orchestrator/index.ts; packages/core/src/orchestrator/index.ts | Use crypto.getRandomValues() | Tier 1 |
| [x] #523 Reputation filter gossip unauthenticated/unchecked | fix/issue-523-reputation-filter-gossip-unauthenticated-uncheck | node/bloom-filter.ts | Sign filters and validate size/hash | Tier 1 |
| [x] #548 Capability gossip unauthenticated (announcements/requests/responses) | fix/issue-548-capability-gossip-unauthenticated-announcements | capabilities.ts | Sign capability events and verify sender binding | Tier 1 |
| [x] #54 Invoice lacks authentication | fix/issue-054-invoice-lacks-authentication | packages/core/src/types.ts | Add signature field | Tier 1 |
| [x] #204 Payment ID nonce collision | fix/issue-204-payment-id-nonce-collision | packages/core/src/services/reputation-contract.ts | Add random component | Tier 1 |
| [x] #538 submit-payment-proof bypasses on-chain verification | fix/issue-538-submit-payment-proof-bypasses-on-chain-verificat | agent/index.ts; payments.ts | Verify proof before resolving | Tier 1 |
| [x] #9 Payment proof double-resolution | fix/issue-009-payment-proof-double-resolution | payments.ts | Add processed flag | Tier 1 |
| [x] #20 No receipt status validation | fix/issue-020-no-receipt-status-validation | Multiple files | Validate receipt | Tier 1 |
| [x] #247 ERC20 verification skipped | fix/issue-247-erc20-verification-skipped | packages/core/src/services/wallet.ts | Parse transfer logs | Tier 1 |
| [x] #18 No wallet balance checks | fix/issue-018-no-wallet-balance-checks | wallet.ts | Check before send | Tier 1 |
| [x] #113 No gas estimation or nonce handling | fix/issue-113-no-gas-estimation-or-nonce-handling | packages/core/src/services/wallet.ts | Add nonce manager | Tier 1 |
| [x] #309 Wallet missing nonce management | fix/issue-309-wallet-missing-nonce-management | packages/core/src/services/wallet.ts | Add nonce tracking | Tier 1 |
| [x] #19 Stuck payments no recovery | fix/issue-019-stuck-payments-no-recovery | payments.ts | Add recovery mechanism | Tier 1 |
| [x] #125 Milestone can be released multiple times (dupes: #258, #305, #334) | fix/issue-125-milestone-can-be-released-multiple-times | packages/core/src/services/payment.ts; packages/core/src/agent/payments.ts | Add atomic check | Tier 1 |
| [x] #245 Database transaction atomicity gap | fix/issue-245-database-transaction-atomicity-gap | packages/core/src/agent/payments.ts | Use transactions | Tier 1 |
| [x] #248 Off-chain/on-chain state desync | fix/issue-248-off-chain-on-chain-state-desync | packages/core/src/agent/payments.ts | Rollback on failure | Tier 1 |
| [x] #127 Missing approval flow enforcement | fix/issue-127-missing-approval-flow-enforcement | packages/core/src/agent/payments.ts | Enforce approver | Tier 1 |
| [x] #211 Integer overflow in token distribution | fix/issue-211-integer-overflow-in-token-distribution | packages/core/src/services/payment.ts | SafeMath | Tier 1 |
| [x] #128 Math.round() causes dust loss | fix/issue-128-math-round-causes-dust-loss | packages/core/src/services/payment.ts | Use integer math | Tier 1 |
| [x] #260 Invoice recipient not validated | fix/issue-260-invoice-recipient-not-validated | packages/core/src/agent/payments.ts | Validate context | Tier 1 |
| [x] #310 Contract addresses not validated | fix/issue-310-contract-addresses-not-validated | packages/core/src/services/reputation-contract.ts | Validate format | Tier 1 |
| [x] #73 Unbounded Response Promise Hang (dupes: #171) | fix/issue-073-unbounded-response-promise-hang | packages/core/src/orchestrator/index.ts | Add response promise timeout and clear handlers on expiry | Tier 1 |
| [x] #12 Owner can slash 100% of any stake (dupes: #76) | fix/issue-012-owner-can-slash-100-of-any-stake | ReputationRegistry.sol | Cap slash at 50%, redistribute | Tier 1 |
| [x] #22 Reputation unbounded manipulation (Sybil) | fix/issue-022-reputation-unbounded-manipulation-sybil | ReputationRegistry.sol | Add rate limiting | Tier 1 |
| [x] #230 Activity penalty encourages Sybil | fix/issue-230-activity-penalty-encourages-sybil | packages/contracts/src/ReputationRegistry.sol | Add cooldown | Tier 1 |
| [x] #77 No minimum cooldown enforcement | fix/issue-077-no-minimum-cooldown-enforcement | ReputationRegistry.sol | Add MIN_COOLDOWN | Tier 1 |
| [x] #100 Activity penalty integer division underflow | fix/issue-100-activity-penalty-integer-division-underflow | ReputationRegistry.sol | Check bounds | Tier 1 |
| [x] #88 Score can approach MIN_INT256 (dupes: #99, #463, #520) | fix/issue-088-score-can-approach-min-int256 | packages/contracts/src/ReputationRegistry.sol | Add bounds check | Tier 1 |
| [x] #87 Integer sqrt returns 0 for small stakes | fix/issue-087-integer-sqrt-returns-0-for-small-stakes | ReputationRegistry.sol | Handle edge case | Tier 1 |
| [x] #193 Rating weight calculation overflow | fix/issue-193-rating-weight-calculation-overflow | packages/contracts/src/ReputationRegistry.sol | Bounds check | Tier 1 |
| [x] #97 PeerId registration front-running | fix/issue-097-peerid-registration-front-running | ReputationRegistry.sol | Add commit-reveal | Tier 1 |
| [x] #96 paymentId collision via malicious hash | fix/issue-096-paymentid-collision-via-malicious-hash | ReputationRegistry.sol | Add namespace | Tier 1 |
| [x] #98 Batch rate can exceed block gas limit (dupes: #231, #358) | fix/issue-098-batch-rate-can-exceed-block-gas-limit | packages/contracts/src/ReputationRegistry.sol | Add MAX_BATCH_SIZE | Tier 1 |
| [x] #276 PeerId hash collision risk | fix/issue-276-peerid-hash-collision-risk | packages/contracts/src/ReputationRegistry.sol | Store full peerId | Tier 1 |
| [x] #277 Min/max stake not validated | fix/issue-277-min-max-stake-not-validated | packages/contracts/src/ReputationRegistry.sol | Validate relation | Tier 1 |
| [x] #537 recordPayment allows unverifiable amounts | fix/issue-537-recordpayment-allows-unverifiable-amounts | ReputationRegistry.sol | Require payment verification or trusted caller | Tier 1 |
| [x] #11 updateRewardDebt() is publicly callable and can zero pending rewards (dupes: #191) | fix/issue-011-update-reward-debt-access-control | packages/contracts/src/FeeCollector.sol | Restrict caller or make internal; update rewardDebt only on trusted flows | Tier 1 |
| [x] #189 Cross-contract state desync in fees | fix/issue-189-cross-contract-state-desync-in-fees | packages/contracts/src/FeeCollector.sol | Atomic read | Tier 1 |
| [x] #190 Reward debt underflow | fix/issue-190-reward-debt-underflow | packages/contracts/src/FeeCollector.sol | SafeMath check | Tier 1 |
| [x] #145 accPerShare overflow | fix/issue-145-accpershare-overflow | packages/contracts/src/FeeCollector.sol | Use SafeMath | Tier 1 |
| [x] #146 Reward debt desync | fix/issue-146-reward-debt-desync | packages/contracts/src/FeeCollector.sol | Sync on stake change | Tier 1 |
| [x] #147 Treasury can be set to address(0) | fix/issue-147-treasury-can-be-set-to-address-0 | packages/contracts/src/FeeCollector.sol | Validate address | Tier 1 |
| [x] #23 Reward parameter manipulation | fix/issue-023-reward-parameter-manipulation | WorkRewards.sol | Add validation bounds | Tier 1 |
| [x] #149 Halving epoch out-of-bounds | fix/issue-149-halving-epoch-out-of-bounds | packages/contracts/src/WorkRewards.sol | Bounds check | Tier 1 |
| [x] #196 Halving parameters not validated | fix/issue-196-halving-parameters-not-validated | packages/contracts/src/WorkRewards.sol | Validate ascending | Tier 1 |
| [x] #150 Quality multiplier unbounded | fix/issue-150-quality-multiplier-unbounded | packages/contracts/src/WorkRewards.sol | Cap multiplier | Tier 1 |
| [x] #152 Job ID collision | fix/issue-152-job-id-collision | packages/contracts/src/WorkRewards.sol | Add randomness | Tier 1 |
| [x] #153 Balance check race in batch | fix/issue-153-balance-check-race-in-batch | packages/contracts/src/WorkRewards.sol | Reserve funds | Tier 1 |
| [x] #197 getEffectiveScore() halves new peers | fix/issue-197-geteffectivescore-halves-new-peers | packages/contracts/src/ReputationRegistry.sol | Handle lastActive=0 | Tier 1 |
| [x] #154 Array swap misleading event index | fix/issue-154-array-swap-misleading-event-index | packages/contracts/src/EccoConstitution.sol | Fix event | Tier 1 |
| [x] #198 Constitution event index mismatch | fix/issue-198-constitution-event-index-mismatch | packages/contracts/src/EccoConstitution.sol | Use item ID | Tier 1 |
| [x] #155 Empty string bypass via unicode | fix/issue-155-empty-string-bypass-via-unicode | packages/contracts/src/EccoConstitution.sol | Proper validation | Tier 1 |
| [x] #156 getAllItems() exceeds gas limit | fix/issue-156-getallitems-exceeds-gas-limit | packages/contracts/src/EccoConstitution.sol | Add pagination | Tier 1 |
| [x] #157 Owner renunciation locks constitution (dupes: #233) | fix/issue-157-owner-renunciation-locks-constitution | packages/contracts/src/EccoConstitution.sol | Prevent renunciation | Tier 1 |
## Tier 2: High Severity (Memory, Races, Crashes)

| Issue | Branch | Files | Fix | Priority |
| --- | --- | --- | --- | --- |
| [x] #1 BLE event listener leak | fix/issue-001-ble-event-listener-leak | bluetooth-le.ts | Store and cleanup | Tier 2 |
| [x] #2 Uncleared discoveredPeers Set | fix/issue-002-uncleared-discoveredpeers-set | discovery.ts | Periodic cleanup | Tier 2 |
| [x] #3 Unbounded pending ratings queue | fix/issue-003-unbounded-pending-ratings-queue | reputation.ts | Add MAX_PENDING | Tier 2 |
| [x] #4 Unbounded chunk accumulation | fix/issue-004-unbounded-chunk-accumulation | libp2p.ts | Add MAX_SIZE check | Tier 2 |
| [x] #5 Topic subscribers never cleaned | fix/issue-005-topic-subscribers-never-cleaned | messaging.ts | Clean on disconnect | Tier 2 |
| [x] #16 Event listeners never removed (dupes: #180, #492, #493, #504) | fix/issue-016-event-listeners-never-removed | packages/core/src/node/messaging.ts; packages/core/src/node/discovery.ts; packages/core/src/transport/adapters/libp2p.ts | Add cleanup registry | Tier 2 |
| [x] #21 Unbounded invoice queue | fix/issue-021-unbounded-invoice-queue | payments.ts | Add MAX_QUEUE | Tier 2 |
| [x] #84 Public key cache unbounded | fix/issue-084-public-key-cache-unbounded | auth.ts | Use LRU cache | Tier 2 |
| [x] #85 Queued messages unbounded per peer (dupes: #187, #330) | fix/issue-085-queued-messages-unbounded-per-peer | packages/core/src/transport/message-bridge.ts | Add per-peer limit | Tier 2 |
| [x] #106 Unbounded provider discovery | fix/issue-106-unbounded-provider-discovery | packages/core/src/node/dht.ts | Add MAX_PROVIDERS | Tier 2 |
| [x] #110 Capabilities array unbounded | fix/issue-110-capabilities-array-unbounded | packages/core/src/node/dht.ts | Dedupe before push | Tier 2 |
| [x] #166 Hybrid discovery handler accumulation | fix/issue-166-hybrid-discovery-handler-accumulation | packages/core/src/transport/hybrid-discovery.ts | Deregister on remove | Tier 2 |
| [x] #220 Reputation score unbounded growth | fix/issue-220-reputation-score-unbounded-growth | packages/core/src/node/reputation.ts | Add bounds | Tier 2 |
| [x] #263 No max peer limit in discovery | fix/issue-263-no-max-peer-limit-in-discovery | packages/core/src/transport/hybrid-discovery.ts | Add MAX_PEERS | Tier 2 |
| [x] #268 Stream buffer memory leak on timeout | fix/issue-268-stream-buffer-memory-leak-on-timeout | packages/core/src/orchestrator/index.ts | Add TTL cleanup | Tier 2 |
| [x] #279 Unbounded distributors array | fix/issue-279-unbounded-distributors-array | packages/contracts/src/WorkRewards.sol | Add limit | Tier 2 |
| [x] #294 Event listener stacking in PubSub | fix/issue-294-event-listener-stacking-in-pubsub | packages/core/src/node/messaging.ts | Reuse listener | Tier 2 |
| [x] #299 Promise map memory leak | fix/issue-299-promise-map-memory-leak | packages/core/src/orchestrator/index.ts | Clear on timeout | Tier 2 |
| [x] #321 DHT capabilities unbounded | fix/issue-321-dht-capabilities-unbounded | packages/core/src/node/dht.ts | Add size limit | Tier 2 |
| [x] #325 Phase escalation timer array never cleared | fix/issue-325-phase-escalation-timer-array-never-cleared | packages/core/src/transport/hybrid-discovery.ts | Clear on success | Tier 2 |
| [x] #560 Orchestrator fanout unbounded with selectionStrategy='all' | fix/issue-560-orchestrator-fanout-unbounded-with-selectionstra | agent/index.ts | Cap max agents or require explicit allow-all | Tier 2 |
| [x] #562 Stream buffers unbounded by size | fix/issue-562-stream-buffers-unbounded-by-size | index.ts | Enforce max stream bytes/chunks and abort on overflow | Tier 2 |
| [x] #524 LibP2P discovery stores local addresses for peers | fix/issue-524-libp2p-discovery-stores-local-addresses-for-peer | libp2p.ts | Use event multiaddrs | Tier 2 |
| [x] #531 LibP2P send closes stream before await | fix/issue-531-libp2p-send-closes-stream-before-await | libp2p.ts | Await send before close | Tier 2 |
| [x] #534 Transport publish routing drops/broadcasts incorrectly | fix/issue-534-transport-publish-routing-drops-broadcasts-incor | messaging.ts | Track remote subscribers or use direct send | Tier 2 |
| [x] #539 BLE adapter never initialized in hybrid discovery | fix/issue-539-ble-adapter-never-initialized-in-hybrid-discover | lifecycle.ts; bluetooth-le.ts | Initialize adapter before startDiscovery | Tier 2 |
| [x] #553 Discovery auto-dial unthrottled on peer discovery | fix/issue-553-discovery-auto-dial-unthrottled-on-peer-discover | discovery.ts | Add dial rate limit/backoff and max concurrent dials | Tier 2 |
| [x] #554 Phase escalation blocked by stale discovered peers | fix/issue-554-phase-escalation-blocked-by-stale-discovered-pee | hybrid-discovery.ts | Use TTL/validated peers for escalation | Tier 2 |
| [x] #549 Pubsub gossip bypasses handshake/version enforcement | fix/issue-549-pubsub-gossip-bypasses-handshake-version-enforce | messaging.ts | Gate gossip on compatible/validated peers | Tier 2 |
| [x] #6 Peer discovery race | fix/issue-006-peer-discovery-race | discovery.ts | Add dialing lock | Tier 2 |
| [x] #7 Handshake timeout state mutation (dupes: #79, #163, #404, #499, #514) | fix/issue-007-handshake-timeout-state-mutation | packages/core/src/transport/message-bridge.ts | Immutable updates | Tier 2 |
| [x] #8 Escalation timer race (dupes: #237) | fix/issue-008-escalation-timer-race | packages/core/src/transport/hybrid-discovery.ts | Clear timers | Tier 2 |
| [x] #14 Connect adds peer before verification | fix/issue-014-connect-adds-peer-before-verification | bluetooth-le.ts | Verify first | Tier 2 |
| [x] #31 Orchestrator load state races | fix/issue-031-orchestrator-load-state-races | index.ts | Atomic updates | Tier 2 |
| [x] #80 Handler set mutation during iteration (dupes: #326, #329) | fix/issue-080-handler-set-mutation-during-iteration | packages/core/src/transport/hybrid-discovery.ts; packages/core/src/transport/message-bridge.ts | Copy before iterate | Tier 2 |
| [x] #93 Topic subscriber removal race | fix/issue-093-topic-subscriber-removal-race | messaging.ts | Atomic update | Tier 2 |
| [x] #102 ensureDbInitialized race | fix/issue-102-ensuredbinitialized-race | storage/index.ts; packages/core/src/storage/index.ts | Add init lock | Tier 2 |
| [x] #121 recordTokens tick race | fix/issue-121-recordtokens-tick-race | packages/core/src/agent/payments.ts | Add mutex | Tier 2 |
| [x] #126 Concurrent milestone release | fix/issue-126-concurrent-milestone-release | packages/core/src/agent/payments.ts | Optimistic locking | Tier 2 |
| [x] #132 Disposed context race in LLM | fix/issue-132-disposed-context-race-in-llm | packages/core/src/services/llm.ts | Check after acquire | Tier 2 |
| [x] #159 Connection pool index bug after splice | fix/issue-159-connection-pool-index-bug-after-splice | packages/core/src/connection/lifecycle.ts | Fix index | Tier 2 |
| [x] #172 activeRequests counter desync (dupes: #340) | fix/issue-172-activerequests-counter-desync | packages/core/src/orchestrator/index.ts | Atomic update | Tier 2 |
| [x] #175 Orchestration state leakage | fix/issue-175-orchestration-state-leakage | agent/index.ts; packages/core/src/agent/index.ts | Isolate state | Tier 2 |
| [x] #181 Duplicate capability handler registration | fix/issue-181-duplicate-capability-handler-registration | packages/core/src/node/capabilities.ts; packages/core/src/node/discovery.ts | Guard check | Tier 2 |
| [x] #182 Stale state in hybrid discovery callbacks | fix/issue-182-stale-state-in-hybrid-discovery-callbacks | packages/core/src/node/lifecycle.ts | Check shutdown | Tier 2 |
| [x] #183 Flood protection direct mutations | fix/issue-183-flood-protection-direct-mutations | packages/core/src/node/messaging.ts | Return new state | Tier 2 |
| [x] #184 Settlement queue async divergence | fix/issue-184-settlement-queue-async-divergence | packages/core/src/node/state.ts | Sync writes | Tier 2 |
| [x] #236 Queued message double-delivery after handshake | fix/issue-236-queued-message-double-delivery-after-handshake | packages/core/src/transport/message-bridge.ts | Dedup check | Tier 2 |
| [x] #239 Connection pool indexOf race | fix/issue-239-connection-pool-indexof-race | packages/core/src/connection/lifecycle.ts | Handle -1 | Tier 2 |
| [x] #240 Promise resolution race | fix/issue-240-promise-resolution-race | packages/core/src/orchestrator/index.ts | Clear immediately | Tier 2 |
| [x] #241 Load state mutation during concurrent ops | fix/issue-241-load-state-mutation-during-concurrent-ops | packages/core/src/orchestrator/index.ts | Atomic updates | Tier 2 |
| [x] #251 Stream writeStatus TOCTOU | fix/issue-251-stream-writestatus-toctou | packages/core/src/transport/adapters/libp2p.ts | Recheck before send | Tier 2 |
| [x] #252 Handshake TOCTOU race | fix/issue-252-handshake-toctou-race | packages/core/src/transport/message-bridge.ts | Atomic check | Tier 2 |
| [x] #301 Duplicate setupCapabilityTracking | fix/issue-301-duplicate-setupcapabilitytracking | packages/core/src/node/discovery.ts; packages/core/src/node/lifecycle.ts | Single call | Tier 2 |
| [x] #353 Invoice expiration race | fix/issue-353-invoice-expiration-race | packages/core/src/services/payment.ts | Add grace period | Tier 2 |
| [x] #401 Streaming generator callback overwrite | fix/issue-401-streaming-generator-callback-overwrite | packages/core/src/services/llm.ts | Queue callbacks | Tier 2 |
| [x] #402 Generation stream callback race | fix/issue-402-generation-stream-callback-race | packages/core/src/services/generation.ts | Atomic pattern | Tier 2 |
| [x] #403 Payment timeout deletion race (dupes: #518) | fix/issue-403-payment-timeout-deletion-race | packages/core/src/agent/payments.ts | Sync access | Tier 2 |
| [x] #405 State CAS pattern race window | fix/issue-405-state-cas-pattern-race-window | packages/core/src/node/state.ts | Add backoff | Tier 2 |
| [x] #413 Unstake cooldown same-block bypass | fix/issue-413-unstake-cooldown-same-block-bypass | packages/contracts/src/ReputationRegistry.sol | Use block.number | Tier 2 |
| [x] #500 Embedding subscriptions race | fix/issue-500-embedding-subscriptions-race | packages/core/src/services/embedding.ts | Isolate handlers | Tier 2 |
| [x] #501 Generation response collectors not isolated | fix/issue-501-generation-response-collectors-not-isolated | packages/core/src/services/generation.ts | Isolate | Tier 2 |
| [x] #82 sendMessage fire-and-forget in orchestrator | fix/issue-082-sendmessage-fire-and-forget-in-orchestrator | index.ts | Await result | Tier 2 |
| [x] #525 Transport manager mutates captured state | fix/issue-525-transport-manager-mutates-captured-state | manager.ts | Update via state return | Tier 2 |
| [x] #541 Payment ledger never populated by core flows | fix/issue-541-payment-ledger-never-populated-by-core-flows | state.ts; payments.ts | Record ledger entries on invoice creation/settlement | Tier 2 |
| [x] #542 Pending settlements never processed | fix/issue-542-pending-settlements-never-processed | state.ts; storage/index.ts | Add settlement worker with retries | Tier 2 |
| [x] #35 Division by zero risks (dupes: #81, #129, #173, #222, #289, #304, #306, #339, #341, #485, #506) | fix/issue-035-division-by-zero-risks | packages/core/src/services/payment.ts; packages/core/src/agent/payments.ts; packages/core/src/orchestrator/aggregation.ts; packages/contracts/src/FeeCollector.sol; packages/core/src/orchestrator/index.ts; packages/core/src/node/peer-performance.ts | Guard x > 0 | Tier 2 |
| [x] #36 Empty array access (dupes: #86, #288, #308, #479, #483) | fix/issue-036-empty-array-access | packages/core/src/orchestrator/aggregation.ts | Check length | Tier 2 |
| [x] #37 Vector magnitude zero (dupes: #285) | fix/issue-037-vector-magnitude-zero | packages/core/src/orchestrator/semantic-similarity.ts | Check > 0 | Tier 2 |
| [x] #47 Unbounded counter accumulation | fix/issue-047-unbounded-counter-accumulation | orchestrator/index.ts | Add bounds | Tier 2 |
| [x] #284 Non-contiguous embedding chunk gaps | fix/issue-284-non-contiguous-embedding-chunk-gaps | packages/core/src/services/embedding.ts | Handle gaps | Tier 2 |
| [x] #480 Promise non-null assertion on Map.get | fix/issue-480-promise-non-null-assertion-on-map-get | packages/core/src/orchestrator/index.ts | Check exists | Tier 2 |
| [x] #482 Embedded array access without validation | fix/issue-482-embedded-array-access-without-validation | packages/core/src/services/embedding.ts | Check exists | Tier 2 |
| [x] #484 Non-sequential Map key access | fix/issue-484-non-sequential-map-key-access | packages/core/src/services/embedding.ts | Handle gaps | Tier 2 |
| [x] #487 Reduce initializer assumes index 0 | fix/issue-487-reduce-initializer-assumes-index-0 | packages/core/src/connection/lifecycle.ts | Handle empty | Tier 2 |
| [x] #15 Stream not closed on error | fix/issue-015-stream-not-closed-on-error | libp2p.ts | Close in finally | Tier 2 |
| [x] #41 Database never closed | fix/issue-041-database-never-closed | storage/index.ts | Add close() | Tier 2 |
| [x] #42 Streaming agreement never closed | fix/issue-042-streaming-agreement-never-closed | payments.ts | Add expiration | Tier 2 |
| [x] #133 Missing sequence disposal | fix/issue-133-missing-sequence-disposal | packages/core/src/services/llm.ts | Dispose in finally | Tier 2 |
| [x] #234 Partial frame assembly silent loss | fix/issue-234-partial-frame-assembly-silent-loss | packages/core/src/transport/adapters/libp2p.ts | Log error | Tier 2 |
| [x] #292 Generator early exit without disposal | fix/issue-292-generator-early-exit-without-disposal | packages/core/src/services/llm.ts | Await disposal | Tier 2 |
| [x] #295 Stream not explicitly closed | fix/issue-295-stream-not-explicitly-closed | packages/core/src/transport/adapters/libp2p.ts | Call close() | Tier 2 |
| [x] #298 Connection pool fire-and-forget close | fix/issue-298-connection-pool-fire-and-forget-close | packages/core/src/connection/lifecycle.ts | Await close | Tier 2 |
| [x] #497 Stream promises not awaited | fix/issue-497-stream-promises-not-awaited | packages/core/src/services/llm.ts | Await promise | Tier 2 |
| [x] #503 Connection pool not closed on init error | fix/issue-503-connection-pool-not-closed-on-init-error | packages/core/src/node/lifecycle.ts | Close on error | Tier 2 |
| [x] #512 Stream close error not handled | fix/issue-512-stream-close-error-not-handled | packages/core/src/transport/adapters/libp2p.ts | Catch error | Tier 2 |

## Tier 3: Medium Severity (Validation, Errors, Protocol)

| Issue | Branch | Files | Fix | Priority |
| --- | --- | --- | --- | --- |
| [x] #38 Version parse returns 0.5 for invalid (dupes: #70, #315, #398) | fix/issue-038-version-parse-returns-0-5-for-invalid | packages/core/src/protocol/handshake.ts; packages/core/src/protocol/version.ts; packages/core/src/orchestrator/capability-matcher.ts | Validate format | Tier 3 |
| [x] #39 No message size validation | fix/issue-039-no-message-size-validation | message-bridge.ts | Add MAX_SIZE | Tier 3 |
| [x] #40 RPC URL not validated (dupes: #217, #418) | fix/issue-040-rpc-url-not-validated | packages/core/src/services/wallet.ts | Validate URL | Tier 3 |
| [x] #63 parseDecimalToBigInt no validation | fix/issue-063-parsedecimaltobigint-no-validation | packages/core/src/services/payment.ts | Validate format | Tier 3 |
| [x] #64 Varint decode integer overflow (dupes: #158, #307, #390, #508, #509) | fix/issue-064-varint-decode-integer-overflow | packages/core/src/transport/adapters/libp2p.ts | Limit shift | Tier 3 |
| [ ] #67 parseEther no range validation | fix/issue-067-parseether-no-range-validation | packages/core/src/services/wallet.ts | Validate range | Tier 3 |
| [x] #68 addresses[0] without length check | fix/issue-068-addresses-0-without-length-check | packages/core/src/node/bootstrap.ts | Check length | Tier 3 |
| [x] #69 Hash slice without length validation (dupes: #317) | fix/issue-069-hash-slice-without-length-validation | packages/core/src/protocol/constitution.ts | Check >= 16 | Tier 3 |
| [ ] #89 Unsafe type assertion on payload | fix/issue-089-unsafe-type-assertion-on-payload | index.ts | Runtime validation | Tier 3 |
| [ ] #95 Custom aggregator return not validated | fix/issue-095-custom-aggregator-return-not-validated | aggregation.ts | Schema validation | Tier 3 |
| [x] #105 No validation of parsed milestones | fix/issue-105-no-validation-of-parsed-milestones | storage/index.ts; packages/core/src/storage/index.ts | Validate fields | Tier 3 |
| [x] #108 provider.multiaddrs accessed without null check | fix/issue-108-provider-multiaddrs-accessed-without-null-check | packages/core/src/node/dht.ts | Check null | Tier 3 |
| [x] #111 Contract creation tx passes recipient check | fix/issue-111-contract-creation-tx-passes-recipient-check | packages/core/src/services/wallet.ts | Check receipt.to | Tier 3 |
| [x] #112 Receipt could be null | fix/issue-112-receipt-could-be-null | packages/core/src/services/wallet.ts | Check null | Tier 3 |
| [x] #114 Unsafe type casts without address validation | fix/issue-114-unsafe-type-casts-without-address-validation | packages/core/src/services/wallet.ts | Validate address | Tier 3 |
| [ ] #115 Chain ID lookup not atomic | fix/issue-115-chain-id-lookup-not-atomic | packages/core/src/services/wallet.ts | Cache chain | Tier 3 |
| [x] #119 Version parsing rejects valid semver | fix/issue-119-version-parsing-rejects-valid-semver | packages/core/src/orchestrator/capability-matcher.ts | Support pre-release | Tier 3 |
| [x] #120 Empty capabilities returns perfect match | fix/issue-120-empty-capabilities-returns-perfect-match | packages/core/src/orchestrator/capability-matcher.ts | Return 0 score | Tier 3 |
| [x] #179 Feature match count can exceed total | fix/issue-179-feature-match-count-can-exceed-total | packages/core/src/orchestrator/capability-matcher.ts | Clamp to 1.0 | Tier 3 |
| [x] #206 Unicode normalization in constitution | fix/issue-206-unicode-normalization-in-constitution | packages/core/src/protocol/constitution.ts | Normalize NFC | Tier 3 |
| [x] #207 Message timestamp used in ID without validation | fix/issue-207-message-timestamp-used-in-id-without-validation | packages/core/src/node/messaging.ts | Validate timestamp | Tier 3 |
| [x] #208 Wallet address type coercion | fix/issue-208-wallet-address-type-coercion | packages/core/src/services/wallet.ts | Validate format | Tier 3 |
| [x] #209 Negative chain ID not rejected | fix/issue-209-negative-chain-id-not-rejected | packages/core/src/services/wallet.ts | Validate > 0 | Tier 3 |
| [x] #210 Version parsing accepts out-of-bounds | fix/issue-210-version-parsing-accepts-out-of-bounds | packages/core/src/protocol/version.ts | Check safe integer | Tier 3 |
| [x] #224 Non-deterministic batch rating order | fix/issue-224-non-deterministic-batch-rating-order | packages/core/src/services/reputation-contract.ts | Sort before batch | Tier 3 |
| [ ] #242 Malformed response buffer injection | fix/issue-242-malformed-response-buffer-injection | packages/core/src/orchestrator/index.ts | Validate requestId | Tier 3 |
| [ ] #249 Unvalidated peer addresses before dial | fix/issue-249-unvalidated-peer-addresses-before-dial | packages/core/src/transport/adapters/libp2p.ts | Validate address | Tier 3 |
| [x] #262 Untrusted peer attribution in stream | fix/issue-262-untrusted-peer-attribution-in-stream | packages/core/src/transport/adapters/libp2p.ts | Verify peer | Tier 3 |
| [x] #264 Empty capability query returns perfect match | fix/issue-264-empty-capability-query-returns-perfect-match | packages/core/src/orchestrator/capability-matcher.ts | Return 0 | Tier 3 |
| [x] #265 Capability matcher score exceeds 1.0 | fix/issue-265-capability-matcher-score-exceeds-1-0 | packages/core/src/orchestrator/capability-matcher.ts | Clamp score | Tier 3 |
| [x] #266 Preferred peers bypass capability requirements | fix/issue-266-preferred-peers-bypass-capability-requirements | packages/core/src/orchestrator/capability-matcher.ts | Check minimum | Tier 3 |
| [x] #267 Load weight configuration not validated | fix/issue-267-load-weight-configuration-not-validated | packages/core/src/orchestrator/index.ts | Validate 0-1 | Tier 3 |
| [x] #274 Milestones sum not validated against total | fix/issue-274-milestones-sum-not-validated-against-total | packages/core/src/agent/payments.ts | Validate sum | Tier 3 |
| [ ] #318 On-chain constitution RPC not validated | fix/issue-318-on-chain-constitution-rpc-not-validated | packages/core/src/protocol/on-chain-constitution.ts | Validate response | Tier 3 |
| [x] #320 DHT provider multiaddrs not null-checked | fix/issue-320-dht-provider-multiaddrs-not-null-checked | packages/core/src/node/dht.ts | Check null | Tier 3 |
| [x] #322 Bootstrap dial timeout zero not rejected | fix/issue-322-bootstrap-dial-timeout-zero-not-rejected | packages/core/src/node/bootstrap.ts | Validate > 0 | Tier 3 |
| [x] #324 Multiaddr parsing exception uncaught | fix/issue-324-multiaddr-parsing-exception-uncaught | packages/core/src/transport/adapters/libp2p.ts | Try-catch | Tier 3 |
| [x] #332 Zero-amount invoices in streaming | fix/issue-332-zero-amount-invoices-in-streaming | packages/core/src/agent/payments.ts | Validate rate > 0 | Tier 3 |
| [x] #333 Negative amount in escrow milestones | fix/issue-333-negative-amount-in-escrow-milestones | packages/core/src/agent/payments.ts | Validate > 0 | Tier 3 |
| [x] #336 Capability version backward compatibility | fix/issue-336-capability-version-backward-compatibility | packages/core/src/orchestrator/capability-matcher.ts | Add warnings | Tier 3 |
| [x] #337 Fuzzy matching vulnerability | fix/issue-337-fuzzy-matching-vulnerability | packages/core/src/orchestrator/capability-matcher.ts | Stricter threshold | Tier 3 |
| [x] #394 Hash hex case sensitivity | fix/issue-394-hash-hex-case-sensitivity | packages/core/src/protocol/constitution.ts | Normalize case | Tier 3 |
| [x] #396 Unsafe Uint8Array reconstruction | fix/issue-396-unsafe-uint8array-reconstruction | packages/core/src/transport/adapters/libp2p.ts | Validate data | Tier 3 |
| [x] #397 Object spread prototype pollution | fix/issue-397-object-spread-prototype-pollution | packages/core/src/node/bloom-filter.ts | Validate keys | Tier 3 |
| [x] #516 bigintToDecimalString truncation | fix/issue-516-biginttodecimalstring-truncation | packages/core/src/agent/payments.ts | Warn on truncation | Tier 3 |
| [x] #517 toWei negative number handling | fix/issue-517-towei-negative-number-handling | packages/core/src/agent/payments.ts | Reject negative | Tier 3 |
| [x] #540 streaming-tick accepts negative/float tokens | fix/issue-540-streaming-tick-accepts-negative-float-tokens | agent/index.ts; payment.ts | Validate tokensGenerated as non-negative integer | Tier 3 |
| [ ] #530 Shallow config merge drops nested defaults | fix/issue-530-shallow-config-merge-drops-nested-defaults | config.ts; networks.ts | Deep merge nested config | Tier 3 |
| [ ] #25 Insufficient DHT readiness check | fix/issue-025-insufficient-dht-readiness-check | dht.ts | Verify bootstrap | Tier 3 |
| [ ] #26 No chain sync timeout | fix/issue-026-no-chain-sync-timeout | reputation.ts | Add timeout | Tier 3 |
| [x] #27 Silent DHT announcement failures | fix/issue-027-silent-dht-announcement-failures | dht.ts | Log failures | Tier 3 |
| [ ] #28 Hybrid discovery handler never removed | fix/issue-028-hybrid-discovery-handler-never-removed | lifecycle.ts | Add cleanup | Tier 3 |
| [x] #32 deserializeMessage swallows errors | fix/issue-032-deserializemessage-swallows-errors | message-bridge.ts | Log error | Tier 3 |
| [ ] #33 Handler errors silently logged | fix/issue-033-handler-errors-silently-logged | handlers.ts | Propagate error | Tier 3 |
| [ ] #34 No transport fallback | fix/issue-034-no-transport-fallback | messaging.ts | Add fallback | Tier 3 |
| [x] #56 Silent error suppression | fix/issue-056-silent-error-suppression | packages/core/src/node/discovery.ts | Log error | Tier 3 |
| [x] #57 Stream generation promise missing handler | fix/issue-057-stream-generation-promise-missing-handler | packages/core/src/services/generation.ts | Add .catch() | Tier 3 |
| [ ] #58 unloadModel polling without timeout | fix/issue-058-unloadmodel-polling-without-timeout | packages/core/src/services/llm.ts | Add max wait | Tier 3 |
| [x] #60 Handlers called sync without await | fix/issue-060-handlers-called-sync-without-await | packages/core/src/node/messaging.ts | Use Promise.all | Tier 3 |
| [ ] #61 State mutations while async in-flight | fix/issue-061-state-mutations-while-async-in-flight | agent/index.ts; packages/core/src/agent/index.ts | Await init | Tier 3 |
| [x] #62 Timeout not cleared on send failure | fix/issue-062-timeout-not-cleared-on-send-failure | agent/index.ts; packages/core/src/agent/index.ts | Clear timeout | Tier 3 |
| [x] #103 Async DB writes not awaited | fix/issue-103-async-db-writes-not-awaited | storage/index.ts; packages/core/src/storage/index.ts | Await writes | Tier 3 |
| [x] #104 Generic error messages | fix/issue-104-generic-error-messages | storage/index.ts; packages/core/src/storage/index.ts | Preserve original | Tier 3 |
| [x] #109 Failed announcements silently ignored | fix/issue-109-failed-announcements-silently-ignored | packages/core/src/node/dht.ts | Check results | Tier 3 |
| [ ] #131 No retry logic on transient failures | fix/issue-131-no-retry-logic-on-transient-failures | packages/core/src/node/bootstrap.ts | Add retry | Tier 3 |
| [ ] #151 Batch rewards silently skips failures | fix/issue-151-batch-rewards-silently-skips-failures | packages/contracts/src/WorkRewards.sol | Return skip count | Tier 3 |
| [ ] #161 Message ordering lost after handshake flush | fix/issue-161-message-ordering-lost-after-handshake-flush | packages/core/src/transport/message-bridge.ts | Order by timestamp | Tier 3 |
| [ ] #162 LibP2P adapter state mismatch | fix/issue-162-libp2p-adapter-state-mismatch | packages/core/src/transport/adapters/libp2p.ts | Wait for ready | Tier 3 |
| [x] #164 BLE send without connection validation | fix/issue-164-ble-send-without-connection-validation | packages/core/src/transport/adapters/bluetooth-le.ts | Check connected | Tier 3 |
| [x] #165 Constitution cache not invalidated on error | fix/issue-165-constitution-cache-not-invalidated-on-error | packages/core/src/protocol/on-chain-constitution.ts | Clear on error | Tier 3 |
| [ ] #174 Streaming tick partial failure no reconciliation | fix/issue-174-streaming-tick-partial-failure-no-reconciliation | packages/core/src/agent/payments.ts | Retry mechanism | Tier 3 |
| [ ] #185 Cleanup handlers reference freed resources | fix/issue-185-cleanup-handlers-reference-freed-resources | packages/core/src/node/state.ts | Validate resources | Tier 3 |
| [ ] #226 RPC response not validated before caching | fix/issue-226-rpc-response-not-validated-before-caching | packages/core/src/protocol/on-chain-constitution.ts | Validate first | Tier 3 |
| [x] #227 Cache TTL zero defeats purpose | fix/issue-227-cache-ttl-zero-defeats-purpose | packages/core/src/protocol/on-chain-constitution.ts | Validate > 0 | Tier 3 |
| [x] #244 Stake filtering silent peer exclusion | fix/issue-244-stake-filtering-silent-peer-exclusion | packages/core/src/orchestrator/index.ts | Log exclusions | Tier 3 |
| [ ] #250 Incomplete async cleanup on shutdown | fix/issue-250-incomplete-async-cleanup-on-shutdown | packages/core/src/transport/adapters/libp2p.ts | Await cleanup | Tier 3 |
| [x] #254 Error propagation gap in weighted vote | fix/issue-254-error-propagation-gap-in-weighted-vote | packages/core/src/orchestrator/aggregation.ts | Handle error | Tier 3 |
| [ ] #256 Stream response promise rejection | fix/issue-256-stream-response-promise-rejection | agent/index.ts; packages/core/src/agent/index.ts | Add try-catch | Tier 3 |
| [ ] #261 No rate limiting on bootstrap dials | fix/issue-261-no-rate-limiting-on-bootstrap-dials | packages/core/src/node/bootstrap.ts | Add rate limit | Tier 3 |
| [x] #271 Settlement retry without backoff | fix/issue-271-settlement-retry-without-backoff | packages/core/src/types.ts | Add exponential | Tier 3 |
| [x] #273 Escrow status ignores cancelled milestones | fix/issue-273-escrow-status-ignores-cancelled-milestones | packages/core/src/services/payment.ts | Handle cancelled | Tier 3 |
| [x] #275 Accumulated amount never reset | fix/issue-275-accumulated-amount-never-reset | packages/core/src/services/payment.ts | Reset on settle | Tier 3 |
| [x] #286 Storage error message loss | fix/issue-286-storage-error-message-loss | storage/index.ts; packages/core/src/storage/index.ts | Preserve error | Tier 3 |
| [x] #311 Message deserialization silent | fix/issue-311-message-deserialization-silent | packages/core/src/transport/message-bridge.ts | Log error | Tier 3 |
| [ ] #312 Streaming agreement state divergence | fix/issue-312-streaming-agreement-state-divergence | packages/core/src/agent/payments.ts | Rollback on fail | Tier 3 |
| [ ] #313 Initialization order issues | fix/issue-313-initialization-order-issues | agent/index.ts; packages/core/src/agent/index.ts | Fix order | Tier 3 |
| [ ] #319 Queued messages dropped on handler exception | fix/issue-319-queued-messages-dropped-on-handler-exception | packages/core/src/transport/message-bridge.ts | Try-catch each | Tier 3 |
| [x] #335 Status transition violation | fix/issue-335-status-transition-violation | packages/core/src/services/payment.ts | Enforce state machine | Tier 3 |
| [x] #346 Performance metrics LRU eviction | fix/issue-346-performance-metrics-lru-eviction | packages/core/src/node/peer-performance.ts | Log eviction | Tier 3 |
| [x] #350 Wallet resolution cache never invalidated | fix/issue-350-wallet-resolution-cache-never-invalidated | packages/core/src/node/reputation.ts | Add TTL | Tier 3 |
| [ ] #351 On-chain reputation sync stale window | fix/issue-351-on-chain-reputation-sync-stale-window | packages/core/src/node/reputation.ts | Atomic check | Tier 3 |
| [ ] #352 Clearing stale entries before pending | fix/issue-352-clearing-stale-entries-before-pending | packages/core/src/node/reputation.ts | Commit first | Tier 3 |
| [ ] #354 Streaming channel timeout missing | fix/issue-354-streaming-channel-timeout-missing | packages/core/src/agent/payments.ts | Add expiration | Tier 3 |
| [ ] #367 Fire-and-forget empty catch blocks | fix/issue-367-fire-and-forget-empty-catch-blocks | node/discovery.ts; node/lifecycle.ts; connection/lifecycle.ts; libp2p.ts | Log error | Tier 3 |
| [x] #368 Async function called without await | fix/issue-368-async-function-called-without-await | packages/core/src/transport/hybrid-discovery.ts | Add await | Tier 3 |
| [ ] #369 Promise.all without error boundaries | fix/issue-369-promise-all-without-error-boundaries | transport/manager.ts; hybrid-discovery.ts; generation.ts | Use allSettled | Tier 3 |
| [ ] #370 Orchestration error resolver missing | fix/issue-370-orchestration-error-resolver-missing | packages/core/src/orchestrator/index.ts | Handle missing | Tier 3 |
| [x] #371 Message handler error stays subscribed | fix/issue-371-message-handler-error-stays-subscribed | packages/core/src/node/messaging.ts | Unsubscribe | Tier 3 |
| [ ] #372 Async iterator without try-catch | fix/issue-372-async-iterator-without-try-catch | packages/core/src/services/generation.ts | Add try-catch | Tier 3 |
| [ ] #373 Stream processing without recovery | fix/issue-373-stream-processing-without-recovery | packages/core/src/transport/adapters/libp2p.ts | Add recovery | Tier 3 |
| [ ] #374 Generic error wrapping loses context | fix/issue-374-generic-error-wrapping-loses-context | packages/core/src/connection/lifecycle.ts | Preserve stack | Tier 3 |
| [ ] #375 Type assertion bypasses safety | fix/issue-375-type-assertion-bypasses-safety | packages/core/src/orchestrator/index.ts | Validate type | Tier 3 |
| [ ] #377 Agent setup functions not awaited | fix/issue-377-agent-setup-functions-not-awaited | agent/index.ts; packages/core/src/agent/index.ts | Await setup | Tier 3 |
| [ ] #378 Finally block without error safety | fix/issue-378-finally-block-without-error-safety | packages/core/src/services/generation.ts | Catch cleanup | Tier 3 |
| [ ] #379 State update retry without logging | fix/issue-379-state-update-retry-without-logging | packages/core/src/node/state.ts | Log conflicts | Tier 3 |
| [ ] #380 Payment callback error unhandled | fix/issue-380-payment-callback-error-unhandled | packages/core/src/agent/payments.ts | Handle error | Tier 3 |
| [x] #381 Bootstrap errors not returned | fix/issue-381-bootstrap-errors-not-returned | packages/core/src/node/bootstrap.ts | Return errors | Tier 3 |
| [ ] #382 Cleanup handler errors swallowed | fix/issue-382-cleanup-handler-errors-swallowed | packages/core/src/node/state.ts | Aggregate errors | Tier 3 |
| [x] #383 Message handler loop one failure kills all | fix/issue-383-message-handler-loop-one-failure-kills-all | packages/core/src/node/messaging.ts | Try-catch each | Tier 3 |
| [x] #384 Wallet error lacks detail | fix/issue-384-wallet-error-lacks-detail | packages/core/src/services/wallet.ts | Include revert | Tier 3 |
| [x] #385 JSON.parse without try-catch in bloom | fix/issue-385-json-parse-without-try-catch-in-bloom | packages/core/src/node/bloom-filter.ts | Add try-catch | Tier 3 |
| [x] #387 Storage JSON.parse chain unprotected | fix/issue-387-storage-json-parse-chain-unprotected | storage/index.ts; packages/core/src/storage/index.ts | Add try-catch | Tier 3 |
| [x] #388 Circular reference risk in aggregation | fix/issue-388-circular-reference-risk-in-aggregation | packages/core/src/orchestrator/aggregation.ts | Handle circular | Tier 3 |
| [x] #389 Varint encoding infinite loop on negatives | fix/issue-389-varint-encoding-infinite-loop-on-negatives | packages/core/src/transport/adapters/libp2p.ts | Reject negative | Tier 3 |
| [x] #392 BigInt conversion without overflow | fix/issue-392-bigint-conversion-without-overflow | packages/core/src/services/payment.ts | Validate format | Tier 3 |
| [x] #395 Map/Set lost in JSON serialization | fix/issue-395-map-set-lost-in-json-serialization | packages/core/src/orchestrator/aggregation.ts | Handle types | Tier 3 |
| [x] #400 JSON stringify for equality | fix/issue-400-json-stringify-for-equality | packages/core/src/node/capabilities.ts | Deep compare | Tier 3 |
| [ ] #406 Message disconnect timer uncancellable | fix/issue-406-message-disconnect-timer-uncancellable | packages/core/src/transport/message-bridge.ts | Store timer ID | Tier 3 |
| [ ] #407 Streaming timeout without subscription cancel | fix/issue-407-streaming-timeout-without-subscription-cancel | packages/core/src/services/generation.ts | Cancel subscription | Tier 3 |
| [x] #408 Discovery poll deadline overshoot | fix/issue-408-discovery-poll-deadline-overshoot | packages/core/src/node/discovery.ts | Check per iteration | Tier 3 |
| [x] #409 Invoice expiration without clock tolerance | fix/issue-409-invoice-expiration-without-clock-tolerance | packages/core/src/services/payment.ts | Add grace period | Tier 3 |
| [ ] #410 Cache TTL thundering herd | fix/issue-410-cache-ttl-thundering-herd | packages/core/src/protocol/on-chain-constitution.ts | Stagger refresh | Tier 3 |
| [ ] #419 Wallet RPC URLs optional but required | fix/issue-419-wallet-rpc-urls-optional-but-required | agent/index.ts; packages/core/src/agent/index.ts | Validate config | Tier 3 |
| [ ] #420 Message handler can be undefined | fix/issue-420-message-handler-can-be-undefined | agent/index.ts; packages/core/src/agent/index.ts | Null check | Tier 3 |
| [ ] #421 Reputation state assumed to exist | fix/issue-421-reputation-state-assumed-to-exist | agent/index.ts; packages/core/src/agent/index.ts | Check exists | Tier 3 |
| [ ] #422 Feature flag inconsistency | fix/issue-422-feature-flag-inconsistency | packages/core/src/node/lifecycle.ts | Sync config | Tier 3 |
| [ ] #423 Circular dependency node/transport | fix/issue-423-circular-dependency-node-transport | packages/core/src/node/lifecycle.ts | Fix order | Tier 3 |
| [ ] #424 Optional config fields required | fix/issue-424-optional-config-fields-required | packages/core/src/services/wallet.ts | Validate early | Tier 3 |
| [ ] #425 Embedding capability but not initialized | fix/issue-425-embedding-capability-but-not-initialized | agent/index.ts; packages/core/src/agent/index.ts | Sync setup | Tier 3 |
| [x] #426 Bootstrap check uses falsy comparison | fix/issue-426-bootstrap-check-uses-falsy-comparison | packages/core/src/node/bootstrap.ts | Check explicitly | Tier 3 |
| [ ] #427 Default values cause infinite/NaN | fix/issue-427-default-values-cause-infinite-nan | packages/core/src/orchestrator/index.ts | Handle edge cases | Tier 3 |
| [ ] #429 Discovery config allows empty array | fix/issue-429-discovery-config-allows-empty-array | packages/core/src/node/lifecycle.ts | Validate non-empty | Tier 3 |
| [ ] #431 Wallet state creation can fail silently | fix/issue-431-wallet-state-creation-can-fail-silently | packages/core/src/node/lifecycle.ts | Handle failure | Tier 3 |
| [ ] #432 Reputation state dependencies not validated | fix/issue-432-reputation-state-dependencies-not-validated | agent/index.ts; packages/core/src/agent/index.ts | Validate order | Tier 3 |
| [ ] #449 No health check for transport | fix/issue-449-no-health-check-for-transport | packages/core/src/node/lifecycle.ts | Add health check | Tier 3 |
| [ ] #450 No health check for message bridge | fix/issue-450-no-health-check-for-message-bridge | packages/core/src/transport/message-bridge.ts | Validate config | Tier 3 |
| [x] #451 Bootstrap failures don't prevent start | fix/issue-451-bootstrap-failures-don-t-prevent-start | packages/core/src/node/lifecycle.ts | Fail on error | Tier 3 |
| [ ] #453 Generation stream missing chunk timeout | fix/issue-453-generation-stream-missing-chunk-timeout | packages/core/src/services/generation.ts | Add per-chunk | Tier 3 |
| [ ] #454 Promise.all without timeout in init | fix/issue-454-promise-all-without-timeout-in-init | packages/core/src/node/lifecycle.ts | Add timeout | Tier 3 |
| [ ] #505 Message bridge handlers race after cleanup | fix/issue-505-message-bridge-handlers-race-after-cleanup | packages/core/src/transport/message-bridge.ts | Sync cleanup | Tier 3 |
| [ ] #511 Connection availability race | fix/issue-511-connection-availability-race | packages/core/src/transport/adapters/libp2p.ts | Retry check | Tier 3 |
| [ ] #513 Message handler double resolution | fix/issue-513-message-handler-double-resolution | packages/core/src/transport/message-bridge.ts | Guard resolve | Tier 3 |
| [ ] #527 publish not awaited for request sends | fix/issue-527-publish-not-awaited-for-request-sends | embedding.ts; generation.ts | Await publish and handle errors | Tier 3 |
| [ ] #528 publish fanout blocks on slow peers | fix/issue-528-publish-fanout-blocks-on-slow-peers | messaging.ts | Parallelize with timeout | Tier 3 |
| [ ] #529 On-chain constitution fetch no timeout | fix/issue-529-on-chain-constitution-fetch-no-timeout | on-chain-constitution.ts | Wrap with timeout | Tier 3 |
| [ ] #536 OpenAI embedding fetch no timeout | fix/issue-536-openai-embedding-fetch-no-timeout | semantic-similarity.ts | Add timeout/abort | Tier 3 |
| [ ] #29 Direct state mutations | fix/issue-029-direct-state-mutations | Multiple files | Use immutable | Tier 3 |
| [ ] #30 Cleanup handlers run once | fix/issue-030-cleanup-handlers-run-once | state.ts | Clear after run | Tier 3 |
| [ ] #43 Missing transaction retry | fix/issue-043-missing-transaction-retry | Payment services | Add retry | Tier 3 |
| [ ] #44 No circuit breakers | fix/issue-044-no-circuit-breakers | Smart contracts | Add limits | Tier 3 |
| [x] #45 Incomplete cleanup in shutdown | fix/issue-045-incomplete-cleanup-in-shutdown | Multiple modules | Ensure cleanup | Tier 3 |
| [ ] #46 No deadlock detection | fix/issue-046-no-deadlock-detection | Orchestrations | Add detection | Tier 3 |
| [ ] #48 Multi-send invoice coordination | fix/issue-048-multi-send-invoice-coordination | agent/index.ts | Add dedup | Tier 3 |
| [x] #72 JSON.stringify collision in voting | fix/issue-072-json-stringify-collision-in-voting | aggregation.ts | Use canonical | Tier 3 |
| [ ] #90 Weight accumulation overflow | fix/issue-090-weight-accumulation-overflow | aggregation.ts | Add bounds | Tier 3 |
| [ ] #91 Handshake response sent before validation | fix/issue-091-handshake-response-sent-before-validation | message-bridge.ts | Validate first | Tier 3 |
| [ ] #92 Disconnect delay allows messages | fix/issue-092-disconnect-delay-allows-messages | message-bridge.ts | Immediate block | Tier 3 |
| [ ] #117 Unbounded Levenshtein O(n*m) | fix/issue-117-unbounded-levenshtein-o-n-m | packages/core/src/orchestrator/capability-matcher.ts | Add max length | Tier 3 |
| [ ] #130 Promise.all blocks if peer slow (dupes: #323) | fix/issue-130-promise-all-blocks-if-peer-slow | packages/core/src/node/bootstrap.ts | Use race | Tier 3 |
| [ ] #135 Token count hardcoded to 1 | fix/issue-135-token-count-hardcoded-to-1 | packages/core/src/services/llm.ts | Count actual | Tier 3 |
| [ ] #143 Predecessor operation chain validation | fix/issue-143-predecessor-operation-chain-validation | packages/contracts/src/EccoTimelock.sol | Validate chain | Tier 3 |
| [x] #167 Cluster transitive closure bug | fix/issue-167-cluster-transitive-closure-bug | packages/core/src/orchestrator/semantic-similarity.ts | Fix algorithm | Tier 3 |
| [ ] #168 Quadratic similarity O(n²) | fix/issue-168-quadratic-similarity-o-n | packages/core/src/orchestrator/semantic-similarity.ts | Early terminate | Tier 3 |
| [x] #169 New agent load state bias | fix/issue-169-new-agent-load-state-bias | packages/core/src/orchestrator/index.ts | Neutral default | Tier 3 |
| [ ] #176 Cascading timeout mismatch | fix/issue-176-cascading-timeout-mismatch | agent/index.ts; packages/core/src/agent/index.ts; packages/core/src/orchestrator/index.ts | Coordinate | Tier 3 |
| [x] #177 Semantic threshold not enforced | fix/issue-177-semantic-threshold-not-enforced | packages/core/src/orchestrator/aggregation.ts | Check threshold | Tier 3 |
| [x] #178 agentCount = 0 treated as falsy | fix/issue-178-agentcount-0-treated-as-falsy | packages/core/src/orchestrator/index.ts | Use ?? | Tier 3 |
| [x] #213 State update CAS retry without backoff | fix/issue-213-state-update-cas-retry-without-backoff | packages/core/src/node/state.ts | Add backoff | Tier 3 |
| [x] #214 Bloom filter false positive rate not bounded | fix/issue-214-bloom-filter-false-positive-rate-not-bounded | packages/core/src/utils/bloom-filter.ts | Validate 0-1 | Tier 3 |
| [x] #215 Bloom filter bit position out of bounds | fix/issue-215-bloom-filter-bit-position-out-of-bounds | packages/core/src/utils/bloom-filter.ts | Validate index | Tier 3 |
| [x] #216 RSSI value not validated | fix/issue-216-rssi-value-not-validated | packages/core/src/transport/manager.ts | Validate range | Tier 3 |
| [ ] #225 Weak message ID entropy | fix/issue-225-weak-message-id-entropy | packages/core/src/services/generation.ts | Add more entropy | Tier 3 |
| [x] #228 Message schema union type ambiguity | fix/issue-228-message-schema-union-type-ambiguity | packages/core/src/node/messaging.ts | Stricter schema | Tier 3 |
| [x] #243 Semantic similarity tie-breaking bias | fix/issue-243-semantic-similarity-tie-breaking-bias | packages/core/src/orchestrator/semantic-similarity.ts | Random tie-break | Tier 3 |
| [ ] #253 Zone selection deadlock | fix/issue-253-zone-selection-deadlock | packages/core/src/orchestrator/index.ts | Fallback | Tier 3 |
| [x] #270 Invoice ID UUID collision risk | fix/issue-270-invoice-id-uuid-collision-risk | packages/core/src/services/payment.ts | Add uniqueness | Tier 3 |
| [x] #272 Payment ledger no unique job ID | fix/issue-272-payment-ledger-no-unique-job-id | packages/core/src/storage/schema.ts | Add constraint | Tier 3 |
| [x] #278 WorkRewards halving off-by-one | fix/issue-278-workrewards-halving-off-by-one | packages/contracts/src/WorkRewards.sol | Fix comparison | Tier 3 |
| [ ] #280 Swap-and-pop race in removeDistributor | fix/issue-280-swap-and-pop-race-in-removedistributor | packages/contracts/src/WorkRewards.sol | Lock operation | Tier 3 |
| [x] #281 Bloom filter false positive rate zero crash | fix/issue-281-bloom-filter-false-positive-rate-zero-crash | packages/core/src/utils/bloom-filter.ts | Validate > 0 | Tier 3 |
| [x] #283 State version counter overflow | fix/issue-283-state-version-counter-overflow | packages/core/src/node/state.ts | Handle wrap | Tier 3 |
| [ ] #297 Dual resolve timer accumulation | fix/issue-297-dual-resolve-timer-accumulation | packages/core/src/services/generation.ts | Clear on resolve | Tier 3 |
| [ ] #300 AsyncIterator partial consumption cleanup | fix/issue-300-asynciterator-partial-consumption-cleanup | agent/index.ts; packages/core/src/agent/index.ts | Explicit cleanup | Tier 3 |
| [ ] #302 JSON.stringify vote key collision (dupes: #478) | fix/issue-302-json-stringify-vote-key-collision | packages/core/src/orchestrator/aggregation.ts | Canonical JSON | Tier 3 |
| [ ] #303 Payment timeout fires after rejection | fix/issue-303-payment-timeout-fires-after-rejection | packages/core/src/agent/payments.ts | Guard timeout | Tier 3 |
| [x] #314 PendingHandshake optional timeoutId | fix/issue-314-pendinghandshake-optional-timeoutid | packages/core/src/transport/message-bridge.ts | Always set | Tier 3 |
| [ ] #327 No network partition detection | fix/issue-327-no-network-partition-detection | packages/core/src/transport/message-bridge.ts | Add detection | Tier 3 |
| [x] #328 PubSub topic injection | fix/issue-328-pubsub-topic-injection | packages/core/src/transport/message-bridge.ts | Validate topic | Tier 3 |
| [ ] #331 Disconnect timer fires after rejected | fix/issue-331-disconnect-timer-fires-after-rejected | packages/core/src/transport/message-bridge.ts | Guard callback | Tier 3 |
| [x] #338 Round-robin without fairness | fix/issue-338-round-robin-without-fairness | packages/core/src/orchestrator/index.ts | Reset counts | Tier 3 |
| [x] #343 Rating delta clamping silent | fix/issue-343-rating-delta-clamping-silent | packages/core/src/node/reputation.ts | Log clamping | Tier 3 |
| [x] #348 Consensus threshold single response | fix/issue-348-consensus-threshold-single-response | packages/core/src/orchestrator/aggregation.ts | Min responses | Tier 3 |
| [ ] #349 Ranking contribution unbounded | fix/issue-349-ranking-contribution-unbounded | packages/core/src/orchestrator/aggregation.ts | Normalize | Tier 3 |
| [ ] #535 Constitution mismatch notice uses local config | fix/issue-535-constitution-mismatch-notice-uses-local-config | message-bridge.ts | Use effective constitution hash | Tier 3 |
| [x] #355 Floating point precision loss | fix/issue-355-floating-point-precision-loss | packages/core/src/node/peer-performance.ts | Better scaling | Tier 3 |
| [x] #356 Reputation manipulation via whale | fix/issue-356-reputation-manipulation-via-whale | packages/contracts/src/ReputationRegistry.sol | Cap weight | Tier 3 |
| [ ] #357 Unstake denial via activity penalty | fix/issue-357-unstake-denial-via-activity-penalty | packages/contracts/src/ReputationRegistry.sol | Cap penalty | Tier 3 |
| [x] #359 Payment ID collision exploitation | fix/issue-359-payment-id-collision-exploitation | packages/core/src/services/reputation-contract.ts | Add random | Tier 3 |
| [x] #360 Zero-reward job spam attack | fix/issue-360-zero-reward-job-spam-attack | packages/contracts/src/WorkRewards.sol | Require min reward | Tier 3 |
| [ ] #361 Fee distribution precision loss | fix/issue-361-fee-distribution-precision-loss | packages/contracts/src/FeeCollector.sol | Track dust | Tier 3 |
| [x] #362 Bloom filter false positive amplification | fix/issue-362-bloom-filter-false-positive-amplification | packages/core/src/utils/bloom-filter.ts | Lower rate | Tier 3 |
| [ ] #363 LRU cache eviction timing attack | fix/issue-363-lru-cache-eviction-timing-attack | packages/core/src/utils/lru-cache.ts | Constant time | Tier 3 |
| [x] #364 Governance vote manipulation | fix/issue-364-governance-vote-manipulation | packages/contracts/src/EccoToken.sol | Fix clock | Tier 3 |
| [x] #365 Rate limiter clock manipulation | fix/issue-365-rate-limiter-clock-manipulation | packages/core/src/utils/bloom-filter.ts | Monotonic time | Tier 3 |
| [x] #366 Unstake cooldown bypass | fix/issue-366-unstake-cooldown-bypass | packages/contracts/src/ReputationRegistry.sol | Cancel on stake | Tier 3 |
| [ ] #412 Activity penalty timestamp underflow | fix/issue-412-activity-penalty-timestamp-underflow | packages/contracts/src/ReputationRegistry.sol | Check bounds | Tier 3 |
| [x] #433 Bloom filter config allows zero/negative | fix/issue-433-bloom-filter-config-allows-zero-negative | packages/core/src/node/state.ts | Validate > 0 | Tier 3 |
| [ ] #434 Message timestamp without clock skew | fix/issue-434-message-timestamp-without-clock-skew | packages/core/src/services/auth.ts | Add tolerance | Tier 3 |
| [x] #435 Stream generation timeout no validation | fix/issue-435-stream-generation-timeout-no-validation | packages/core/src/services/generation.ts | Validate > 0 | Tier 3 |
| [ ] #461 Floating point comparison in sorting | fix/issue-461-floating-point-comparison-in-sorting | packages/core/src/orchestrator/capability-matcher.ts | Stable compare | Tier 3 |
| [ ] #462 Levenshtein empty string handling | fix/issue-462-levenshtein-empty-string-handling | packages/core/src/orchestrator/capability-matcher.ts | Handle edge | Tier 3 |
| [ ] #464 Activity penalty underflow | fix/issue-464-activity-penalty-underflow | packages/contracts/src/ReputationRegistry.sol | Check sign | Tier 3 |
| [ ] #465 Batch rate accepts empty arrays | fix/issue-465-batch-rate-accepts-empty-arrays | packages/contracts/src/ReputationRegistry.sol | Require > 0 | Tier 3 |
| [ ] #466 Reward epoch index bounds fragility | fix/issue-466-reward-epoch-index-bounds-fragility | packages/contracts/src/WorkRewards.sol | Validate | Tier 3 |
| [ ] #467 Zero difficulty handling | fix/issue-467-zero-difficulty-handling | packages/contracts/src/WorkRewards.sol | Handle zero | Tier 3 |
| [x] #469 LRU cache minimum capacity masks errors | fix/issue-469-lru-cache-minimum-capacity-masks-errors | packages/core/src/utils/lru-cache.ts | Warn on fix | Tier 3 |
| [ ] #470 Bloom filter empty items edge case | fix/issue-470-bloom-filter-empty-items-edge-case | packages/core/src/utils/bloom-filter.ts | Document | Tier 3 |
| [x] #471 Deduplicator hash collision during rotation | fix/issue-471-deduplicator-hash-collision-during-rotation | packages/core/src/utils/bloom-filter.ts | Accept FP | Tier 3 |
| [ ] #473 Aggregation empty response fragility | fix/issue-473-aggregation-empty-response-fragility | packages/core/src/orchestrator/aggregation.ts | Validate path | Tier 3 |
| [x] #474 Zone latency precision loss at scale | fix/issue-474-zone-latency-precision-loss-at-scale | packages/core/src/node/latency-zones.ts | Use BigInt | Tier 3 |
| [x] #475 Peer ranking sort stability | fix/issue-475-peer-ranking-sort-stability | packages/core/src/node/peer-tracker.ts | Document | Tier 3 |
| [ ] #476 Reputation casting BigInt precision loss | fix/issue-476-reputation-casting-bigint-precision-loss | packages/core/src/node/reputation.ts | Handle overflow | Tier 3 |
| [ ] #477 Capability score accumulation precision | fix/issue-477-capability-score-accumulation-precision | packages/core/src/orchestrator/capability-matcher.ts | Integer math | Tier 3 |
| [ ] #486 Callback contract violation | fix/issue-486-callback-contract-violation | packages/core/src/orchestrator/index.ts | Fix signature | Tier 3 |
| [ ] #489 Promise never fires if peerId undefined | fix/issue-489-promise-never-fires-if-peerid-undefined | agent/index.ts; packages/core/src/agent/index.ts | Check peerId | Tier 3 |
| [x] #491 Non-uniform random shuffle | fix/issue-491-non-uniform-random-shuffle | packages/core/src/orchestrator/index.ts | Fisher-Yates | Tier 3 |
| [ ] #519 completeUnstake underflow risk | fix/issue-519-completeunstake-underflow-risk | packages/contracts/src/ReputationRegistry.sol | SafeMath | Tier 3 |
| [ ] #521 Slash with zero percent allowed | fix/issue-521-slash-with-zero-percent-allowed | packages/contracts/src/ReputationRegistry.sol | Require > 0 | Tier 3 |
| [ ] #522 Sqrt precision loss for small stakes | fix/issue-522-sqrt-precision-loss-for-small-stakes | packages/contracts/src/ReputationRegistry.sol | Min weight 1 | Tier 3 |
| [ ] #550 Pubsub capability topics not namespaced by networkId | fix/issue-550-pubsub-capability-topics-not-namespaced-by-netwo | capabilities.ts | Namespace topics or include networkId in payload | Tier 3 |
| [ ] #551 Replay window resets on dedup rotation/restart | fix/issue-551-replay-window-resets-on-dedup-rotation-restart | bloom-filter.ts; messaging.ts | Persist dedup state or enforce freshness | Tier 3 |
| [x] #543 Handshake networkId not validated | fix/issue-543-handshake-networkid-not-validated | message-bridge.ts | Reject mismatched networkId | Tier 3 |
| [ ] #544 Broadcast topic not bound to signature | fix/issue-544-broadcast-topic-not-bound-to-signature | message-bridge.ts | Include topic in signature and verify match | Tier 3 |
| [ ] #545 Broadcast fallback accepts direct frames | fix/issue-545-broadcast-fallback-accepts-direct-frames | message-bridge.ts | Drop non-topic broadcasts | Tier 3 |
| [ ] #546 Dedup marks invalid messages as seen | fix/issue-546-dedup-marks-invalid-messages-as-seen | messaging.ts | Verify before dedup/rate-limit | Tier 3 |
| [ ] #547 Orchestrator response spoofing via requestId | fix/issue-547-orchestrator-response-spoofing-via-requestid | orchestrator/index.ts | Bind requestId to peer and validate sender | Tier 3 |
| [ ] #556 Voting window units mismatch with timestamp clock | fix/issue-556-voting-window-units-mismatch-with-timestamp-cloc | EccoToken.sol; EccoGovernor.sol | Validate voting delay/period in seconds | Tier 3 |
| [x] #559 Stake requirement bypass when reputation state missing | fix/issue-559-stake-requirement-bypass-when-reputation-state-m | index.ts | Fail closed or require reputationState before selection | Tier 3 |
| [x] #561 Error responses counted as success | fix/issue-561-error-responses-counted-as-success | index.ts | Treat error payloads as failures or require success flag | Tier 3 |
| [ ] #59 Process Cleanup Not Awaited (dupes: #502) | fix/issue-059-process-cleanup-not-awaited | packages/core/src/agent/index.ts | Await process cleanup and ensure teardown finishes before exit | Tier 3 |
| [ ] #212 Rate Limiter Loses Partial Refill Time (dupes: #282, #472) | fix/issue-212-rate-limiter-loses-partial-refill-time | packages/core/src/utils/bloom-filter.ts | Track refill remainder time to preserve rate limiter accuracy | Tier 3 |

## Tier 4: Low Severity (Logging, Performance, Config)

| Issue | Branch | Files | Fix | Priority |
| --- | --- | --- | --- | --- |
| [ ] #428 Debug flag without validation | fix/issue-428-debug-flag-without-validation | packages/core/src/utils/debug.ts | Normalize case | Tier 4 |
| [ ] #430 Consensus threshold no bounds | fix/issue-430-consensus-threshold-no-bounds | agent/index.ts; packages/core/src/agent/index.ts | Validate 0-1 | Tier 4 |
| [ ] #436 Error thrown without context | fix/issue-436-error-thrown-without-context | packages/core/src/services/auth.ts | Add context | Tier 4 |
| [ ] #437 Cleanup errors silently logged | fix/issue-437-cleanup-errors-silently-logged | packages/core/src/node/state.ts | Add context | Tier 4 |
| [ ] #438 Generation errors log full objects | fix/issue-438-generation-errors-log-full-objects | services/generation.ts; services/embedding.ts | Sanitize | Tier 4 |
| [ ] #439 Invalid signature warning missing context | fix/issue-439-invalid-signature-warning-missing-context | packages/core/src/node/messaging.ts | Add peer ID | Tier 4 |
| [ ] #440 Silent error swallowing in bridge | fix/issue-440-silent-error-swallowing-in-bridge | packages/core/src/transport/message-bridge.ts | Log error | Tier 4 |
| [ ] #441 Missing request correlation IDs | fix/issue-441-missing-request-correlation-ids | packages/core/src/services/generation.ts | Log consistently | Tier 4 |
| [ ] #442 Missing success/failure counters | fix/issue-442-missing-success-failure-counters | packages/core/src/node/bootstrap.ts | Add metrics | Tier 4 |
| [ ] #443 Handshake timeout handler missing severity | fix/issue-443-handshake-timeout-handler-missing-severity | packages/core/src/transport/message-bridge.ts | Add warning | Tier 4 |
| [ ] #444 Connection pool cleanup missing context | fix/issue-444-connection-pool-cleanup-missing-context | packages/core/src/connection/lifecycle.ts | Add pool size | Tier 4 |
| [ ] #445 Rate limit violations missing state | fix/issue-445-rate-limit-violations-missing-state | packages/core/src/node/messaging.ts | Log tokens | Tier 4 |
| [ ] #446 Debug function uses console.log | fix/issue-446-debug-function-uses-console-log | packages/core/src/utils/debug.ts | Use logger | Tier 4 |
| [ ] #447 Extensive debug calls without filtering | fix/issue-447-extensive-debug-calls-without-filtering | packages/core/src/node/messaging.ts | Filter level | Tier 4 |
| [ ] #448 Peer IDs logged without truncation | fix/issue-448-peer-ids-logged-without-truncation | packages/core/src/node/discovery.ts | Truncate | Tier 4 |
| [ ] #455 No metrics for message publishing | fix/issue-455-no-metrics-for-message-publishing | packages/core/src/node/messaging.ts | Add counters | Tier 4 |
| [ ] #456 No timing metrics for discovery | fix/issue-456-no-timing-metrics-for-discovery | packages/core/src/node/discovery.ts | Add timing | Tier 4 |
| [ ] #457 No audit trail for handshake failures | fix/issue-457-no-audit-trail-for-handshake-failures | packages/core/src/transport/message-bridge.ts | Add logging | Tier 4 |
| [ ] #458 Invalid signature warnings missing context | fix/issue-458-invalid-signature-warnings-missing-context | node/index.ts; packages/core/src/node/index.ts | Add details | Tier 4 |
| [ ] #459 Exception handlers don't distinguish | fix/issue-459-exception-handlers-don-t-distinguish | packages/core/src/node/messaging.ts | Type check | Tier 4 |
| [ ] #460 Silent duplicate message suppression | fix/issue-460-silent-duplicate-message-suppression | packages/core/src/node/messaging.ts | Log info | Tier 4 |
| [ ] #218 Bootstrap timeout zero/negative | fix/issue-218-bootstrap-timeout-zero-negative | packages/core/src/types.ts | Validate > 0 | Tier 4 |
| [ ] #118 Floating point precision loss in matchFeatures (dupes: #232, #291) | fix/issue-118-floating-point-precision-loss-in-matchfeatures | packages/core/src/orchestrator/capability-matcher.ts; packages/core/src/orchestrator/aggregation.ts | Use integer math for feature match accumulation to avoid drift | Tier 4 |
| [ ] #122 Precision loss in token calculation (dupes: #259, #399) | fix/issue-122-precision-loss-in-token-calculation | packages/core/src/agent/payments.ts | Use integer/BigInt math for token calculations and avoid floats | Tier 4 |
| [ ] #123 validateInvoice() defined but never called (dupes: #287) | fix/issue-123-validateinvoice-defined-but-never-called | packages/core/src/services/payment.ts | Call validateInvoice during invoice processing and reject invalid invoices | Tier 4 |
| [ ] #144 Rounding dust lost in fee distribution (dupes: #192, #468) | fix/issue-144-rounding-dust-lost-in-fee-distribution | packages/contracts/src/FeeCollector.sol | Track and carry forward fee distribution remainder dust | Tier 4 |
