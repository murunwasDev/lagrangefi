# On-Chain Safety Review Playbook

> Audit playbook for everything between "the api decided to rebalance" and "the chain operation has irrevocably affected the user's wallet". This is the playbook with the most direct catastrophic-loss potential.

**Scope:**
- Slippage / MEV / sandwich resistance
- Idempotency end-to-end (api ↔ chain ↔ on-chain)
- Gas-vs-fee profitability and circuit breakers
- RPC fault tolerance and price-oracle trust
- Self-healing recovery on partial failure

**Sister playbooks:** [`security.md`](security.md) for wallet-key handling, [`numerical-correctness.md`](numerical-correctness.md) for `BigDecimal`/`bigint` discipline, [`chain-style.md`](chain-style.md) for the chain service shape, [`observability.md`](observability.md) for what we'd see during an incident.

**Reference:** [`BEST_PRACTICES.md §1.3 Idempotency`](../BEST_PRACTICES.md), [`§3.3 On-Chain Operations`](../BEST_PRACTICES.md), [`CLAUDE.md "Known risks"`](../../CLAUDE.md).

---

## 1. Slippage on every swap

Every rebalance contains a swap. Every swap is exposed to:
- Pool price drift between simulation and execution (latency / block movement).
- MEV: front-running, back-running, sandwich attacks.

### Audit questions

- [ ] Every `writeContract({ abi: ..., functionName: 'exactInputSingle', ...})` includes a non-zero `amountOutMinimum` derived from the user's `slippageTolerance`?
- [ ] `slippageTolerance` is **per-strategy** ([`Tables.kt:35`](../../apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt) — yes, default `0.005`)?
- [ ] The api validates `slippageTolerance` is in a sane range (e.g. `0 < x ≤ 0.05`)? Anything above 5% is begging to be sandwiched.
- [ ] Slippage formula in [`apps/chain/src/services/swap.ts:109,117,132,140`](../../apps/chain/src/services/swap.ts) computes `amountOutMinimum` as `expectedOut * (1 - slippageTolerance)` with realistic rounding (`Math.floor` so the bound is conservative)?
- [ ] No swap path uses `amountOutMinimum: 0n` "for testing" left in production code?
- [ ] No swap fallback that retries with `slippageTolerance × 2` after a slippage revert — that defeats the protection?

### How to inspect

```bash
# Every writeContract for a swap should pass amountOutMinimum
git grep -nB2 -A8 "writeContract\(" apps/chain/src/services | grep -E "amountOutMinimum|exactInputSingle"

# zero or magic-number minimums
git grep -nE 'amountOutMinimum:\s*0n?\b|amountOutMinimum:\s*1n\b' apps/chain/src

# slippage range validation in api
git grep -nE 'slippageTolerance|require\(' apps/api/src/main/kotlin/fi/lagrange/services/StrategyService.kt apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt
```

### Red flags

- A swap with `amountOutMinimum: 0n` — accepts any price, attacker takes the difference.
- `slippageTolerance` accepted with no upper bound — a user setting `0.5` (50%) signs an open invitation to sandwich.
- The slippage check applied to a **floating-point estimate** that is later rounded — the `bigint` swap may exit the rounded bound but the human estimate still says "looks fine".
- A swap path that catches `SlippageExceeded` and proceeds without alert — silent value loss.

### Reference
[`BEST_PRACTICES.md §3.3`](../BEST_PRACTICES.md), [`CLAUDE.md "Slippage / sandwich attacks"`](../../CLAUDE.md). [`apps/chain/src/services/swap.ts`](../../apps/chain/src/services/swap.ts).

---

## 2. MEV and private mempools

Arbitrum's sequencer in 2026 still front-runs in some scenarios. Slippage caps are necessary but not sufficient.

### Audit questions

- [ ] `BEST_PRACTICES.md` and `CLAUDE.md "Known risks"` flag **post-MVP: private mempool (Flashbots Protect on Arbitrum)**. Has this status changed? If yes, document the chosen mechanism. If no, flag as outstanding.
- [ ] Are there alerts when a single rebalance shows `amountOutActual < amountOutExpected * 0.99` (post-trade analysis suggesting MEV extraction)?
- [ ] Has anyone reviewed the **rebalance frequency** as an MEV vector — predictable timers are easier to sandwich than randomised intervals?
- [ ] Is there a "drift threshold" gate before triggering a swap — i.e. the pool tick must have been outside range for at least N blocks, not just one observation?

### How to inspect

```bash
# Search for any private-mempool / Flashbots wiring
git grep -niE 'flashbots|mev|private.?mempool|protect\.flashbots' apps/

# Rebalance frequency / poll interval handling
git grep -nE 'pollIntervalSeconds' apps/api/src

# Post-trade slippage telemetry
git grep -nE 'amountOutActual|swapCostUsd|priceDriftPct' apps/api/src/main/kotlin
```

### Red flags

- "Private mempool" never discussed in any PR — flag for next architecture review.
- A telemetry pipeline that surfaces `swap_cost_usd` to dashboards but no alert threshold defined.
- Strategies allowed to set `pollIntervalSeconds: 1` — predictable per-second swaps maximise MEV exposure.

### Reference
[`CLAUDE.md "Known risks"`](../../CLAUDE.md), [`docs/rebalance-cost-tracking.md`](../rebalance-cost-tracking.md).

---

## 3. Idempotency end-to-end

The api inserts a `strategy_events` row with `idempotencyKey` **before** sending to chain. Chain rejects duplicates. On retry, both sides converge.

### Audit questions

- [ ] Idempotency keys are UUID v4, never timestamps? **Open TODO `Routing.kt:336,370` (`BEST_PRACTICES.md §1.3`):** `DELETE /strategies/{id}` previously used `"close-$strategyId-${System.currentTimeMillis()}"`. Verify replaced with `UUID.randomUUID().toString()`.
- [ ] The api inserts the `strategy_events` row **before** calling chain (so a chain timeout doesn't lose the key)?
- [ ] If chain returns 409 (duplicate), api looks up the existing event and treats it as already-attempted (success or failed, not "retry from scratch")?
- [ ] Chain's `processedKeys` is the in-memory `Set` — known gap. The implication: a chain pod restart re-opens the dedup window. Are operators aware that **the api must not re-issue the same idempotency key after a chain restart unless it has confirmed the previous attempt did not succeed**?
- [ ] No code path generates a new idempotency key on retry (defeats the entire mechanism)?

### How to inspect

```bash
# UUID generation for keys
git grep -nE 'UUID\.randomUUID|java\.util\.UUID' apps/api/src

# Timestamp-based key anti-pattern
git grep -nE 'currentTimeMillis|Instant\.now\(\)' apps/api/src/main/kotlin/fi/lagrange/plugins apps/api/src/main/kotlin/fi/lagrange/services | grep -iE 'idempotency|key'

# Sequence: insert event row vs call chain
sed -n '/fun executeRebalance/,/^    }/p' apps/api/src/main/kotlin/fi/lagrange/strategy/UniswapStrategy.kt
```

### Red flags

- An idempotency key derived from `(strategyId, timestamp)` — second call within the same millisecond gets the same key, two parallel calls within different milliseconds get different keys, the worst of both worlds.
- A `try { chain.execute(); db.insertEvent() }` ordering — a successful chain call followed by a DB write failure leaves on-chain state without a record.
- A retry path that calls `UUID.randomUUID()` again — every retry is a fresh attempt to chain, deduplication cannot help.

### Reference
[`BEST_PRACTICES.md §1.3 Idempotency`](../BEST_PRACTICES.md), [`§3.7`](../BEST_PRACTICES.md). [`UniswapStrategy.kt`](../../apps/api/src/main/kotlin/fi/lagrange/strategy/UniswapStrategy.kt), [`StrategyEventRepository.kt`](../../apps/api/src/main/kotlin/fi/lagrange/services/StrategyEventRepository.kt).

---

## 4. Gas vs fee profitability

A small position rebalanced at $40 of gas to capture $5 of fees is a recurring loss.

### Audit questions

- [ ] Profitability check before triggering a rebalance: `expectedFees >= gasCostEstimate * minProfitMultiplier`?
- [ ] If absent (per [`CLAUDE.md "Known risks"` — post-MVP](../../CLAUDE.md)), is there at least an alert when `current_rebalancing_drag_usd` ([`Tables.kt:76`](../../apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt)) trends consistently negative?
- [ ] A circuit breaker stops a strategy after N consecutive unprofitable rebalances?
- [ ] No "always rebalance on every poll tick" path that ignores drift — that produces fee burn without yield?

### How to inspect

```bash
# Profitability check predicate
git grep -niE 'profitabilit|expectedFees|gasEstimate|minProfit' apps/api/src

# Rebalancing drag and threshold logic
git grep -niE 'rebalancingDrag|drag.*alert|stopOnLoss' apps/api/src

# Consecutive failure counter
git grep -niE 'consecutive.*fail|circuitBreaker' apps/api/src
```

### Red flags

- Profitability gate planned but never implemented — track until it is.
- A strategy that rebalances on every poll tick despite remaining in-range — `time_in_range_pct` near 100% but fees drained.
- `currentRebalancingDragUsd` accumulating monotonically without an alert.

### Reference
[`CLAUDE.md "Rebalance profitability"`](../../CLAUDE.md), [`docs/rebalance-cost-tracking.md`](../rebalance-cost-tracking.md), [`docs/financial-transparency.md`](../financial-transparency.md).

---

## 5. RPC fault tolerance

Single RPC endpoint is a single point of failure ([`CLAUDE.md "Known risks"`](../../CLAUDE.md), [`config.ts:12`](../../apps/chain/src/config.ts)).

### Audit questions

- [ ] Has a secondary RPC been added (e.g. via viem `fallback({...transports})` array)?
- [ ] If still single-endpoint, the chain service surfaces RPC failures distinctly from "tx reverted" — operators must be able to triage `RPC down` vs `tx failed`?
- [ ] Idempotency keys not consumed when the failure was RPC unreachable (chain code path: [`execute.ts:26`](../../apps/chain/src/routes/execute.ts) deletes the key on error — verify this is the right behaviour for transient RPC errors specifically)?
- [ ] A `viem` HTTP transport has a sane timeout (default is 10s; for `waitForTransactionReceipt` the timeout should match block time × confirmations)?
- [ ] Health check endpoint includes an RPC liveness ping (not just "process is up")?

### How to inspect

```bash
# fallback transport
git grep -nE 'fallback\(|http\(.*\),\s*http\(' apps/chain/src

# Timeouts
git grep -nE 'timeout:\s*\d|pollingInterval' apps/chain/src

# RPC errors classified
git grep -niE 'isRpcError|HttpRequestError|TimeoutError' apps/chain/src
```

### Red flags

- A single `http(rpcUrl)` transport — confirmed by [`config.ts:18-19`](../../apps/chain/src/config.ts), no fallback.
- `/health` returns "ok" while RPC is unreachable.
- A long polling cycle that never times out — chain pod hung, k8s doesn't recycle it.

### Reference
[`CLAUDE.md "Single RPC endpoint"`](../../CLAUDE.md), [`apps/chain/src/config.ts`](../../apps/chain/src/config.ts).

---

## 6. Price oracle trust

V1 uses pool price to decide in/out of range. Pool price is manipulable.

### Audit questions

- [ ] Position-state checks (`isOutOfRange`, `tickLower < currentTick < tickUpper`) sourced from pool tick — same source api uses for the rebalance decision?
- [ ] Cross-check with a Chainlink oracle or TWAP planned (per [`CLAUDE.md "Price oracle"` post-MVP](../../CLAUDE.md))?
- [ ] No code path makes a financial decision (e.g. computing slippage tolerance dynamically) from a single block's spot price?

### How to inspect

```bash
git grep -niE 'chainlink|oracle|twap|priceX\d+' apps/

# All places where current tick / sqrtPrice is consumed for decisions
git grep -nE 'currentTick|sqrtPriceX96' apps/api/src/main/kotlin/fi/lagrange/strategy
```

### Red flags

- A "next version we'll add Chainlink" comment older than 6 months — track or close.
- A sanity check `if priceMovedMoreThan(50%) skipRebalance()` based on the same pool tick — circular.

### Reference
[`CLAUDE.md "Price oracle"`](../../CLAUDE.md).

---

## 7. Self-healing recovery on partial failure

A rebalance is a 4-step sequence:
1. Collect fees from old position.
2. Withdraw liquidity, burn old NFT.
3. Swap to target ratio.
4. Mint new NFT at new range.

Crashing between steps 2 and 4 leaves the user holding raw tokens with no LP. This is the most common failure mode and `apps/chain/src/services/rebalance.ts` includes recovery logic ([`fix: self-healing recovery`](../../apps/chain) per [`README.md`](../../README.md) commit history).

### Audit questions

- [ ] Recovery handler `recoverCollect` (or equivalent) exists and is invoked from the `rebalance.ts` catch block?
- [ ] Recovery is idempotent: running it twice does not double-claim or revert?
- [ ] All four steps' tx hashes recorded in DB (`chain_transactions` table) regardless of which step succeeded last? Pre-empts "we know there's an open NFT but no record where".
- [ ] On step 3 (swap) failure, the system can either (a) retry the swap with the same `amountOutMinimum`, or (b) abandon and re-mint the old position with the unswapped balances?
- [ ] On step 4 (mint) failure, the user has documentation explaining how to manually re-mint (a runbook)?
- [ ] Tests cover each crash-point (collect fail, burn fail, swap fail, mint fail)?

### How to inspect

```bash
# Recovery code
git grep -nE 'recoverCollect|recoverRebalance|recover\(' apps/chain/src
sed -n '/catch/,/^  }/p' apps/chain/src/services/rebalance.ts | head -40

# DB records pre-empt: `chain_transactions` writes
git grep -nE 'ChainTransactions\.insert|recordChainTransaction' apps/api/src
```

### Red flags

- A `catch { console.error; return }` after step 2 — funds in raw token form, no recovery.
- A `recoverCollect` that re-issues a swap without verifying the position state — duplicate output.
- A retry that uses a fresh idempotency key — chain de-dup defeated.

### Reference
[`BEST_PRACTICES.md §3.5`](../BEST_PRACTICES.md). [`apps/chain/src/services/rebalance.ts`](../../apps/chain/src/services/rebalance.ts).

---

## 8. Wallet & key handling at execution time

Cross-link to [`security.md §3, §6`](security.md), but specifically for the on-chain hot path:

### Audit questions

- [ ] The decrypted phrase is held only in the request scope of one chain invocation — never written to disk, no in-memory cache?
- [ ] No log line, no Telegram alert, no error envelope contains the wallet key?
- [ ] A simulation step (`simulateContract`) before each `writeContract` — to fail-fast on a revert before consuming nonce?
- [ ] Nonce management via viem's automatic next-nonce vs. an explicit `nonce` field — pinned to one strategy; not mixed in the same code path?

### How to inspect

```bash
git grep -nE 'simulateContract' apps/chain/src
git grep -nE 'nonce:' apps/chain/src
```

### Red flags

- A diff that adds a `cache.set(userId, phrase)` "for performance" — wallet leak window opened.
- `writeContract(...)` without a preceding `simulate` — first you find out it reverts is a wasted gas tx.
- Manual nonce mismatched with concurrent rebalances on the same wallet (only one strategy active per user mitigates this — verify `CLAUDE.md "Multi-user model"`'s "at most one active strategy" rule is still enforced).

### Reference
[`CLAUDE.md "Multi-user model" / "Wallet key flow"`](../../CLAUDE.md), [`security.md §3`](security.md).

---

## 9. Spending limits / circuit breaker

### Audit questions

- [ ] Per-tx spending cap (`maxNotionalUsd`) enforced before sending a swap?
- [ ] Per-day cap (cumulative across strategies for a wallet)?
- [ ] Per-strategy stop-loss in USD (e.g. close strategy if `currentValueUsd < initialValueUsd * 0.5`)?
- [ ] Operator kill-switch documented (e.g. setting all `Strategies.status` to `STOPPED_MANUALLY` via `/db` skill — this stops the scheduler from picking them up on next loop, but **does not cancel an in-flight rebalance**)?

### How to inspect

```bash
git grep -niE 'spendingLimit|maxNotional|dailyCap|stopLoss|killSwitch|emergencyStop' apps/

# Current state of any enforcement
git grep -nE 'require.*usd|require.*amount' apps/api/src
```

### Red flags

- Per [`CLAUDE.md "Known risks"`](../../CLAUDE.md): **no spending limits**. Track until added.
- A kill-switch that touches the database but the scheduler caches strategies in memory — needs to also flush/cancel timers (cross-link to [`api-style.md §5`](api-style.md)).

### Reference
[`CLAUDE.md "Operational" risks`](../../CLAUDE.md).

---

## 10. Replay / fork-test coverage

### Audit questions

- [ ] At least some integration tests run against a forked Arbitrum (Hardhat or Anvil) at a pinned block — i.e. real liquidity, real price?
- [ ] One end-to-end test exercises the full rebalance: mint position → move tick out of range → trigger rebalance → verify new NFT?
- [ ] Tests for slippage limit hit (swap reverts, recovery runs)?
- [ ] Tests for partial-failure paths (collect succeeds, burn fails)?
- [ ] CI runs the fork tests on PRs that touch `apps/chain/src/services/`?

### How to inspect

```bash
# Fork test config
git grep -niE 'anvil|hardhat|forkBlockNumber|RPC_FORK_URL' apps/
ls apps/chain/test 2>/dev/null
git grep -nE 'describe\(|it\(|test\(' apps/chain | head
```

### Red flags

- All chain tests run against `localhost:8545` Anvil with empty state — no liquidity, no realistic prices.
- The most exercised path in production has zero tests on the partial-failure branches.

### Reference
[`CLAUDE.md "Fork testing"`](../../CLAUDE.md), [`testing.md`](testing.md).

---

## How to run this review

1. **Open a fresh Claude Code session.** Have access to the `/db` skill in case you want to spot-check `strategy_events.idempotency_key` distributions or `rebalance_details` history.
2. Walk top-to-bottom through sections 1 → 10. For each: run the inspection commands, paste output, mark **yes / no / partial**.
3. Tag findings:
   - **[critical]** money-loss risk that exists *now*: missing slippage cap, idempotency key reuse, recovery-handler crash on partial state, single-RPC pod stuck.
   - **[high]** known-risk items that have not progressed since `CLAUDE.md` was last updated: no fallback RPC, no profitability check, in-memory dedup.
   - **[medium]** alerting/telemetry gaps that would catch a [critical] *next time*.
   - **[low]** cosmetic.
4. Walk one rebalance request through the full path manually: api `StrategyScheduler` → `UniswapStrategy.execute` → `ChainClient.rebalance` → chain `routes/execute.ts` → `services/rebalance.ts` → on-chain. Note every error-path branch.
5. Recurring items to track each pass (these will likely stay [high] until v2 lands):
   - Private mempool decision (§2).
   - Idempotency UUID-only enforcement and `chain` Postgres-backed store (§3).
   - Profitability gate (§4).
   - Fallback RPC (§5).
   - Chainlink/TWAP cross-check (§6).
   - Spending caps / circuit breaker (§9).
   - Forked-Arbitrum tests (§10).

A typical pass takes **60-90 minutes** because each section invites manual reasoning about money flow, not just grep-and-confirm.
