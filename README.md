# lagrangefi

Automated Uniswap v3 LP rebalancer on Arbitrum. Named after [Lagrange points](https://en.wikipedia.org/wiki/Lagrange_point) — stable equilibrium positions that balance opposing forces, just like this system balances your liquidity positions.

## What it does

- Monitors a Uniswap v3 ETH/USDC position on Arbitrum
- Detects when the current price moves outside the LP range
- Automatically rebalances: removes liquidity → swaps to correct ratio → re-adds at new range centered on current price
- Sends Telegram alerts for rebalances, errors, and health events
- Web dashboard to monitor positions, configure strategy, and view history

## Roadmap

| Version | Feature |
|---------|---------|
| **v1** | Uniswap v3 ETH/USDC rebalancer on Arbitrum |
| **v2** | AAVE delta-neutral strategy — borrow ETH to hedge LP delta |
| **v3** | ByBit grid bots (unconfirmed) |

## Architecture

```
lagrangefi/
├── apps/
│   ├── web/       # React + Vite + shadcn/ui — dashboard
│   ├── api/       # Kotlin + Ktor — orchestration, strategy, REST API, Telegram bot
│   └── chain/     # TypeScript + viem — on-chain execution (Uniswap v3, future: AAVE)
├── packages/
│   └── shared/    # Shared TypeScript types between web/ and chain/
└── k8s/
    ├── base/      # Base Kubernetes manifests
    └── overlays/
        ├── prod/  # namespace: prod
        └── test/  # namespace: test (real Arbitrum, separate wallet)
```

### How services communicate

```
┌──────────────┐         ┌───────────────┐
│   api/       │──REST──▶│   chain/      │
│  (Kotlin)    │◀────────│  (TypeScript) │
└──────┬───────┘         └───────────────┘
       │
  PostgreSQL
       │
  Telegram Bot
```

- `api/` owns all business logic: strategy decisions, scheduling, position tracking, statistics
- `chain/` is a thin execution layer: receives action requests from `api/`, executes on-chain, returns results
- Only `api/` can call `chain/` (enforced via Kubernetes `NetworkPolicy`)
- Hot wallet private key lives only in `chain/` as a k8s Secret

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 18 + Vite + shadcn/ui + Recharts |
| API | Kotlin + Ktor |
| Chain service | TypeScript + viem |
| Database | PostgreSQL (k8s StatefulSet) |
| Alerts | Telegram Bot |
| Infra | Kubernetes + Kustomize |

## Getting started

> Full setup guide coming with v1 implementation.

### Prerequisites

- A Kubernetes cluster
- An Arbitrum RPC endpoint (Alchemy, Infura, etc.)
- A hot wallet funded with ETH (for gas) and the tokens you want to LP
- A Telegram bot token

### Deploy

```bash
# prod
kubectl apply -k k8s/overlays/prod

# test
kubectl apply -k k8s/overlays/test
```

## Strategy — v1

When the Uniswap v3 position goes out of range:

1. Remove 100% of liquidity from the current position
2. Swap tokens to the correct ratio for the new range
3. Add liquidity at a new range: `currentPrice ± X%` (configurable per pool)
4. Record the rebalance event and notify via Telegram

The range width `X%` is configurable. Default TBD based on pool volatility.

## Known risks

See [CLAUDE.md](./CLAUDE.md#known-risks) for a full list of known risks and post-MVP work.
