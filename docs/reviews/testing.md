# Testing Review Playbook

> Audit playbook for the test strategy across `apps/api`, `apps/chain`, `apps/web`, and `packages/shared`.

**Honest baseline (at the time this playbook was written):**
- `apps/api`: `testImplementation(kotlin("test"))` and `ktor-server-test-host` are wired in [`build.gradle.kts:69-70`](../../apps/api/build.gradle.kts), but the `apps/api/src/test/` directory is empty — there are **no Kotlin tests**.
- `apps/chain`: `vitest` is in `devDependencies` ([`apps/chain/package.json:25`](../../apps/chain/package.json)) and `npm test` runs it, but there are **no `*.test.ts` files**.
- `apps/web`: **no test runner configured** at all — `package.json` has no `test` script.
- No fork-test infrastructure (Anvil / Hardhat).

This means most "audit questions" below produce a 'no'. That is the expected result — the playbook's purpose is to track the gap and prioritise it.

**Reference:** [`BEST_PRACTICES.md §4.1, §4.4, §4.6 (testability mentions)`](../BEST_PRACTICES.md), [`CLAUDE.md "Fork testing"`](../../CLAUDE.md). [`numerical-correctness.md §7`](numerical-correctness.md), [`on-chain-safety.md §10`](on-chain-safety.md).

---

## 1. Test pyramid — minimum viable per service

| Service        | Unit                          | Integration                     | End-to-end / fork           |
|----------------|-------------------------------|---------------------------------|-----------------------------|
| `apps/api`     | `kotlin.test` for math, services with mocked deps | `ktor-server-test-host` + real Postgres (Testcontainers) | API ↔ chain (ephemeral chain stub) |
| `apps/chain`   | `vitest` for swap / tick math | `vitest` + real RPC (forked Arbitrum via Anvil) | Same — already integration |
| `apps/web`     | `vitest` (or `jest`) for utils & components | `@testing-library/react` for hooks/forms/pages | Playwright against `dev:mock` or staging |
| `packages/shared` | `vitest` for type contracts and runtime parsers | — | — |

### Audit questions

- [ ] At least one unit test exists per service for the **highest-stakes module** (api: `StrategyMath` / `StrategyService.getStats`; chain: `swap.computeAmountOutMinimum`; web: `formatUsd`)?
- [ ] Tests run in CI on every PR (not just on demand)?
- [ ] CI **fails** when a test fails (no "test stage allows failures" cheat)?
- [ ] Coverage measured (jacoco for Kotlin, c8/v8 for vitest) — even if no minimum threshold yet, the number is published?

### How to inspect

```bash
# Existence
find apps/api/src/test -type f 2>/dev/null
find apps/chain -name '*.test.ts' -o -name '*.spec.ts' 2>/dev/null | grep -v node_modules
find apps/web -name '*.test.tsx' -o -name '*.spec.ts' 2>/dev/null | grep -v node_modules

# CI calls test scripts
git grep -nE 'gradlew test|npm test|npm run test|vitest' .github/workflows/

# Coverage tooling
git grep -nE 'jacoco|c8|@vitest/coverage' apps/
```

### Red flags

- Test files exist but CI never runs them.
- Only `.test.ts.skip` / `xit(...)` / `@Disabled` files.
- A workflow with `continue-on-error: true` on the test step.

### Reference
[`BEST_PRACTICES.md §4`](../BEST_PRACTICES.md), [`CLAUDE.md`](../../CLAUDE.md).

---

## 2. Mocking policy

The single most important policy is: **do not mock the database in integration tests**. The project's correctness lives in Postgres-side constraints, triggers, indexes, and Exposed query semantics. Mocking the DB defeats every one of those.

### Audit questions

- [ ] Integration tests use **Testcontainers** (or equivalent ephemeral Postgres) — not an in-memory mock or H2?
- [ ] No mock of `WalletService`'s encryption — it's pure Kotlin, test it for real?
- [ ] No mock of the `ProtocolStrategy` interface in tests of the executor itself; mock it only when testing the scheduler that wraps it?
- [ ] In chain tests, viem clients are **not** mocked when the test claims to test on-chain behaviour — use a fork.
- [ ] In web tests, `apiFetch` is mocked at the `fetch` global level (using `msw` or `vi.fn`), not by replacing `api.ts` with a fake — that loses the URL contract?

### How to inspect

```bash
# Postgres mocking anti-pattern
git grep -niE 'h2|in-memory|inMemory|sqlite|mockDatabase' apps/api/src/test 2>/dev/null

# viem mocking
git grep -niE 'mockClient|vi\.mock\(.*viem|jest\.mock\(.*viem' apps/chain

# Manual replacement of api.ts
git grep -niE "vi\.mock\('.*api'" apps/web/src
```

### Red flags

- `vi.mock('@lagrangefi/chain')` in api integration tests — dodges the actual contract.
- An H2-backed Spring `@DataJpaTest`-style fake — irrelevant here, but a "fast tests" tempted dev might suggest it.
- An e2e web test that stubs `apiFetch` returning `{ ok: true }` — never observes a real shape.

### Reference
[`BEST_PRACTICES.md`](../BEST_PRACTICES.md) implicitly throughout `§2-4`.

---

## 3. Test the failure path

Most current tests cover the success path. The catastrophic bugs in this project are in the failure path.

### Audit questions

- [ ] At least one test per service exercises the **failure** path of the function under test:
  - api: `StrategyService.create` rejects unauthorised wallet, rejects invalid range, rejects when chain returns 5xx.
  - chain: `rebalance` returns `{ success: false }` on swap revert; `recoverCollect` runs to completion.
  - web: `LoginPage` shows server error on 401, disables submit while in flight.
- [ ] Tests for **idempotency**: same `idempotencyKey` → second call is a 409, no second on-chain effect, both rows in DB visible.
- [ ] Tests for cancellation / partial failure (cross-link to [`on-chain-safety.md §7`](on-chain-safety.md)).
- [ ] Tests for boundary numerical values: tick at MIN/MAX, amounts at `2^53` and `2^64` boundaries (cross-link to [`numerical-correctness.md §7`](numerical-correctness.md)).

### How to inspect

```bash
git grep -nE 'expect.*toBe\(false\)|assertEquals.*false|assertThrows' apps/api/src/test apps/chain
git grep -nE 'idempotency' apps/api/src/test apps/chain 2>/dev/null
```

### Red flags

- Tests with names like `testHappyPath`, `successCase` and nothing else.
- A test asserting `result.success === true` without also asserting on at least one out-of-band side effect (DB row, log line, Telegram alert).
- A test that mocks the underlying call to always succeed — when the underlying fails in production, the test stays green forever.

### Reference
[`BEST_PRACTICES.md §1.4 Error Handling`](../BEST_PRACTICES.md), [`§3.5`](../BEST_PRACTICES.md), [`on-chain-safety.md`](on-chain-safety.md).

---

## 4. Fork tests for chain

Real Uniswap behaviour (slippage, fees, liquidity, price impact) cannot be reproduced from scratch. Fork tests use Anvil/Hardhat against a pinned Arbitrum block.

### Audit questions

- [ ] Anvil (or Hardhat) wired into `apps/chain` tests with `RPC_FORK_URL` and a pinned `forkBlockNumber`?
- [ ] Pinned block contains a known WETH/USDC pool with non-trivial liquidity?
- [ ] At least one full happy-path rebalance test against the fork?
- [ ] Slippage exceeded test: set `slippageTolerance: 0.0001` and assert the swap reverts with the expected error?
- [ ] Recovery test: simulate a crash between burn and mint; run `recoverCollect`; assert position state restored?
- [ ] Tests do not depend on real-time external state (RPC must be the fork, not mainnet directly)?

### How to inspect

```bash
git grep -niE 'anvil|hardhat|forkBlockNumber|RPC_FORK_URL|forking:' apps/
ls apps/chain/test apps/chain/tests apps/chain/__tests__ 2>/dev/null
```

### Red flags

- A "fork test" that reads from real Arbitrum mainnet — flaky, may move money on miswritten test.
- A pinned block that is over a year old — Uniswap v3 contract upgrades may have shifted ABIs.
- No retry / clean-up in tests — accumulating leftover positions on the fork.

### Reference
[`CLAUDE.md "Fork testing"`](../../CLAUDE.md), [`on-chain-safety.md §10`](on-chain-safety.md).

---

## 5. Web tests

### Audit questions

- [ ] A test runner installed (`vitest` is standard alongside Vite; alternatively `jest + jsdom`)?
- [ ] At least one component test that uses `@testing-library/react` (rendering + interaction)?
- [ ] A test for `AuthContext` that asserts the `clearToken()` semantics on 401 (cross-link to [`frontend-style.md §1`](frontend-style.md))?
- [ ] A test that exercises one form (`LoginPage` or strategy-create) — submit disabled while in-flight, error shown on rejection, success path reaches the protected route?
- [ ] Mocks scoped to the `fetch` boundary, not deeper (so refactors of `api.ts` don't silently invalidate every test)?
- [ ] A snapshot test for the rendered structure of one critical view (`StrategyPage` cards) — flag for false-positive risk if the file is huge.

### How to inspect

```bash
git grep -nE 'testing-library|vitest|jest' apps/web/package.json
ls apps/web/src/__tests__ apps/web/test 2>/dev/null
```

### Red flags

- A snapshot test of `StrategyPage.tsx` (~2300 lines): every CSS tweak invalidates it, devs `--update-snapshots` reflexively, signal lost.
- A test that imports `mockData.ts` and asserts mock-only behaviour — exercises the test fixture, not the app.

### Reference
[`BEST_PRACTICES.md §4.1, §4.6`](../BEST_PRACTICES.md), [`frontend-style.md`](frontend-style.md).

---

## 6. Test fixtures and data

### Audit questions

- [ ] No real wallet phrases or private keys in test fixtures (cross-link to [`security.md §1`](security.md))?
- [ ] Test wallet on the fork uses well-known test mnemonics (e.g. `"test test test test test test test test test test test junk"`) so any leaked test key is harmless?
- [ ] Fixtures committed under `apps/*/test/fixtures/` are **deterministic** — no timestamps, random IDs that produce flaky comparisons?
- [ ] Tests do not share global state across files (each test sets up its own DB transaction or fresh container)?

### How to inspect

```bash
git grep -niE 'mnemonic|privateKey' apps/api/src/test apps/chain 2>/dev/null
git grep -niE 'Date\.now|Math\.random' apps/api/src/test apps/chain 2>/dev/null
```

### Red flags

- A `0x...64hex...` checked into a test file — even if it's a known test key, treat as a leak (CI logs it, an attacker hunts).
- Tests that pass alone but fail when run in parallel — shared mutable singleton (e.g. `JwtConfig` static state, `processedKeys` in chain).

### Reference
[`security.md §1`](security.md).

---

## 7. CI test execution

### Audit questions

- [ ] `npm test` for chain runs in CI on every PR?
- [ ] `./gradlew test` for api runs in CI on every PR?
- [ ] `npm test` for web runs in CI (once a runner exists)?
- [ ] A failing test fails the workflow; no `continue-on-error: true`?
- [ ] Slow tests gated by a label or path filter so PRs to `docs/` don't run the fork suite?
- [ ] Test results published as artefacts so a reviewer can see which test failed without reading the log?
- [ ] Coverage report uploaded to Codecov / artefact for trend?

### How to inspect

```bash
git grep -nE 'gradlew test|npm test|npm run test' .github/workflows/
git grep -nE 'continue-on-error|allow-failures' .github/workflows/
git grep -nE 'actions/upload-artifact' .github/workflows/
```

### Red flags

- A `gradlew build` that secretly skips tests via `-x test`.
- A workflow file that runs tests only on a `[run-tests]` label — easy to forget.
- Coverage report generated locally but never uploaded.

### Reference
[`ci-cd.md`](ci-cd.md), [`.github/workflows/`](../../.github/workflows/).

---

## 8. Flakiness budget

### Audit questions

- [ ] Tests that have been retried more than once in the last 90 days are flagged?
- [ ] Flaky tests are either fixed or quarantined (skipped with a TODO and an issue link), never silently passing on retry?
- [ ] No `setTimeout`-based waits in tests — use deterministic conditions?
- [ ] Tests for async behaviour use `waitFor`, `eventually`, or coroutine join points, not arbitrary delays?

### How to inspect

```bash
git grep -nE 'setTimeout|sleep\(|delay\(|Thread\.sleep' apps/api/src/test apps/chain apps/web/src 2>/dev/null
git grep -niE '@Disabled|\.skip|xit\(|describe\.skip' apps/
```

### Red flags

- Any `Thread.sleep(...)` in a Kotlin test.
- Any `await new Promise(r => setTimeout(r, 5000))` in a TS test.
- An accumulating list of `xit("...flaky...")` with no follow-up issue.

### Reference
*(no specific BEST_PRACTICES entry — apply common sense)*.

---

## How to run this review

1. **Open a fresh Claude Code session.**
2. Walk top-to-bottom through sections 1 → 8. For each: run inspection commands, paste output, mark **yes / no / partial**.
3. Tag findings:
   - **[critical]** there are *zero* tests for a money-handling code path that could fail silently in production.
   - **[high]** the tooling is configured but no tests exist (current state for api / chain).
   - **[medium]** tests exist but are happy-path only / mock too aggressively.
   - **[low]** style: test file naming, fixture organisation, missing snapshot resets.
4. Recurring TODOs to track every pass:
   - First test for each service (§1).
   - Testcontainers / fork integration (§2, §4).
   - CI wiring (§7).
   - Coverage publication (§7).
5. Resist the temptation to write tests **during** the review session — capture findings, then plan a separate testing-bootstrap effort. A test written hastily during a review is often worse than no test (gives a false sense of safety).

A typical pass takes **20-40 minutes** today (because most answers are "no, missing"). Once tests exist, expect 60+ minutes per pass.
