# Review Playbooks

This directory contains **review playbooks** — checklists used to audit the project on a recurring cadence (e.g. monthly, before major releases, after incidents). Each playbook covers one topic and is meant to be executed end-to-end in a single sitting.

These are **complementary** to [`docs/BEST_PRACTICES.md`](../BEST_PRACTICES.md):

- `BEST_PRACTICES.md` defines **what the rules are** (the norms the codebase should follow).
- The playbooks here define **how to verify** the codebase is following them — concrete questions, commands, file paths, and red flags to look for.

## How to run a review

> **IMPORTANT — run every review in a fresh Claude Code session.**
> Old conversation history biases the agent toward what it already produced and makes it less likely to spot regressions in its own work. Open a new session, point Claude at the playbook, and ask it to walk through each section step by step.

Suggested invocation in a fresh session:

```
Read docs/reviews/<topic>.md and walk through it. For every audit question,
inspect the codebase and answer yes/no with evidence (file:line citations
or command output). Summarise findings at the end with severity tags:
[critical] money or security at risk; [high] correctness or stability;
[medium] tech debt; [low] cosmetic.
```

For non-trivial findings (multi-file refactor, schema migration, dependency upgrade with breaking changes): the reviewer must produce a written plan before changing any code. Trivial fixes (a missing `.gitignore` line, a typo) can go straight to a PR.

## Playbook index

| # | File | Scope | Highest-stakes section |
|---|------|-------|------------------------|
| 1 | [`security.md`](security.md) | Secrets, JWT, wallet encryption, on-chain auth, CVE hygiene | Wallet key handling |
| 2 | [`frontend-style.md`](frontend-style.md) | `apps/web` — React, TypeScript, hooks, shadcn/ui, ESLint | Component boundaries & state |
| 3 | [`api-style.md`](api-style.md) | `apps/api` — Kotlin, Ktor, Hoplite, Exposed | Service / repository / routing layering |
| 4 | [`chain-style.md`](chain-style.md) | `apps/chain` — TypeScript, viem, Fastify | Idempotency & error envelopes |
| 5 | [`database.md`](database.md) | Schema, `Tables.kt` ↔ `schema.md` sync, migrations, indexes | Schema drift between code and skill doc |
| 6 | [`numerical-correctness.md`](numerical-correctness.md) | `BigDecimal` / `bigint` usage, decimals, rounding | Token amount precision |
| 7 | [`on-chain-safety.md`](on-chain-safety.md) | Slippage, MEV, idempotency, gas vs fees, RPC failover | Slippage caps |
| 8 | [`testing.md`](testing.md) | Test pyramid per service, mocking policy, fork tests | Real-DB integration tests |
| 9 | [`observability.md`](observability.md) | Structured logs, correlation IDs, metrics, Telegram alerts | Correlation ID propagation |
| 10 | [`infrastructure.md`](infrastructure.md) | k8s/Kustomize, Secrets, NetworkPolicy, replicas, CronJob | Secrets in Secrets (not ConfigMaps) |
| 11 | [`ci-cd.md`](ci-cd.md) | GitHub Actions: build, deploy, branch protection | Manual deploy step gating |
| 12 | [`api-contracts.md`](api-contracts.md) | `api↔chain` OpenAPI, `web↔api` REST, JWT, error shape | OpenAPI as source of truth |

## When to run

| Cadence | Playbooks |
|---------|-----------|
| Monthly | All twelve, rotated (one per week is fine) |
| Before a release | `security`, `numerical-correctness`, `on-chain-safety`, `database`, `infrastructure` |
| After an incident | The two most directly related to the failure mode, plus `observability` to verify telemetry would have caught it next time |
| When onboarding a contributor | `*-style.md` and `api-contracts.md` |

## Updating the playbooks

If `BEST_PRACTICES.md` changes, the corresponding playbook section here probably needs updating too — playbooks reference `BEST_PRACTICES.md` by section number. Stale playbooks are worse than no playbooks: a reviewer trusting an outdated check will sign off on broken code.
