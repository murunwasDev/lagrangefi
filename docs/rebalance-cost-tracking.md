# Rebalance Cost Tracking — Implementation Plan

Track two financial metrics per rebalance: **swap cost** (value lost to the pool fee and
slippage during the token swap) and **price drift P&L** (value gained or lost because the
ETH price moved between the rebalance trigger and the end of execution).

Together they complete a per-rebalance P&L decomposition:

```
Fees earned:       +$X   feesCollected (already tracked)
Gas cost:          −$X   gasCostWei    (already tracked)
Swap cost:         −$X   NEW — value lost to pool fee + slippage
Price drift P&L:   ±$X   NEW — principal × (P_end − P_decision)
────────────────────────
Net rebalance P&L: ±$X   sum of the four rows above
```

---

## Part 1 — Swap Cost

### What it measures

When we call `exactInputSingle` we send `amountIn` tokens and receive `amountOut` tokens.
At the pre-swap spot price we *should* have received `fairAmountOut`.
The difference is the swap cost: pool fee tier (0.05 % / 0.3 % / 1 %) plus any slippage and
price impact.

```
swap_cost = fairAmountOut − amountOut   (in tokenOut units)
```

### Problem with the naive plan

`executeSwap` currently returns only the tx hash. `amountOut` is never read.

### Solution

#### Layer 1 — `chain/src/services/swap.ts`

Change return type of `executeSwap`:

```
Before: Promise<`0x${string}`>
After:  Promise<{ txHash: `0x${string}`; amountOut: bigint }>
```

Parse the Uniswap v3 Pool's `Swap` event from the swap receipt. No extra RPC call — the
receipt is already awaited.

**Swap event:**
- Topic0: `keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)")`
  = `0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67`
- Data layout (non-indexed): `amount0 (int256, 32 bytes) | amount1 (int256, 32 bytes) | sqrtPriceX96 (uint160) | liquidity (uint128) | tick (int24)`
- `amount0` and `amount1` are signed integers.
  - `zeroForOne` swap: `amount0 > 0` (token0 flows into pool), `amount1 < 0` (token1 flows out)
  - `oneForZero` swap: `amount1 > 0`, `amount0 < 0`
- Therefore: `amountOut = zeroForOne ? -amount1 : -amount0`

Also extract `sqrtPriceX96AfterSwap` from the same event — it is the post-swap pool price
and is **reused for price drift tracking** (Part 2) with no additional RPC call.

```ts
const SWAP_EVENT_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

function parseSwapEvent(receipt, zeroForOne) {
  const log = receipt.logs.find(l =>
    l.topics[0]?.toLowerCase() === SWAP_EVENT_TOPIC
  )
  if (!log) return null

  const data = log.data.slice(2)
  const amount0 = BigInt.asIntN(256, BigInt('0x' + data.slice(0, 64)))
  const amount1 = BigInt.asIntN(256, BigInt('0x' + data.slice(64, 128)))
  const sqrtPriceX96After = BigInt('0x' + data.slice(128, 192))   // uint160, unsigned

  const amountOut = zeroForOne ? -amount1 : -amount0
  return { amountOut, sqrtPriceX96After }
}
```

Return from `executeSwap`:
```ts
return { txHash: swapTx, amountOut, sqrtPriceX96After }
```

#### Layer 2 — `chain/src/services/rebalance.ts`

Compute `fairAmountOut` using the pre-swap `sqrtPriceX96` already fetched in step 5
(before the swap, after burn — correct snapshot of the market price we used for the swap
calculation):

```ts
const sqrtP = Number(sqrtPriceX96) / 2**96

// zeroForOne (token0 in → token1 out)
fairAmountOut = BigInt(Math.floor(Number(swap.amountIn) * sqrtP * sqrtP))

// oneForZero (token1 in → token0 out)
fairAmountOut = BigInt(Math.floor(Number(swap.amountIn) / (sqrtP * sqrtP)))
```

Swap cost:
```ts
const swapCostAmount = fairAmountOut > amountOut ? fairAmountOut - amountOut : 0n
```

Add to `RebalanceResult`:
```ts
swapCost?: {
  amountIn:       string   // raw bigint string — token sent
  amountOut:      string   // actual received
  fairAmountOut:  string   // at pre-swap spot price
  direction:      'zeroForOne' | 'oneForZero'
}
```

**When no swap occurs** (ratio already within 0.1%): `swapCost` is omitted (`undefined`).
`sqrtPriceX96AfterSwap` falls back to the pre-swap `sqrtPriceX96` (price did not move due
to our actions).

---

## Part 2 — Price Drift P&L

### What it measures

The ETH price can move between when the bot decides to rebalance (`P_decision`) and when
the swap settles (`P_end`). During that window we are holding a principal ETH amount. The
drift in price directly translates into a USD gain or loss.

```
price_drift_pnl = principal_token0_human × (P_end − P_decision)
price_drift_pct = (P_end − P_decision) / P_decision × 100
```

`principal_token0_human` = ETH-side of the collected position, **LP fees excluded**
(fees are already tracked separately and should not inflate the baseline).

### Problems with the naive plan — and why they matter

#### Problem A: `V_end − V_start` conflates four unrelated things

The naive plan proposed `execution_pnl = V_end − V_start`.

`positionToken0Start` = principal + LP fees collected.  
`positionToken0End` = what was deposited into the new LP position.

This conflates:
1. **Swap cost** — already tracked in Part 1; including it here double-counts it.
2. **LP fees** — income, not capital; including them in V_start inflates the baseline.
3. **Leftover tokens** — tokens that did not fit the mint range are excluded from
   `positionToken0End` but are still in the wallet (carried as `pending`). This creates
   a phantom loss equal to the leftover value.
4. **Price drift** — the one thing we actually want to measure.

A rebalance where ETH is flat would still show a large negative `execution_pnl` because of
the leftover effect. The number would be misleading and unactionable.

**Fix:** Do not compute `V_end − V_start`. Compute price drift directly on principal only.

#### Problem B: `V_start` double-counts LP fees

`positionToken0Start` includes fees collected during the `collect` step. These fees are
already tracked in `feesCollected.amount0/1`. Using them again in V_start makes the P&L
appear worse than reality.

**Fix:** `principal_token0 = positionToken0Start − feesCollectedToken0`

#### Problem C: `priceAtEnd` fetched after mint is unnecessary noise

Minting does not move the pool price — only swaps do. The correct `P_end` is the
post-swap price, which is already available from the Swap event `sqrtPriceX96After`
field captured in Part 1. **No extra RPC call needed.**

If no swap occurred, `P_end = P_decision` (no execution-side price movement from our
actions). The drift is solely from the market moving between the API fetching the pool
state and the mint landing.

#### Problem D: Two "start prices" with ambiguous semantics

The naive plan introduced two prices:
- `P_decision` from `poolState.price` (API side, before chain call)
- `priceAtSwap` from rebalance step 5 (chain side, just before swap)

Both are valid but serve different purposes. Using both without clear semantics creates
confusion and maintenance burden.

**Decision:** Use `P_decision` as the single anchor. It is the economically meaningful
moment — "when the bot decided to rebalance, price was X." It is already computed in
`UniswapStrategy.kt` from `poolState.price` and passed into `recordRebalanceEvent` as
`ethPriceUsd`. No new data needed on the API side.

#### Problem E: `total_execution_pnl_usd` is not meaningful to accumulate

Summing price drift USD across rebalances is misleading: each rebalance has a different
capital size and occurs at a different ETH price level. A $100 drift at $2 000 ETH is
10× more significant than $100 at $20 000 ETH.

**Fix:** Track `avg_price_drift_pct` in `strategy_stats` instead of (or in addition to)
a raw USD sum. The percentage is normalized and comparable across time and position sizes.

### Solution

#### Layer 1 — `chain/src/services/rebalance.ts`

After the swap step, compute human-readable `P_end` from `sqrtPriceX96After` returned by
`executeSwap` (Part 1). This reuses data already in hand — zero extra RPC calls.

```ts
const sqrtPAfter = Number(sqrtPriceX96After) / 2**96
const decimalAdjust = Math.pow(10, decimals0 - decimals1)
const priceAtEnd = (sqrtPAfter * sqrtPAfter * decimalAdjust).toFixed(8)
```

The pre-swap `sqrtPriceX96` from step 5, converted the same way, is `priceAtSwap`.
Neither is stored in the DB — they are passed to the API in `RebalanceResult` so the API
can compute the drift against its own `P_decision`.

Add to `RebalanceResult`:
```ts
priceAtSwap?: string   // human-readable token1/token0, pre-swap (e.g. "2041.57")
priceAtEnd?:  string   // human-readable token1/token0, post-swap (from Swap event)
```

When no swap occurred: both are omitted or set equal — no drift from execution.

#### Layer 2 — API `UniswapStrategy.kt` + `StrategyService.kt`

Pass `priceAtEnd` (from chain result) and `ethPriceUsd` (already in scope as `P_decision`)
to `recordRebalanceEvent`.

Compute in `StrategyService.recordRebalanceEvent`:

```kotlin
// principal only — subtract LP fees to avoid double-counting
val principal0 = (positionToken0Start.toBigIntegerOrNull() ?: BigInteger.ZERO) -
                 (fees0.toBigIntegerOrNull() ?: BigInteger.ZERO)
val principal0Human = principal0
    .coerceAtLeast(BigInteger.ZERO)          // guard against rounding edge
    .toBigDecimal()
    .divide(TEN.pow(dec0), dec0, HALF_UP)

val priceDriftUsd: BigDecimal
val priceDriftPct: BigDecimal

if (priceAtEnd != null) {
    val pEnd = BigDecimal(priceAtEnd)
    priceDriftPct = (pEnd - priceAtDecision)
        .divide(priceAtDecision, 4, HALF_UP)
        .multiply(BigDecimal("100"))
    priceDriftUsd = if (dec0 == 18)
        principal0Human.multiply(pEnd - priceAtDecision).setScale(2, HALF_UP)
    else
        principal0Human.multiply(BigDecimal.ONE.divide(pEnd, 8, HALF_UP)
            - BigDecimal.ONE.divide(priceAtDecision, 8, HALF_UP)).setScale(2, HALF_UP)
} else {
    priceDriftPct = BigDecimal.ZERO
    priceDriftUsd = BigDecimal.ZERO
}
```

Note: `dec0 == 18` identifies the ETH-side token. For ETH/USDC, token0 = USDC (dec0=6),
token1 = WETH (dec1=18). The `computeValueUsd` logic in `UniswapStrategy.kt:155–163`
already handles this — **extract it to a private function** and reuse rather than
duplicating.

---

## Database Changes

Single migration, two tables.

### `rebalance_details` — 7 new columns

```sql
-- Swap cost (nullable: NULL when no swap was needed)
ALTER TABLE rebalance_details
  ADD COLUMN swap_amount_in        VARCHAR(78),
  ADD COLUMN swap_amount_out       VARCHAR(78),
  ADD COLUMN swap_fair_amount_out  VARCHAR(78),
  ADD COLUMN swap_direction        VARCHAR(12),   -- 'zeroForOne' | 'oneForZero'

-- Price drift (nullable: NULL when chain returned no price data)
  ADD COLUMN price_at_decision     DECIMAL(18,8), -- P_decision (duplicated here for direct querying)
  ADD COLUMN price_at_end          DECIMAL(18,8), -- P_end from Swap event sqrtPriceX96
  ADD COLUMN price_drift_pct       DECIMAL(8,4),  -- (P_end - P_decision) / P_decision * 100
  ADD COLUMN price_drift_usd       DECIMAL(18,2); -- principal_eth × (P_end - P_decision)
```

`price_at_decision` duplicates `chain_transactions.eth_to_usd_price` but belongs here for
direct querying without a join.

### `strategy_stats` — 4 new columns

```sql
ALTER TABLE strategy_stats
  ADD COLUMN swap_cost_token0    VARCHAR(78) NOT NULL DEFAULT '0',
  ADD COLUMN swap_cost_token1    VARCHAR(78) NOT NULL DEFAULT '0',
  ADD COLUMN swap_cost_usd       DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN avg_price_drift_pct DECIMAL(8,4)  NOT NULL DEFAULT 0;
```

`swap_cost_token0` accumulates cost when direction is `oneForZero` (cost paid in token0).
`swap_cost_token1` accumulates when `zeroForOne`.

`avg_price_drift_pct` is a running average, updated each rebalance:
```
new_avg = ((old_avg × (total_rebalances − 1)) + price_drift_pct) / total_rebalances
```
This is intentionally NOT a sum — a sum of percentages has no meaning.

---

## Shared Types (`packages/shared/src/index.ts`)

```ts
export interface SwapCost {
  amountIn:      string   // raw bigint string
  amountOut:     string
  fairAmountOut: string
  direction:     'zeroForOne' | 'oneForZero'
}

// Add to RebalanceResult:
swapCost?:    SwapCost
priceAtSwap?: string
priceAtEnd?:  string

// Add to RebalanceEventDto:
swapCost?:       SwapCost | null
priceDriftPct?:  number | null
priceDriftUsd?:  number | null
priceAtDecision?: number | null
priceAtEnd?:     number | null

// Add to StrategyStats:
swapCostToken0:    string
swapCostToken1:    string
swapCostUsd:       number
avgPriceDriftPct:  number
```

---

## API — Kotlin (`ChainClient.kt`, `Tables.kt`, `StrategyService.kt`)

### `ChainClient.kt`

```kotlin
@Serializable
data class SwapCostResponse(
    val amountIn:      String,
    val amountOut:     String,
    val fairAmountOut: String,
    val direction:     String,   // "zeroForOne" | "oneForZero"
)

// Add to RebalanceResponse:
val swapCost:    SwapCostResponse? = null,
val priceAtSwap: String? = null,
val priceAtEnd:  String? = null,
```

### `Tables.kt`

Mirror the 7 + 4 columns above in `RebalanceDetails` and `StrategyStats` Exposed objects.

### `StrategyService.recordRebalanceEvent`

New parameters:
```kotlin
swapCost: SwapCostResponse?,
priceAtDecision: BigDecimal,    // already passed as ethPriceUsd — rename for clarity
priceAtEnd: BigDecimal?,        // from result.priceAtEnd, null if no swap
```

Persist all new `rebalance_details` columns.

Accumulate in `strategy_stats`:
- `swap_cost_token0` / `swap_cost_token1`: bigint string addition (same pattern as fees)
- `swap_cost_usd`: USD conversion using `ethPriceUsd` and the `dec0==18` heuristic,
  same as `feesCollectedUsd` — **extract shared helper**
- `avg_price_drift_pct`: running average formula above

### Extract shared helper

The USD-value computation appears three times already (snapshots, fees USD, and now swap
cost / price drift). Extract once:

```kotlin
private fun toUsd(
    token0Raw: String, token1Raw: String,
    ethPrice: BigDecimal, dec0: Int, dec1: Int
): BigDecimal {
    val t0 = token0Raw.toBigDecimalRaw(dec0)
    val t1 = token1Raw.toBigDecimalRaw(dec1)
    return if (dec0 == 18) t0.multiply(ethPrice).add(t1)
           else            t1.multiply(ethPrice).add(t0)
}
```

---

## API Endpoints — No New Routes

Existing endpoints carry the new fields:

| Endpoint | New fields |
|---|---|
| `GET /api/v1/strategies/:id/rebalances` | `swapCost`, `priceDriftPct`, `priceDriftUsd`, `priceAtDecision`, `priceAtEnd` on each event |
| `GET /api/v1/strategies/:id/stats` | `swapCostToken0`, `swapCostToken1`, `swapCostUsd`, `avgPriceDriftPct` |

---

## Web Dashboard

### Rebalance history table — new columns

| Column | Value | Notes |
|---|---|---|
| Swap Cost | `fairAmountOut − amountOut` in human units | Show token symbol; omit row if no swap |
| P Decision | `priceAtDecision` formatted as "$X,XXX" | |
| P End | `priceAtEnd` formatted as "$X,XXX" | |
| Price Drift | `priceDriftPct` as "±X.XX%" | Green if positive, red if negative |
| Drift P&L | `priceDriftUsd` as "±$X.XX" | Color-coded |

### Strategy stats panel — new rows

| Row | Value |
|---|---|
| Total Swap Cost | `swapCostUsd` in USD + token breakdown |
| Avg Price Drift | `avgPriceDriftPct` as "±X.XX% per rebalance" |

---

## Part 3 — Open Gas Tracking (already implemented)

Gas from the initial mint (`POST /api/v1/strategies/start`) is already accumulated into
`strategy_stats.gas_cost_wei` and `strategy_stats.gas_cost_usd` in `Routing.kt`.
No additional changes needed.

## Pre-existing gap fixed

`RebalanceDetailsDto` was missing `gasUsedWei` and `ethPriceUsd`, which the web dashboard
expected. Fixed in `StrategyService.getEventHistory()`:
- `gasUsedWei` = sum of `chain_transactions.gas_cost_wei` for the event
- `ethPriceUsd` = `priceAtDecision` from `rebalance_details` (falls back to first chain tx price for old records)

Also renamed `ChainTransactionDto.gasCostWei` → `gasUsedWei` to match the web `ChainTransaction` type.

---

## Implementation Order

The two features share the Swap event parsing in `executeSwap`. Implement them together to
avoid touching `swap.ts` twice.

1. `packages/shared` — add `SwapCost` type and new fields to `RebalanceResult`,
   `RebalanceEventDto`, `StrategyStats`
2. `chain/swap.ts` — parse Swap event, return `{ txHash, amountOut, sqrtPriceX96After }`
3. `chain/rebalance.ts` — compute `swapCost`, `priceAtSwap`, `priceAtEnd`; add to result
4. DB migration — single script, all 11 columns
5. `api/Tables.kt` — add Exposed columns
6. `api/ChainClient.kt` — add `SwapCostResponse`, new fields on `RebalanceResponse`
7. `api/StrategyService.kt` — extract `toUsd` helper, add parameters, persist and accumulate
8. `api/UniswapStrategy.kt` — pass new fields from result to `recordRebalanceEvent`
9. `web/` — add columns to history table, add rows to stats panel

---

## Invariants to Verify After Implementation

- `swapCost` is `null` when `calculateSwapAmount` returned `null` (no swap needed)
- `price_drift_pct` is 0.0 when `priceAtEnd` is null
- `swap_cost_token0` and `swap_cost_token1` are never both non-zero for the same rebalance
  (a single swap can only go in one direction)
- `avg_price_drift_pct` is recomputed correctly on each update — not summed
- `principal_token0 = positionToken0Start − feesCollectedToken0` is always ≥ 0
  (guard with `coerceAtLeast(0)` since rounding may produce a tiny negative)
