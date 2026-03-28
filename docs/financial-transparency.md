# Financial Transparency — Feature Documentation

This document covers the new fields, calculations, and UI components added to improve financial transparency for LP strategy tracking.

---

## New API Fields

### Strategy

| Field | Type | Description |
|---|---|---|
| `openEthPriceUsd` | `double?` | ETH/USD price at the time the strategy was opened (initial mint). Used to compute the deposit value in historical USD rather than current price. |
| `openTxHashes` | `text?` (JSON array) | Transaction hashes from the initial mint operation, serialized as a JSON array string. |

### StrategyStats

| Field | Type | Description |
|---|---|---|
| `closeToken0Amount` | `varchar(78)?` | Raw token0 amount collected when the strategy was closed (principal + fees, in token0 raw units). For WETH/USDC this is the WETH wei amount. |
| `closeToken1Amount` | `varchar(78)?` | Raw token1 amount collected at close (principal + fees, in token1 raw units). For WETH/USDC this is USDC in microUSDC. |
| `closeValueUsd` | `double?` | Total USD value of `closeToken0Amount + closeToken1Amount`, computed at `closeEthPriceUsd` at the time of close. |
| `closeTxHashes` | `text?` (JSON array) | Transaction hashes from the close operation (remove liquidity, collect, burn NFT, unwrap WETH), serialized as a JSON array string. |

### RebalanceEvent

| Field | Type | Description |
|---|---|---|
| `txSteps` | `text?` (JSON array) | Human-readable labels for each entry in `txHashes`, in 1:1 order. Possible values: `"Remove Liquidity"`, `"Collect Fees"`, `"Swap"`, `"Approve WETH"`, `"Approve USDC"`, `"Mint Position"`. Serialized as a JSON array string. |

### Position (chain service)

| Field | Type | Description |
|---|---|---|
| `amount0` | `string?` | Actual token0 amount currently held in the LP position (raw units). Computed from the position's liquidity using Uniswap v3 math (see below). Not to be confused with `tokensOwed0` which is uncollected fees. |
| `amount1` | `string?` | Actual token1 amount currently held in the LP position (raw units). |

---

## How Each Field Is Computed

### `openEthPriceUsd`
Captured in `POST /strategies/start` from the pool's current price at the moment of minting:
```kotlin
val ethPrice = poolState.price.toDoubleOrNull() ?: 0.0
strategyService.create(..., openEthPriceUsd = ethPrice)
```

### `openTxHashes`
The chain service returns `txHashes: List<String>` from the mint operation. This is JSON-encoded and stored:
```kotlin
openTxHashes = Json.encodeToString(mintResult.txHashes)
```

### `closeToken0Amount` / `closeToken1Amount`
The chain service parses the on-chain `Collect` event from the collect transaction receipt. The Collect event emits the total amounts transferred out of the position manager (principal from `decreaseLiquidity` + accrued fees):
```
keccak256("Collect(uint256,address,uint256,uint256)")
data layout: [recipient(32)] [amount0(32)] [amount1(32)]
```

### `closeValueUsd`
Computed in `DELETE /strategies/{id}` using the close ETH price:
```kotlin
val t0 = closeToken0Amount / 10^token0Decimals   // e.g. WETH float
val t1 = closeToken1Amount / 10^token1Decimals   // e.g. USDC float
closeValueUsd = t0 * closeEthPrice + t1          // for WETH/USDC pair
```

### `closeTxHashes`
Returned by the chain service close operation. Steps depend on position state:
1. `"Remove Liquidity"` — `decreaseLiquidity` (only if liquidity > 0)
2. `"Collect Tokens"` — `collect` (always)
3. `"Burn NFT"` — `burn` (always)
4. `"Unwrap WETH"` — `withdraw` on WETH contract (only if WETH balance > 0)

### `txSteps` on RebalanceEvent
Built alongside `txHashes` during the rebalance execution. Steps depend on position state:
1. `"Remove Liquidity"` — `decreaseLiquidity` (only if liquidity > 0)
2. `"Collect Fees"` — `collect` (only if tokens owed)
3. `"Swap"` — Uniswap swap (only if ratio rebalancing needed)
4. `"Approve WETH"` — ERC-20 approve token0 (always before mint)
5. `"Approve USDC"` — ERC-20 approve token1 (always before mint)
6. `"Mint Position"` — NonfungiblePositionManager.mint (always)

### `amount0` / `amount1` on Position
Computed from liquidity using Uniswap v3 constant-product math. Given `sqrtPriceX96` from the pool's `slot0`, `tickLower`, `tickUpper`, and the current tick:

```
sqrtP = sqrtPriceX96 / 2^96
sqrtA = 1.0001^(tickLower / 2)
sqrtB = 1.0001^(tickUpper / 2)
L     = liquidity (float)

if currentTick < tickLower:           # position is entirely token0
    amount0 = L * (1/sqrtA - 1/sqrtB)
    amount1 = 0

elif currentTick >= tickUpper:        # position is entirely token1
    amount0 = 0
    amount1 = L * (sqrtB - sqrtA)

else:                                 # mixed (in-range)
    amount0 = L * (1/sqrtP - 1/sqrtB)
    amount1 = L * (sqrtP - sqrtA)
```

Results are in raw token units (wei for WETH, microUSDC for USDC). Falls back to `positionToken0End` from the latest successful rebalance if the pool lookup fails.

---

## JSON String Convention

All `*TxHashes` and `txSteps` fields are stored as JSON-serialized arrays in the database (TEXT column) and returned by the API as plain JSON strings, not as JSON arrays. This matches the existing `txHashes` field on `RebalanceEvent`.

**On the web client**, parse them before use:
```typescript
const hashes = event.txHashes ? JSON.parse(event.txHashes) as string[] : []
const steps  = event.txSteps  ? JSON.parse(event.txSteps)  as string[] : null
```

---

## UI Calculations (`apps/web/src/finance.ts`)

### Impermanent Loss (IL)
```
holdValue    = token0AtOpen * currentEthPrice + token1AtOpen
currentValue = currentToken0 * currentEthPrice + currentToken1
IL           = currentValue - holdValue
```
Negative IL means the LP position is worth less than if tokens had been held. Only shown for active strategies with live position data.

### Total Return
```
// Active strategy:
totalReturn = (livePositionUsd + totalFeesCollectedUsd + unclaimedFeesUsd) - depositAtOpenPriceUsd

// Stopped strategy:
totalReturn = (closeValueUsd + closeFeesUsd) - depositAtOpenPriceUsd
```
`depositAtOpenPriceUsd` uses `openEthPriceUsd` for historical accuracy rather than current price.

### APY
```
APY = (totalReturn / depositAtOpenPriceUsd) / (daysRunning / 365) * 100
```

### Break-even
```
remaining = max(0, gasCostUsd - feesCollectedUsd)
dailyFeeRate = feesCollectedUsd / daysRunning
estimatedDaysToBreakEven = remaining / dailyFeeRate   (if dailyFeeRate > 0)
```

### Token Ratio Drift
```
value0 = token0Amount * ethPrice   (for WETH token0)
value1 = token1Amount              (for USDC token1)
pct0   = value0 / (value0 + value1) * 100
```
Shows how far the position has drifted from 50/50. A position fully out of range will be 100% one token.

### Per-Rebalance Profitability
```
feesUsd = feesCollectedToken0 * ethPrice + feesCollectedToken1
gasUsd  = gasCostWei / 1e18 * ethPriceAtRebalance
net     = feesUsd - gasUsd
```
Each rebalance event displays whether it was net-positive or net-negative.

---

## Schema Migration

No migration files needed. Tables use `SchemaUtils.createMissingTablesAndColumns()` on startup which auto-adds any missing columns as nullable. Existing rows get `NULL` for all new fields, which the UI handles gracefully with `??` fallbacks.
