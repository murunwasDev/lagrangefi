# Numerical Correctness Review Playbook

> Audit playbook for financial math precision: `BigDecimal` (Kotlin), `bigint` (TypeScript), token decimals, rounding, and the float boundary.

**Scope:** Anywhere a token amount, gas cost, USD value, price, tick, or `sqrtPriceX96` is read, written, computed, or transmitted.

This is the playbook with the most direct money risk. A `Double` where a `BigDecimal` should be is silent — it produces convincingly-shaped wrong numbers, not crashes.

**Sister playbooks:** [`database.md §4`](database.md) for column types, [`chain-style.md §5`](chain-style.md) for `bigint` discipline, [`api-style.md §9`](api-style.md) for serialisation.

**Reference:** [`BEST_PRACTICES.md §1.6 Decimal & Financial Math`](../BEST_PRACTICES.md), [`§3.4 BigInt and Decimal Handling`](../BEST_PRACTICES.md).

---

## 1. Allowed and forbidden types per domain

| Value class                                    | Kotlin (api)        | TypeScript (chain / web)   |
|------------------------------------------------|---------------------|----------------------------|
| Raw ERC-20 amount (uint256)                    | `BigDecimal` or `BigInteger` (or `String` over wire) | `bigint` (or `string` over wire) |
| Tick (int24)                                   | `Int`               | `number`                   |
| Liquidity (uint128)                            | `BigInteger` / `String` | `bigint`               |
| sqrtPriceX96 (uint160)                         | `BigInteger` / `String` | `bigint`               |
| Gas in wei (per-tx)                            | `Long`              | `bigint` then `Number(...)` only at write to `gasCostWei` column (see §4) |
| Cumulative gas in wei                          | `Long` (current) — flag if approaches 2^63 | `bigint` |
| ETH price USD                                  | `BigDecimal`(18,8)  | `number` (display only)    |
| USD aggregates (fees, gas, drag)               | `BigDecimal`(18,2)  | `number` (display only)    |
| Percentages (rangePercent, slippageTolerance, drift) | `Double` (intentional exception, [`BEST_PRACTICES.md §1.6`](../BEST_PRACTICES.md)) | `number` |

### Audit questions

- [ ] No raw token amount is typed as `Double` / `Float` (Kotlin) or `number` (TS) anywhere on the read/write path?
- [ ] No `sqrtPriceX96` or liquidity passes through `Number(...)` outside an explicit `toHumanFloat`-style helper?
- [ ] All USD aggregates persisted as `BigDecimal(18, 2)` and never widened to `Double` mid-computation?
- [ ] `Long`-typed cumulative `gas_cost_wei` ([`Tables.kt:65`](../../apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt)) — any analytic forecast of when it might overflow `2^63 - 1` (~9.22 × 10^18) wei? Per-tx wei fits comfortably; **per-strategy lifetime sum** at high gas could approach this in years.

### How to inspect

```bash
# Kotlin: Double appearing in service / repository code that handles money
git grep -nE ':\s*Double[\s,)]|Double\.' apps/api/src/main/kotlin/fi/lagrange/services apps/api/src/main/kotlin/fi/lagrange/strategy

# TypeScript: Number(...) on values that look like on-chain quantities
git grep -nE 'Number\((sqrt|liquidity|amount|tick)' apps/chain/src apps/web/src

# Implicit conversions: token amount * decimal as float
git grep -nE 'Number\([a-zA-Z_]+\)' apps/chain/src/services
```

### Red flags

- A new `Double` field in `StrategyRecord` / `StrategyStatsDto` for a USD value that was previously `BigDecimal` — silent precision regression.
- A `Number(amount0)` where `amount0: bigint` is an unscaled token amount.
- A `decimal(18, 18)` column added by mistake (should be `varchar(78)` for raw amounts, `decimal(18, 2)` for USD).

### Reference
[`BEST_PRACTICES.md §1.6`](../BEST_PRACTICES.md), [`Tables.kt`](../../apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt).

---

## 2. Decimal-aware conversions

### Audit questions

- [ ] All conversions between raw amounts and human-readable values use a single helper per side: viem's `formatUnits` / `parseUnits` (TS) and a Kotlin equivalent that takes the decimals as a parameter?
- [ ] No constant `1e18` / `10n ** 18n` in code — token decimals come from `pool_state.decimals0` / `decimals1` or `Strategies.token0_decimals`?
- [ ] No `divide` without an explicit scale and `RoundingMode` (Kotlin) — `BigDecimal.divide(...)` defaults to throwing on non-terminating decimals, but worse, with a `MathContext`, it can silently round in unexpected ways?
- [ ] Rounding mode declared `HALF_UP` for money math (matches accounting convention)? Currently `Routing.kt:153` uses `HALF_UP` ✓.
- [ ] `parseUnits` always called with the right decimals for that side of the pair (USDC = 6, WETH = 18 — token0/token1 ordering depends on pool address)?

### How to inspect

```bash
# Hardcoded 1e18 / 10**18 — likely missing a decimals parameter
git grep -nE '1e18|1e6|10\\\\*\\\\*1[68]|10n \\* 10n|BigDecimal\.TEN\.pow\(1[68]\)' apps/

# divide() calls without a scale + RoundingMode
git grep -nE '\.divide\(' apps/api/src/main/kotlin

# parseUnits / formatUnits call sites
git grep -nE 'parseUnits|formatUnits' apps/chain/src apps/api/src
```

### Red flags

- `BigDecimal.divide(other)` without a scale — runtime `ArithmeticException` on non-terminating quotients.
- `parseUnits(req.amount, 18)` for a side that might be USDC (6 decimals) — silent value blow-up.
- `Number(amount) * 1e-6` as a "quick conversion" — `Number(bigint)` already lost precision.
- Token0 / token1 ordering assumed without `Strategies.token0Decimals` lookup — Uniswap pairs are sorted by address; for WETH/USDC on Arbitrum it varies and matters.

### Reference
[`BEST_PRACTICES.md §1.6`](../BEST_PRACTICES.md), [`§3.4`](../BEST_PRACTICES.md). [`Routing.kt:150-180`](../../apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt).

---

## 3. Tick math precision

Uniswap v3 ticks live in `[-887272, 887272]` and have an integer relationship to price via `price = 1.0001^tick`. The **only** correct way to compute new ranges is via the published Uniswap v3 SDK math or a faithful port — never via float approximation.

### Audit questions

- [ ] `calcTickRange` ([`apps/api/src/main/kotlin/fi/lagrange/strategy/StrategyMath.kt`](../../apps/api/src/main/kotlin/fi/lagrange/strategy/StrategyMath.kt)) is the single source of truth, called from both `Routing.kt` and `UniswapStrategy.kt`?
- [ ] Tick spacing per fee tier (`100 → 1`, `500 → 10`, `3000 → 60`, `10000 → 200`) is hardcoded somewhere central, not duplicated?
- [ ] `calcTickRange` returns multiples of tick spacing (a tick that isn't a multiple of spacing is invalid for that pool)?
- [ ] The rounding inside tick math (`floorDiv` vs plain integer division) is consistent everywhere — open TODO in `BEST_PRACTICES.md §2.4` previously noted divergence between `Routing.kt:63-71` and `UniswapStrategy.kt:204-212`?
- [ ] Tests cover boundary ticks (price = current, price at exactly tick boundary, max/min ticks)?

### How to inspect

```bash
# Single tick-math source check
git grep -nE 'fun calcTickRange|fun tickToPrice|tickSpacing\s*=' apps/api/src

# Hardcoded tick spacings  
git grep -nE '\bcase 500\b|\bcase 3000\b|\bif fee == 500' apps/api/src apps/chain/src

# floorDiv / integer division mixing
git grep -nE 'floorDiv|/[^/]\b' apps/api/src/main/kotlin/fi/lagrange/strategy
```

### Red flags

- A `tickToPrice` implemented with `Math.pow(1.0001, tick)` — silent rounding for ticks beyond ±50000 or so.
- A new tick-math helper added next to an existing one ("temporary copy") — drift inevitable.
- A unit test that checks `calcTickRange(0, 500, 0.05)` without also checking near-boundary values.

### Reference
[`BEST_PRACTICES.md §2.4`](../BEST_PRACTICES.md). [`StrategyMath.kt`](../../apps/api/src/main/kotlin/fi/lagrange/strategy/StrategyMath.kt), [`UniswapStrategy.kt`](../../apps/api/src/main/kotlin/fi/lagrange/strategy/UniswapStrategy.kt).

---

## 4. The float boundary in chain service

`apps/chain` has a small set of intentional float operations for swap-ratio estimation. They live in `swap.ts` and a few spots in `rebalance.ts`. Each must be auditable.

### Audit questions

- [ ] Every `Number(bigint)` call has a comment justifying it (estimation, USD display) or is wrapped in a named helper (`toHumanFloat`)?
- [ ] Each estimation rounds back to `bigint` with `BigInt(Math.floor(...))` or `BigInt(Math.round(...))`, never raw cast?
- [ ] No `Number(receipt.gasUsed * receipt.effectiveGasPrice)` for production-scale gas (though current values fit comfortably in `Number`'s 53-bit safe integer range, the *cumulative* count in `gasCostWei` summed in DB could overflow `Long` over years)?
- [ ] `sqrtPriceX96 → price` conversion uses Uniswap's published formula `price = (sqrtPriceX96 / 2**96) ** 2` adjusted for token decimals, not a homebrew?
- [ ] Slippage check applied to the post-swap `bigint` value, not the float estimation?

### How to inspect

```bash
# All Number(...) call sites in chain — each must be acceptable
git grep -nE '\bNumber\(' apps/chain/src

# BigInt() reconversions — verify each is preceded by Math.floor / Math.round
git grep -nB1 'BigInt\(Math\.' apps/chain/src

# sqrtPriceX96 math
git grep -nE 'sqrtPrice|2\\\\*\\\\*96|2n \\\\*\\\\* 96n' apps/chain/src
```

### Red flags

- `Number(sqrtPriceX96) / 2 ** 96` followed by `* something` — fine for estimation, but if the result is then used to compute slippage minimums, it must be reconverted to `bigint` carefully (currently visible at [`rebalance.ts:393-412`](../../apps/chain/src/services/rebalance.ts) — verify the path back to `bigint` is sound).
- `BigInt(Number(x))` — round-trip through float, gains nothing, loses precision.
- `Number(amount0Desired)` for an amount that exceeds `2^53` — JavaScript silently rounds. Token amounts above ~9 quadrillion wei (~9 ETH for 18-decimal tokens) are realistic.

### Reference
[`BEST_PRACTICES.md §3.4`](../BEST_PRACTICES.md). [`apps/chain/src/services/swap.ts`](../../apps/chain/src/services/swap.ts), [`rebalance.ts`](../../apps/chain/src/services/rebalance.ts).

---

## 5. Wire-format discipline

### Audit questions

- [ ] All raw token amounts (`amount0`, `amount1`, `feesCollectedToken0`, etc.) sent over the wire as **strings**, not numbers?
- [ ] DTOs in `StrategyService.kt` and `ChainClient.kt` declare these fields as `String`, not `Long` or `Double`?
- [ ] Frontend types ([`apps/web/src/types.ts`](../../apps/web/src/types.ts)) match: every raw amount field is `string`?
- [ ] The frontend never `parseFloat`s a token amount string for math — only for display formatting via `formatUnits`-style helpers?
- [ ] No silent `JSON.stringify` of a `bigint` (browsers throw; Node 22 throws) — wire conversion via `String(x)` or `x.toString()` in chain service before sending JSON?

### How to inspect

```bash
# DTO fields named like amounts/fees that aren't String
git grep -nE 'val (amount|fee|gas|swapCost|pending|initial|end)[A-Za-z0-9_]*\s*:\s*(Long|Double)' apps/api/src
git grep -nE '(amount|fee|gas|swapCost|pending|initial|end)[A-Za-z0-9_]*:\s*number' apps/web/src/types.ts apps/chain/src

# parseFloat / Number on amount strings in web
git grep -nE 'parseFloat|Number\(' apps/web/src

# bigint serialisation in chain
git grep -nE 'JSON\.stringify' apps/chain/src
```

### Red flags

- `amount0: number` in [`apps/web/src/types.ts`](../../apps/web/src/types.ts) — the api sends `string`, web parses as number, precision lost.
- A `JSON.stringify({ liquidity: bigint(...) })` — runtime TypeError.
- A `BigInt(req.body.amount)` in chain that doesn't reject NaN-shaped strings — silently zero.

### Reference
[`BEST_PRACTICES.md §1.6`](../BEST_PRACTICES.md), [`api-contracts.md`](api-contracts.md).

---

## 6. USD computations

### Audit questions

- [ ] Every USD value computed as `BigDecimal` (api side) or `number` only at the **display** boundary (web side)?
- [ ] ETH price feed has 8 decimals (`decimal(18, 8)`) — multiplications use full precision before truncating to `decimal(18, 2)`?
- [ ] `BigDecimal.multiply(...)` followed by an explicit `.setScale(2, HALF_UP)` before persisting?
- [ ] `current_rebalancing_drag_usd` and `price_drift_usd` formulas documented somewhere — `docs/financial-transparency.md` exists, verify it's referenced by the relevant service?
- [ ] No double-conversion: api sends `feesCollectedUsd: BigDecimal`, web shouldn't multiply it again by ETH price?

### How to inspect

```bash
# BigDecimal multiplications without an immediate setScale
git grep -nB2 -A2 '\.multiply(' apps/api/src/main/kotlin

# USD calculations in web (suspect — should already be USD)
git grep -nE 'usd.*\*|ethPrice.*\*' apps/web/src

# Reference to financial-transparency doc
git grep -nE 'financial-transparency' apps/ docs/
```

### Red flags

- `BigDecimal.divide(price, MathContext.DECIMAL64)` — defaults silently to a non-money rounding mode.
- A computation that mixes `Double` and `BigDecimal` — Kotlin's `BigDecimal(Double)` is itself imprecise, use the `BigDecimal(String)` constructor.
- A USD value that round-trips through web as a number then back to api — at minimum two precision-loss boundaries.

### Reference
[`BEST_PRACTICES.md §1.6`](../BEST_PRACTICES.md), [`docs/financial-transparency.md`](../financial-transparency.md), [`docs/rebalance-cost-tracking.md`](../rebalance-cost-tracking.md).

---

## 7. Test coverage for math

### Audit questions

- [ ] `StrategyMath.calcTickRange` has unit tests covering: tick at zero, tick near `MIN_TICK` / `MAX_TICK`, every fee tier?
- [ ] Token-amount conversion (raw ↔ human) tested with values above `2^53`?
- [ ] USD computations tested with realistic gas prices (50 gwei × 500k gas) and ETH prices ($1k, $5k, $0.01)?
- [ ] Rounding behaviour pinned in tests — assertions on exact `BigDecimal` values, not "approximately"?
- [ ] Tests for negative paths: NaN strings, malformed amounts, decimal mismatches?

### How to inspect

```bash
# Test files in api
find apps/api/src/test -name '*.kt' 2>/dev/null
git grep -nE '@Test' apps/api/src/test 2>/dev/null

# Test files in chain
find apps/chain -name '*.test.ts' -o -name '*.spec.ts' 2>/dev/null
```

### Red flags

- No tests at all for `StrategyMath` — current state likely; flag and track.
- A test using `assertEquals(0.1 + 0.2, 0.3)` — would fail; if it passes, the assertion is `assertEquals(0.30000000000000004, 0.3)` and the rounding is wrong.
- Tests pinning expected USD values to one decimal of precision — drift in formula won't trigger them.

### Reference
[`testing.md`](testing.md).

---

## 8. Cross-service consistency

The api computes `gasCostUsd` from `gasCostWei` and `ethToUsdPrice`. The chain returns these raw. Inconsistent formulas between the two sides have been a recurring class of bug.

### Audit questions

- [ ] The api doesn't recompute values that the chain already computed, **and** the chain doesn't compute values that should live in the api (per [`BEST_PRACTICES.md §1.1`](../BEST_PRACTICES.md))?
- [ ] If a USD value appears in both api and chain logs / responses, the formula is identical (extracted to a shared helper or pinned in a test)?
- [ ] `swap_cost_usd`, `price_drift_usd`, `rebalancing_drag_usd` formulas live in **one** place each?

### How to inspect

```bash
# Money formulas
git grep -nE 'gasCostUsd|swapCostUsd|priceDriftUsd|rebalancingDragUsd' apps/api/src apps/chain/src
```

### Red flags

- `gasCostUsd = gasCostWei * ethPrice / 1e18` in chain code AND `gasCostUsd = gasCostWei.toBigDecimal().multiply(ethPrice).divide(...)` in api code — two sources of truth.
- A new metric added in one side and not surfaced in the other.

### Reference
[`BEST_PRACTICES.md §1.1`](../BEST_PRACTICES.md), [`docs/financial-transparency.md`](../financial-transparency.md).

---

## How to run this review

1. **Open a fresh Claude Code session.**
2. Walk top-to-bottom through sections 1 → 8. Run inspection commands. Paste output as evidence.
3. For each audit question, mark **yes / no / partial** with file:line citations.
4. Tag findings:
   - **[critical]** active money-leakage path: float used where `BigDecimal` should be, missing slippage bound on a `bigint` swap, `JSON.stringify` of a `bigint`.
   - **[high]** drift between api and chain formulas, missing tick-math centralisation, untested boundary cases.
   - **[medium]** type-tightening opportunities (e.g. `Long` cumulative gas wei eventually overflows).
   - **[low]** style: hardcoded decimals, unhelpful variable names like `x` for `BigDecimal`.
5. Spot-check by:
   - Walking one rebalance request from api `Routing.kt` → `ChainClient` → chain `rebalance.ts` → return path. Note every numeric type transition.
   - Picking five non-trivial DTO fields and verifying their type matches in: `Tables.kt`, `StrategyService.kt`, `ChainClient.kt`, `apps/web/src/types.ts`.
6. Recurring TODOs:
   - Centralised `calcTickRange` (§3) — verify still single source.
   - Long-term `gas_cost_wei` cumulative overflow (§1).
   - DTO field typing for USD aggregates: currently `Double` in `StrategyStatsDto` ([`StrategyService.kt:50-60`](../../apps/api/src/main/kotlin/fi/lagrange/services/StrategyService.kt)) but `BigDecimal` in DB — flag the precision boundary.

A typical pass takes **30-60 minutes** and produces fewer findings than the style playbooks but each is higher-stakes.
