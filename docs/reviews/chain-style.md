# Chain Service Style Review Playbook

> Audit playbook for `apps/chain` — TypeScript + Fastify + viem on Arbitrum. Targets the rules in [`BEST_PRACTICES.md §3 apps/chain`](../BEST_PRACTICES.md).

**Scope:** `apps/chain/src/**`. Wallet keys travel through this service per-request — review with the assumption that any input handling bug is a wallet-stealing bug.

**Sister playbooks:** [`security.md`](security.md) for the broader trust model, [`on-chain-safety.md`](on-chain-safety.md) for slippage / MEV / gas, [`numerical-correctness.md`](numerical-correctness.md) for `bigint` discipline, [`api-contracts.md`](api-contracts.md) for the OpenAPI spec.

**Reference:** [`BEST_PRACTICES.md §3`](../BEST_PRACTICES.md), [`§1.3 Idempotency`](../BEST_PRACTICES.md), [`§1.4 Error Handling`](../BEST_PRACTICES.md), [`§1.6 Decimal & Financial Math`](../BEST_PRACTICES.md).

---

## 1. Configuration

The chain service runs without persistent state — its only inputs are env vars and per-request bodies.

### Audit questions

- [ ] All required env vars are validated **at process startup** in `index.ts` (or `config.ts` evaluated at boot), not lazily on first use?
- [ ] `requireEnv()` helper used consistently for required values; optional env vars have a documented default?
- [ ] `WALLET_PRIVATE_KEY` env var is **optional and intended for legacy / local-dev** only — production runs with per-request `walletPrivateKey` per [`CLAUDE.md "Wallet key flow"`](../../CLAUDE.md)?
- [ ] No pre-initialised wallet client exported at module level — only `publicClient` and the `createWalletClientForKey` factory? **Open issue:** [`config.ts:45-47`](../../apps/chain/src/config.ts) exports a `walletClient` which is non-null only if `WALLET_PRIVATE_KEY` is set. Verify this is not imported anywhere except for legacy fallback paths.
- [ ] `createWalletClientForKey()` validates the key shape:
  - Private key: matches `/^0x[0-9a-fA-F]{64}$/` (current check is `startsWith('0x') && length === 66` — accepts `0x` followed by any 64 chars).
  - Mnemonic: passes `validateMnemonic()` from `viem/accounts`.
- [ ] Errors from `createWalletClientForKey()` are descriptive (not viem's cryptic internal messages)?

### How to inspect

```bash
# Module-level wallet client export
git grep -nE 'export const walletClient' apps/chain/src

# All consumers of the legacy export
git grep -n "from '\\.\\./config'" apps/chain/src | grep -v 'createWalletClientForKey\|publicClient\|config'
git grep -n "import.*walletClient" apps/chain/src

# Key validation logic
sed -n '/createWalletClientForKey/,/^}/p' apps/chain/src/config.ts

# requireEnv usage at startup
git grep -n 'requireEnv\|process\.env' apps/chain/src/config.ts apps/chain/src/index.ts
```

### Red flags

- A handler that imports `walletClient` (the singleton) and calls it directly — bypasses the per-request key path, will sign with the wrong account.
- Key validation that accepts any 66-char string starting with `0x` — non-hex chars produce a viem error 5 layers down the stack with no useful context.
- A `process.env.WALLET_PRIVATE_KEY` reference outside `config.ts` — config should be the only env-touching file.
- Lazy validation (`if (!process.env.RPC_URL) throw ...` inside a request handler) — pod boots, takes traffic, then 500s on first request.

### Reference
[`BEST_PRACTICES.md §3.1 Configuration`](../BEST_PRACTICES.md). [`config.ts`](../../apps/chain/src/config.ts).

---

## 2. Route handlers — input validation

Every route is a wallet-key-bearing endpoint. A missed validation here is exploitable.

### Audit questions

- [ ] All address parameters validated with `isAddress()` from viem before any cast to `\`0x${string}\``?
- [ ] All numeric query/body fields validated with `Number.isFinite` / `Number.isInteger` and range checks before use?
- [ ] Fee tier validated against `[100, 500, 3000, 10000]` (Uniswap v3 valid tiers)?
- [ ] Token IDs (Uniswap NFT positions) validated as positive integers (or `bigint` if > 2^53)?
- [ ] No `as \`0x${string}\`` casts on user input without a prior `isAddress()` / `isHex()` check?
- [ ] If `zod` is in `package.json` ([`apps/chain/package.json:20`](../../apps/chain/package.json) — yes, `^3.23.8`), it is **used** to parse request bodies, not unused boilerplate?
- [ ] Or alternatively: Fastify JSON schemas (`schema: { body: { ... } }`) defined per route?

### How to inspect

```bash
# Casts onto 0x... type — must be preceded by validation
git grep -nB3 'as `0x\${string}`' apps/chain/src

# isAddress / isHex usage near route handlers
git grep -nE 'isAddress|isHex' apps/chain/src

# zod usage
git grep -nE "from ['\"]zod['\"]|z\\.\\w+\\(" apps/chain/src

# Fastify schema fields on routes
git grep -nB2 -A4 'schema:\s*\{' apps/chain/src
```

### Red flags

- A handler that does `const t = req.query.token as \`0x${string}\`; await fetchPool(t)` without `isAddress(t)` — a malformed input crashes 4 layers in.
- `zod` listed in `package.json` but never imported — either remove the dep or use it.
- Numeric fields parsed with `parseInt(req.body.x)` and used without `Number.isInteger` — `parseInt("abc") === NaN` flows downstream.
- Body type declarations like `Body: { ... }` that aren't enforced by Fastify schemas — TypeScript types compile-time, schemas runtime; you need both.

### Reference
[`BEST_PRACTICES.md §3.2 Route Handlers`](../BEST_PRACTICES.md). [`apps/chain/src/routes/`](../../apps/chain/src/routes/).

---

## 3. Idempotency

The api forwards a UUID v4 in `idempotencyKey` for every state-changing request. Chain must reject duplicates **before** signing anything.

### Audit questions

- [ ] Every `POST` endpoint that mutates on-chain state checks `idempotencyKey` as the **first** operation?
- [ ] Duplicate detected → HTTP 409 with `{ error, idempotencyKey }`, no transaction submitted?
- [ ] On error path, the idempotency key is **removed from the store only when retry is appropriate** (RPC timeout, nonce reuse) — but **kept** for permanent failures (insufficient balance, invalid tokenId)?
- [ ] Currently in-memory `processedKeys` Set ([`apps/chain/src/routes/execute.ts:7`](../../apps/chain/src/routes/execute.ts)) — flagged as known gap (post-MVP: Postgres-backed store, `BEST_PRACTICES.md §1.3` and `CLAUDE.md "Known risks"`).
- [ ] Operators understand the implication: a chain-service pod restart reopens the idempotency window — the api must re-issue with the same key only if it knows the previous attempt did not succeed?

### How to inspect

```bash
sed -n '1,$p' apps/chain/src/routes/execute.ts

# Any write endpoint that does NOT check processedKeys
git grep -nB2 -A8 "server\.post" apps/chain/src/routes | grep -E 'processedKeys|idempotency' || echo "no matches → endpoints may be missing the check"

# Removal logic — should only happen on retryable errors
git grep -nB3 -A1 'processedKeys\.delete' apps/chain/src
```

### Red flags

- A new `POST` route in `routes/` without an idempotency check (e.g. someone added `/execute/swap` without copying the pattern).
- `processedKeys.delete()` inside the success path — defeats deduplication for legitimate retries.
- The idempotency check happens **after** `await rebalance(...)` — too late, the tx may already be on-chain.
- The set is not sharded by environment (test vs prod use the same key namespace if they ever share a process — they don't, but flag if you see commingled deployment).

### Reference
[`BEST_PRACTICES.md §1.3 Idempotency`](../BEST_PRACTICES.md), [`§3.7 Idempotency (Chain Service)`](../BEST_PRACTICES.md). [`execute.ts`](../../apps/chain/src/routes/execute.ts).

---

## 4. On-chain operations

### Audit questions

- [ ] Every `writeContract` call followed by `publicClient.waitForTransactionReceipt({ hash })` before claiming success?
- [ ] Tx hash logged **immediately after submission** (before waiting for receipt) so a process crash mid-wait can be reconciled manually?
- [ ] Return values parsed from **event logs** in the receipt (`IncreaseLiquidity`, `Transfer`, `Collect`), not from `writeContract` return value (which Solidity does not expose reliably)?
- [ ] `maxFeePerGas` and `maxPriorityFeePerGas` set explicitly or transparently provided by viem's transport?
- [ ] Per-request wallet client (from `createWalletClientForKey(req.body.walletPrivateKey)`), never the module-level singleton?
- [ ] Replacement-tx-underpriced retried at least once with bumped tip (CONSIDER in `BEST_PRACTICES.md §3.3`)?

### How to inspect

```bash
# Every writeContract should be followed by waitForTransactionReceipt
git grep -nA5 'writeContract\(' apps/chain/src/services | head -60

# Tx hash logged before receipt wait
git grep -nB1 -A4 'waitForTransactionReceipt' apps/chain/src/services

# Module-level walletClient usage in services (should be ZERO)
git grep -n 'walletClient' apps/chain/src/services

# Return-value parsing
git grep -nE 'parseEventLogs|decodeEventLog|getEventArgs' apps/chain/src/services
```

### Red flags

- A `const hash = await walletClient.writeContract(...)` followed immediately by `return { hash }` — no receipt wait, "success" reported for an unmined tx that may revert.
- Reading `result` from `writeContract` and using it as if it were the function return — silently `undefined` for state-changing functions.
- `walletClient` (module export) used inside any service — wrong account.
- Hardcoded `maxFeePerGas: 0n` left from local Anvil testing.

### Reference
[`BEST_PRACTICES.md §3.3 On-Chain Operations`](../BEST_PRACTICES.md). [`services/rebalance.ts`](../../apps/chain/src/services/rebalance.ts), [`services/mint.ts`](../../apps/chain/src/services/mint.ts), [`services/close.ts`](../../apps/chain/src/services/close.ts).

---

## 5. BigInt discipline (cross-link to numerical-correctness.md)

### Audit questions

- [ ] All raw ERC-20 amounts, ticks, `sqrtPriceX96`, liquidity values typed as `bigint`?
- [ ] Conversions to `number` only at the explicit display / float-math boundary (e.g. swap ratio estimation in `swap.ts`)?
- [ ] No `Number(someBigInt)` on values exceeding `2^53` (token amounts, liquidity)?
- [ ] `formatUnits()` and `parseUnits()` from viem used for human ↔ raw conversion, not custom math?
- [ ] Helper named explicitly when float is unavoidable (e.g. `toHumanFloat`) so the precision loss is documented?

### How to inspect

```bash
# Number(bigint) anti-pattern
git grep -nE 'Number\([a-zA-Z_]+\)' apps/chain/src

# Math on bigints with implicit conversion
git grep -nE 'Math\.(round|floor|ceil)' apps/chain/src

# formatUnits usage
git grep -n 'formatUnits\|parseUnits' apps/chain/src
```

### Red flags

- `Number(amount0Desired)` where `amount0Desired: bigint` is a token amount — silent rounding above 9 quadrillion wei.
- A division `liquidity / sqrtPrice` (without `BigInt`) — TypeScript compiles since both could be `number`-typed, then runs wrong.
- Manual `toFixed(18)` formatting for token decimals — use `formatUnits`.

### Reference
[`BEST_PRACTICES.md §3.4 BigInt and Decimal Handling`](../BEST_PRACTICES.md), [`§1.6`](../BEST_PRACTICES.md), [`numerical-correctness.md`](numerical-correctness.md).

---

## 6. Error handling

### Audit questions

- [ ] Service functions (`rebalance.ts`, `close.ts`, `mint.ts`) catch all known failure modes and return `{ success: false, error }`, never let an unhandled rejection escape?
- [ ] The recovery attempt inside `rebalance.ts`'s catch block is itself wrapped so a recovery failure doesn't crash the route handler (per [`BEST_PRACTICES.md §3.5`](../BEST_PRACTICES.md))?
- [ ] Idempotency key removed from the in-memory set only on retryable errors (RPC timeout, nonce collision) — not on permanent failures?
- [ ] No `console.log` / `console.error` for actual operational logging — Fastify's logger (`request.log`, `server.log`) used so logs are JSON and correlated to a request id?
- [ ] Errors that bubble to Fastify's default 500 handler include enough context for the api side to produce a useful Telegram alert?

### How to inspect

```bash
# console.log usage (only acceptable in index.ts boot banner)
git grep -nE '\bconsole\.(log|error|warn|info)\b' apps/chain/src

# request.log / server.log usage
git grep -nE 'request\.log|server\.log|reply\.log' apps/chain/src

# Catch blocks that throw / rethrow
git grep -nB1 -A4 'catch (' apps/chain/src/services
```

### Red flags

- `catch (err) { console.error(err) }` — log goes to stdout but isn't request-correlated.
- A service that throws on a known business case (insufficient balance) instead of returning `{ success: false, error: ... }`.
- The idempotency-delete in [`execute.ts:26`](../../apps/chain/src/routes/execute.ts) runs for **every** error including permanent ones — flag if a permanent error replays into a duplicate on-chain attempt.

### Reference
[`BEST_PRACTICES.md §3.5 Error Handling`](../BEST_PRACTICES.md). [`services/`](../../apps/chain/src/services/), [`routes/execute.ts`](../../apps/chain/src/routes/execute.ts).

---

## 7. OpenAPI contract

### Audit questions

- [ ] `apps/chain/openapi.yaml` exists and is the **source of truth** for the api↔chain contract?
- [ ] Every Fastify route is represented in the spec, with request/response schemas and error shapes?
- [ ] CI lints the spec (`@redocly/cli` or `openapi-validator`)?
- [ ] No endpoint added in code without a matching diff to `openapi.yaml` in the same PR?
- [ ] `@fastify/swagger` ([`apps/chain/package.json:18`](../../apps/chain/package.json)) wires the spec into a `/docs` UI in dev?

### How to inspect

```bash
ls apps/chain/openapi.yaml 2>/dev/null && echo "exists" || echo "MISSING"

# Routes vs spec
git grep -nE "server\.(get|post|put|delete|patch)" apps/chain/src/routes | wc -l
grep -cE '^\s+(get|post|put|delete|patch):' apps/chain/openapi.yaml 2>/dev/null

# CI step that lints the spec
git grep -n openapi .github/workflows/
```

### Red flags

- `openapi.yaml` missing entirely — flagged in [`BEST_PRACTICES.md §3.6`](../BEST_PRACTICES.md) as MUST.
- A route whose request body type lives only as a TypeScript type — clients can't consume it.
- Spec updated only after the api side broke in test.

### Reference
[`BEST_PRACTICES.md §3.6 OpenAPI Contract`](../BEST_PRACTICES.md), [`api-contracts.md`](api-contracts.md).

---

## 8. Service file size and structure

### Audit questions

- [ ] No service file over ~500 lines? Currently [`services/rebalance.ts`](../../apps/chain/src/services/rebalance.ts) is ~561 lines — borderline. Track until it splits naturally.
- [ ] One responsibility per file (`rebalance.ts` orchestrates, `swap.ts` only swaps, `uniswap.ts` only ABI calls)?
- [ ] Helpers like `recoverCollect` not duplicated between `rebalance.ts` and `close.ts`?
- [ ] No business logic that decides "should we rebalance" — that lives in the api ([`BEST_PRACTICES.md §1.1`](../BEST_PRACTICES.md))?

### How to inspect

```bash
wc -l apps/chain/src/services/*.ts | sort -nr

# Shouldn't see scheduling / decision logic
git grep -nE 'shouldRebalance|isOutOfRange|decideAction' apps/chain/src

# Cross-service helper duplication
git grep -nE 'function recoverCollect|function trackTx' apps/chain/src
```

### Red flags

- A service file > 1000 lines.
- A `decideRebalance(...)` function in chain — strategy logic must be in api.
- Two definitions of `trackTx` / `recoverCollect` drifting apart.

### Reference
[`BEST_PRACTICES.md §1.1`](../BEST_PRACTICES.md), [`§3.3`](../BEST_PRACTICES.md).

---

## 9. Logging

### Audit questions

- [ ] All log statements use Fastify's logger (`request.log.info(...)`) — `console.log` only at boot for the listening message?
- [ ] Logs are JSON / structured — Fastify defaults to JSON when `logger: true`?
- [ ] No request body logged wholesale — `walletPrivateKey` would leak. Selective fields only.
- [ ] The `requestId` from api (currently not forwarded — open TODO in `BEST_PRACTICES.md §1.5`) appears as `correlationId` once api fixes its side?
- [ ] Tx hashes logged at INFO; receipts at DEBUG; full args at TRACE only?

### How to inspect

```bash
git grep -nE '\bconsole\.(log|error|warn|info)\b' apps/chain/src
git grep -nE 'request\.log\.|reply\.log\.|server\.log\.' apps/chain/src
git grep -n 'walletPrivateKey' apps/chain/src
```

### Red flags

- `console.log(req.body)` — leaks wallet phrase.
- A service that builds a log line by string concatenation — defeats JSON logging.
- A per-request log line over 4 KB — likely a serialised receipt; should be an event reference instead.

### Reference
[`BEST_PRACTICES.md §1.5 Observability`](../BEST_PRACTICES.md), [`security.md §9`](security.md).

---

## 10. Build hygiene and dependencies

### Audit questions

- [ ] `npm run build` and `npm run lint` succeed on a clean checkout?
- [ ] `npm test` (vitest) runs at least one test that exercises a service path?
- [ ] `viem` pinned to an exact version, not a caret range (`^2.21.0` currently — flag for downgrade-aware caution)?
- [ ] `@lagrangefi/shared` referenced as `*` so workspace resolution always uses local source ([`apps/chain/package.json:15`](../../apps/chain/package.json))?
- [ ] No dev dependency leaked into runtime imports?
- [ ] Dockerfile multi-stage and `--omit=dev` for the runner stage ([`apps/chain/Dockerfile`](../../apps/chain/Dockerfile))?

### How to inspect

```bash
( cd apps/chain && npm run lint && npm run build )
git grep -nE '"viem":' apps/chain/package.json
sed -n '1,$p' apps/chain/Dockerfile

# Dev imports leaking into src
git grep -nE "from 'vitest'|from 'tsx'" apps/chain/src
```

### Red flags

- `viem: "^2.x"` plus a refactor that depends on a 2.21.0+ behaviour — a `npm install` on CI may upgrade beneath you.
- `from 'vitest'` in non-test source — vitest pulled into runtime image.
- A Dockerfile that copies `node_modules/` from builder — defeats the multi-stage prune.

### Reference
[`apps/chain/package.json`](../../apps/chain/package.json), [`apps/chain/Dockerfile`](../../apps/chain/Dockerfile).

---

## How to run this review

1. **Open a fresh Claude Code session** (do not reuse one that recently edited chain code).
2. From repo root, walk top-to-bottom through sections 1 → 10. Run every command. Paste output as evidence.
3. Mark **yes / no / partial** with file:line citations.
4. Tag findings:
   - **[critical]** wallet-key handling bug, missed idempotency, unawaited tx receipt → potential lost funds.
   - **[high]** input validation gap, missing OpenAPI sync, key-validation accepting malformed input.
   - **[medium]** unused dep, log discipline, file-size growth.
   - **[low]** style, comment drift.
5. Recurring TODOs to track each pass:
   - In-memory `processedKeys` (§1.3, §3.7) — until replaced by DB-backed store.
   - Module-level `walletClient` export (`config.ts:45-47`) — verify nothing in services depends on it.
   - Key validation strictness (§3.1) — current regex check is permissive.
   - OpenAPI sync (§3.6).
   - File-size growth on `rebalance.ts`.

A typical pass takes **45-75 minutes**, dominated by tracing one rebalance request through `routes/execute.ts → services/rebalance.ts`.
