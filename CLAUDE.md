# CLAUDE.md — lagrangefi

This file guides Claude Code when working in this repository.

## Documentation

- **[docs/BEST_PRACTICES.md](docs/BEST_PRACTICES.md)** — Coding standards, architectural patterns, and rules for every module (`api/`, `chain/`, `web/`, `k8s/`, CI/CD). Includes a prioritised TODO list of known issues. Read this before making changes to any service.
- **[.claude/skills/db/schema.md](.claude/skills/db/schema.md)** — Database schema reference used by the `/db` skill. **Must be kept in sync with `apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt`.** Any time you add, remove, or rename a table or column in `Tables.kt`, update `schema.md` in the same commit.

## Project overview

lagrangefi is an automated Uniswap v3 LP rebalancer on Arbitrum. It monitors ETH/USDC positions and rebalances when price goes out of range. Built as a monorepo with three services: `api/` (Kotlin), `chain/` (TypeScript), `web/` (React).

## Monorepo structure

```
apps/web/     React + Vite + shadcn/ui (dashboard)
apps/api/     Kotlin + Ktor (orchestration, strategy, scheduling, Telegram alerts)
apps/chain/   TypeScript + viem (on-chain execution only)
packages/shared/  Shared TypeScript types
k8s/          Kubernetes manifests (Kustomize, overlays: prod / test)
```

## Architecture principles

### Service boundaries
- `api/` owns all business logic and strategy decisions. It tells `chain/` what to do, never the other way around.
- `chain/` is a dumb execution layer. It receives action requests, executes them on-chain, and returns results. No strategy logic lives here.
- `web/` talks only to `api/`. It never calls `chain/` directly.
- A Kubernetes `NetworkPolicy` enforces that only `api/` can reach `chain/`.

### Multi-user model
- Users register with username + password (BCrypt-hashed).
- Each user configures one wallet (BIP39 mnemonic or raw private key).
- Wallet phrases are encrypted at rest with AES-256-GCM (key in `WALLET_ENCRYPTION_KEY`).
- Each user may have at most one **active** strategy at a time.
- JWT (HS256, 24h) protects all `/api/v1/*` and `/me/*` routes.

### Wallet key flow
The API decrypts the user's wallet phrase and forwards it to the chain service **per-request** in the `walletPrivateKey` field of `RebalanceRequest`. The chain service never stores keys. It creates a temporary wallet client for the duration of that request. `WALLET_PRIVATE_KEY` env var on the chain service is no longer required (only the API holds wallet data).

### Strategy pattern (extensibility)
`api/` uses a `ProtocolStrategy` interface for rebalance logic. v1 implements `UniswapStrategy`. When adding AAVE (v2), add `DeltaNeutralStrategy` — do not modify existing strategy code.

`StrategyScheduler` manages per-strategy timers (one per active strategy). It loads all active strategies from DB on startup and starts their timers. When a strategy is created/paused/resumed/stopped via the API, the scheduler is updated immediately.

### Chain service interface
Keep `chain/` endpoints protocol-agnostic (e.g. `POST /execute` with a steps array), not Uniswap-specific. This allows adding AAVE and multi-step atomic transactions (flash loans) in v2 without breaking v1.

### ExecutorRegistry
`api/` maintains an `ExecutorRegistry` that maps strategy types to executors. v3 (ByBit grid bots) registers a new executor without changing existing code.

### Idempotency
Every rebalance request from `api/` to `chain/` must include an idempotency key. `chain/` must reject duplicate requests with the same key. This prevents double-execution if `api/` retries a timed-out request.

### OpenAPI contract
The REST contract between `api/` and `chain/` is defined as an OpenAPI spec at `apps/chain/openapi.yaml`. This is the source of truth — do not add endpoints without updating the spec first.

## API endpoints

### Public
```
POST /auth/register   { username, password }  → { token, userId, username }
POST /auth/login      { username, password }  → { token, userId, username }
```

### Protected (Bearer JWT required)
```
GET  /me                     current user info + hasWallet flag
GET  /me/wallet              { hasWallet }
PUT  /me/wallet              { phrase }  — save/replace encrypted wallet

GET  /api/v1/strategies                 list all user's strategies
POST /api/v1/strategies                 create new strategy
GET  /api/v1/strategies/:id             get single strategy
PATCH /api/v1/strategies/:id/pause      pause active strategy
PATCH /api/v1/strategies/:id/resume     resume paused strategy
DELETE /api/v1/strategies/:id           stop strategy permanently

GET  /api/v1/strategies/:id/stats       StrategyStats (fees, gas, time-in-range, APY hints)
GET  /api/v1/strategies/:id/rebalances  rebalance history with fees + gas per event

GET  /api/v1/position         current position for active strategy
GET  /api/v1/pool-state       current pool price/tick for active strategy
GET  /api/v1/rebalances       recent rebalances (latest strategy)
```

## Database schema

```
users             id, username, password_hash, created_at
wallets           id, user_id(FK), encrypted_phrase, created_at, updated_at
strategies        id, user_id(FK), name, current_token_id, token0, token1, fee,
                  range_percent, slippage_tolerance, poll_interval_seconds,
                  status (active|paused|stopped), created_at, stopped_at
strategy_stats    strategy_id(PK/FK), total_rebalances,
                  fees_collected_token0, fees_collected_token1 (raw decimal strings),
                  gas_cost_wei, total_poll_ticks, in_range_ticks, time_in_range_pct,
                  updated_at
rebalance_events  id, strategy_id(FK), token_id, idempotency_key, status,
                  new_tick_lower, new_tick_upper, new_token_id, tx_hashes (JSON),
                  fees_collected_token0, fees_collected_token1, gas_cost_wei,
                  error_message, triggered_at, completed_at
```

## CI/CD pipelines

Two GitHub Actions workflows:

1. **Build and Push Images** (`ci.yml`) — builds Docker images for changed services and pushes to GHCR.
   - On `push` to `main`: only rebuilds services with changed files (path filtering via `dorny/paths-filter`).
   - On `workflow_dispatch` (manual): always builds all three services (`api`, `chain`, `web`). Use this for feature branches.
   - `packages/shared/**` changes trigger a `chain` rebuild (shared types used by chain).

2. **Deploy to Test** (`deploy-test.yml`) — `workflow_dispatch` only. Patches the image tag in `k8s/overlays/test/kustomization.yaml` to the current commit SHA, generates manifests with `kubectl kustomize`, copies them to the cluster via SCP, and applies with `kubectl apply`.

**To deploy a feature branch to test:**
1. Run **Build and Push Images** on the branch — wait for it to succeed.
2. Run **Deploy to Test** on the same branch.

Test environment is at http://187.124.224.48/. There is no automatic deploy on PR push — both steps must be triggered manually for feature branches.

## Kubernetes

- Two namespaces: `prod` and `test`
- Managed with Kustomize: `k8s/base/` + `k8s/overlays/{prod,test}/`
- `test` namespace uses real Arbitrum mainnet with a separate wallet holding small amounts
- CronJob for the worker **must** have `concurrencyPolicy: Forbid` to prevent overlapping rebalance runs
- Private keys and DB credentials are k8s Secrets, never ConfigMaps
- RPC URLs go in ConfigMaps

### Secrets required

| Secret | Namespace | Keys |
|--------|-----------|------|
| `postgres-secret` | prod, test | `user`, `password` |
| `api-secret` | prod, test | `DATABASE_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `JWT_SECRET`, `WALLET_ENCRYPTION_KEY` |

`chain-secret` has been **removed** — the chain service no longer holds wallet keys. Wallets are per-user, encrypted in the database, and forwarded by the api on each request.

Generate secrets:
```bash
# WALLET_ENCRYPTION_KEY (32-byte AES key, base64)
openssl rand -base64 32

# JWT_SECRET
openssl rand -hex 32
```

## Alerting

Telegram bot is part of `api/` (not a separate service). Alert on:
- Rebalance executed (success) — per strategy name
- Rebalance failed (with reason) — per strategy name
- Strategy execution error (unhandled exception)
- Bot crash / pod restart
- (v2) AAVE health factor below warning threshold
- (v2) Emergency close triggered

## Roadmap

| Version | Scope |
|---------|-------|
| v1 | Multi-user auth, per-user encrypted wallet, Uniswap v3 ETH/USDC rebalancer, strategy analytics (fees, gas, time-in-range), web dashboard |
| v2 | AAVE delta-neutral strategy: borrow ETH to hedge LP delta, `calc/` service for delta math and hedge coefficients, health factor monitoring, emergency close |
| v3 | ByBit grid bots via `exchange/` service (unconfirmed) |

When working on v1, do not implement v2/v3 features. Design interfaces to accommodate them (see Strategy pattern above), but do not build them.

## Known risks (post-MVP)

These are known issues that are intentionally deferred. Do not raise them as bugs.

### Critical (money at risk)
- **AAVE liquidation (v2)**: If ETH pumps faster than the bot rebalances, AAVE will liquidate the position. Mitigation: health factor threshold alerts + emergency close. Design for this in v2 from day one.
- **Rebalance profitability**: Each rebalance costs gas. Frequent rebalancing on a small position may cost more in gas than it saves in fees. A profitability check (expected yield gain vs gas cost) is post-MVP.
- **Slippage / sandwich attacks**: The swap step during rebalance is vulnerable to MEV. Slippage tolerance is not configured in v1. Post-MVP: add per-pool slippage config and consider using a private mempool (Flashbots Protect on Arbitrum).

### Architecture
- **Single RPC endpoint**: No fallback if the primary RPC goes down. Post-MVP: add a secondary RPC provider with automatic failover.
- **Price oracle**: v1 uses Uniswap pool price to determine in/out of range. Pool price can be manipulated short-term. Post-MVP (especially v2 delta calculations): add Chainlink oracle as a sanity check.
- **Database schema**: v1 schema covers Uniswap positions only. Before starting v2, sketch the AAVE positions schema to avoid a painful migration.
- **Fork testing**: v1 uses real Arbitrum testnet. Proper integration tests should use an Arbitrum mainnet fork (Hardhat/Foundry) for realistic liquidity. Post-MVP.
- **In-memory idempotency in chain**: The `processedKeys` set in `chain/` is lost on pod restart. Post-MVP: move to DB-backed idempotency store.

### Operational
- **No spending limits**: The hot wallet has no per-transaction or daily spending cap. Post-MVP: add a circuit breaker.
- **ByBit (v3) CEX risk**: CEX accounts can be frozen, API keys revoked, rate limits hit. Fundamentally different risk profile from on-chain execution. Design the executor abstraction to handle failures gracefully.
- **Balance-based P&L tracking**: `strategy_stats` tracks fees collected and gas spent accurately. Full position value (start/end balance in USD) is not yet tracked — this requires computing liquidity amounts from the on-chain position, which is post-MVP.
