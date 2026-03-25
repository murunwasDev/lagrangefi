# CLAUDE.md — lagrangefi

This file guides Claude Code when working in this repository.

## Project overview

lagrangefi is an automated Uniswap v3 LP rebalancer on Arbitrum. It monitors a single ETH/USDC position and rebalances when price goes out of range. Built as a monorepo with three services: `api/` (Kotlin), `chain/` (TypeScript), `web/` (React).

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

### Strategy pattern (extensibility)
`api/` uses a `ProtocolStrategy` interface for rebalance logic. v1 implements `UniswapStrategy`. When adding AAVE (v2), add `DeltaNeutralStrategy` — do not modify existing strategy code.

### Chain service interface
Keep `chain/` endpoints protocol-agnostic (e.g. `POST /execute` with a steps array), not Uniswap-specific. This allows adding AAVE and multi-step atomic transactions (flash loans) in v2 without breaking v1.

### ExecutorRegistry
`api/` maintains an `ExecutorRegistry` that maps strategy types to executors. v3 (ByBit grid bots) registers a new executor without changing existing code.

### Idempotency
Every rebalance request from `api/` to `chain/` must include an idempotency key. `chain/` must reject duplicate requests with the same key. This prevents double-execution if `api/` retries a timed-out request.

### OpenAPI contract
The REST contract between `api/` and `chain/` is defined as an OpenAPI spec at `apps/chain/openapi.yaml`. This is the source of truth — do not add endpoints without updating the spec first.

## CI/CD pipelines

Two GitHub Actions workflows, both manual (`workflow_dispatch`) for feature branches:

1. **Build and Push Images** — builds Docker images for changed services and pushes to GHCR.
   - On `push` to `main`: only rebuilds services with changed files (path filtering via `dorny/paths-filter`).
   - On `workflow_dispatch` (manual): always builds all three services (`api`, `chain`, `web`).
   - `packages/shared/**` changes trigger a `chain` rebuild (shared types used by chain).

2. **Deploy to Test** — patches the image tag in `k8s/overlays/test/kustomization.yaml` to the current commit SHA, generates manifests with `kubectl kustomize`, copies them to the cluster via SCP, and applies with `kubectl apply`.

**To deploy a feature branch to test:**
1. Run **Build and Push Images** on the branch — wait for it to succeed.
2. Run **Deploy to Test** on the same branch.

Test environment is at http://187.124.224.48/. There is no automatic deploy on PR push — both steps must be triggered manually.

## Kubernetes

- Two namespaces: `prod` and `test`
- Managed with Kustomize: `k8s/base/` + `k8s/overlays/{prod,test}/`
- `test` namespace uses real Arbitrum mainnet with a separate wallet holding small amounts
- CronJob for the worker **must** have `concurrencyPolicy: Forbid` to prevent overlapping rebalance runs
- Private keys and DB credentials are k8s Secrets, never ConfigMaps
- RPC URLs go in ConfigMaps

## Alerting

Telegram bot is part of `api/` (not a separate service). Alert on:
- Rebalance executed (success)
- Rebalance failed (with reason)
- Bot crash / pod restart
- (v2) AAVE health factor below warning threshold
- (v2) Emergency close triggered

## Roadmap

| Version | Scope |
|---------|-------|
| v1 | Uniswap v3 ETH/USDC rebalancer, Arbitrum, hot wallet, Telegram alerts, web dashboard |
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

### Operational
- **No spending limits**: The hot wallet has no per-transaction or daily spending cap. Post-MVP: add a circuit breaker.
- **ByBit (v3) CEX risk**: CEX accounts can be frozen, API keys revoked, rate limits hit. Fundamentally different risk profile from on-chain execution. Design the executor abstraction to handle failures gracefully.
