# API Service Style Review Playbook

> Audit playbook for `apps/api` — Kotlin 2.0 + Ktor 2.3 + Exposed 0.52 + Hoplite. Targets the rules in [`BEST_PRACTICES.md §2 apps/api`](../BEST_PRACTICES.md).

**Scope:** `apps/api/src/**`. Database schema concerns are split between this playbook (Exposed DSL usage, transactions, indexes used in `WHERE`) and [`database.md`](database.md) (the schema itself, migrations, retention).

**Reference:** [`BEST_PRACTICES.md §2`](../BEST_PRACTICES.md), [`§1.4 Error Handling`](../BEST_PRACTICES.md), [`§1.5 Observability`](../BEST_PRACTICES.md).

---

## 1. Configuration via Hoplite

### Audit questions

- [ ] All env-var consumers go through `AppConfig` ([`apps/api/src/main/kotlin/fi/lagrange/config/AppConfig.kt`](../../apps/api/src/main/kotlin/fi/lagrange/config/AppConfig.kt)) — never `System.getenv("...")` inline?
- [ ] Required env vars declared as **non-nullable** fields so Hoplite fails at startup if missing?
- [ ] Nested data classes (`DatabaseConfig`, `JwtConfig`, `WalletConfig`, etc.) — not a flat list of 20 fields?
- [ ] No defaults that hide missing values for security-critical settings (`JWT_SECRET = ""` would let the server boot with a nullable signer)?
- [ ] `application.yaml` ([`apps/api/src/main/resources/application.yaml`](../../apps/api/src/main/resources/application.yaml)) references env vars only — no committed fallbacks for secrets?

### How to inspect

```bash
# Direct env access
git grep -nE 'System\.getenv|System\.getProperty' apps/api/src

# Defaults on secret-bearing fields in config classes
git grep -nE 'val (jwtSecret|encryptionKey|botToken|password)\s*:' apps/api/src/main/kotlin/fi/lagrange/config

# YAML hardcoded fallbacks
git grep -nE '^\s*(secret|key|password|token):\s+[^$]' apps/api/src/main/resources/application.yaml
```

### Red flags

- `System.getenv("JWT_SECRET") ?: "changeme"` — boots with an attacker-known signer.
- A nullable config field for a value the app cannot run without (Hoplite will accept it; it shouldn't).
- A CI workflow that sets `JWT_SECRET=test` — fine in test, but only if tests are isolated from any real database.

### Reference
[`BEST_PRACTICES.md §2.1 Configuration`](../BEST_PRACTICES.md). [`AppConfig.kt`](../../apps/api/src/main/kotlin/fi/lagrange/config/AppConfig.kt).

---

## 2. Database access — Exposed + transactions

### Audit questions

- [ ] Every write path (`insert`, `update`, `delete`) is inside a `transaction { }` block?
- [ ] `transaction { }` blocks live **in services or repositories**, not in routing handlers? ([`BEST_PRACTICES.md §1.1 TODO`](../BEST_PRACTICES.md) says raw `transaction { }` in `Routing.kt` is a violation.)
- [ ] Every owner-scoped read uses a single query with both predicates: `(Strategies.id eq id) and (Strategies.userId eq userId)`?
- [ ] No "check ownership, then fetch" pattern that does two separate queries (race condition + duplicated work — see open TODO at `StrategyService.kt:333-348`)?
- [ ] Foreign-key columns used in `WHERE` (especially `userId`, `strategyId`) have explicit `.index()` in `Tables.kt`?
- [ ] Columns that must be unique have `.uniqueIndex()` (e.g. `idempotency_key`, `wallets.user_id`)?
- [ ] No N+1 queries — events with rebalance details / chain transactions use joins or batch `IN (...)` (see open TODO at `StrategyService.kt:366-424`)?
- [ ] No `SchemaUtils.drop` or `SchemaUtils.dropAll` in production code paths?

### How to inspect

```bash
# Routing should not contain transaction blocks (rule §1.1)
git grep -n 'transaction\s*{' apps/api/src/main/kotlin/fi/lagrange/plugins/

# Two-query ownership anti-pattern: select without userId after a select with userId
sed -n '/fun getStats/,/^    }/p' apps/api/src/main/kotlin/fi/lagrange/services/StrategyService.kt
sed -n '/fun getEventHistory/,/^    }/p' apps/api/src/main/kotlin/fi/lagrange/services/StrategyService.kt

# Indexes in Tables.kt — every userId / strategyId column should have one
git grep -nE 'integer\("user_id"\)|integer\("strategy_id"\)|integer\("strategy_event_id"\)' apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt
git grep -nE '\.index\(\)|\.uniqueIndex\(\)' apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt

# N+1 in event history
sed -n '/fun getEventHistory/,/^    }/p' apps/api/src/main/kotlin/fi/lagrange/services/StrategyService.kt | grep -E 'select|where'
```

### Red flags

- A `transaction { }` block in `Routing.kt` — violates §1.1, should move to a service.
- A `select { ... }` filtered only by primary key followed by an in-Kotlin check `if (row[Strategies.userId] == userId)` — works but allows tampering paths (and races a delete).
- A loop `events.map { transaction { ... } }` — that's N transactions instead of one.
- A new column added to `Tables.kt` without `.index()` even though it's used as a `WHERE` filter — flag immediately.

### Reference
[`BEST_PRACTICES.md §2.2 Database`](../BEST_PRACTICES.md). [`Tables.kt`](../../apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt), [`StrategyService.kt`](../../apps/api/src/main/kotlin/fi/lagrange/services/StrategyService.kt).

---

## 3. Authentication and authorisation

### Audit questions

- [ ] Every protected route under `authenticate("jwt") { ... }` extracts `userId` via `call.getUserId()`?
- [ ] `getUserId()` ([`JwtConfig.kt:55`](../../apps/api/src/main/kotlin/fi/lagrange/auth/JwtConfig.kt)) throws `UnauthorizedException` (clean 401), never `!!` that yields `NullPointerException`? **Open TODO in `BEST_PRACTICES.md §2.3` — verify.**
- [ ] `UnauthorizedException` is mapped in `StatusPages.kt` to HTTP 401 (currently yes — [`StatusPages.kt:14`](../../apps/api/src/main/kotlin/fi/lagrange/plugins/StatusPages.kt))?
- [ ] Authorisation (does `userId` own this resource?) lives in **services**, not in routing. Routing extracts; services enforce.
- [ ] `POST /api/v1/strategies` (register existing position) verifies `PositionResponse.owner == walletAddressDerivedFrom(userPhrase)`? **Open TODO `Routing.kt:279-309` — until fixed, any user can attach any on-chain position to themselves.**
- [ ] `iat` claim added to JWTs ([`JwtConfig.kt:23-30`](../../apps/api/src/main/kotlin/fi/lagrange/auth/JwtConfig.kt))? Open TODO.

### How to inspect

```bash
# Every routing handler with :id should also include userId in its query
git grep -nB1 -A6 'parameters\["id"\]' apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt

# Bare !! after principal<>() — must not exist
git grep -nE 'principal<.*>\(\)!!' apps/api/src

# StatusPages mappings
sed -n '1,$p' apps/api/src/main/kotlin/fi/lagrange/plugins/StatusPages.kt
```

### Red flags

- A `getUserId()` that throws NPE — unhandled `Throwable` mapping in `StatusPages` returns 500, leaking the failure to the client as a server error.
- A new endpoint added under `/api/v1/*` outside the `authenticate("jwt") { }` block.
- A handler that fetches by `:id` and returns the row without checking `userId` (silent data leak).
- A login or register endpoint with no rate-limiting (`BEST_PRACTICES.md §2.3 CONSIDER`).

### Reference
[`BEST_PRACTICES.md §2.3 Authentication & Authorization`](../BEST_PRACTICES.md). [`AuthRoutes.kt`](../../apps/api/src/main/kotlin/fi/lagrange/auth/AuthRoutes.kt), [`Routing.kt`](../../apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt).

---

## 4. Service layer purity

### Audit questions

- [ ] Routing handlers are thin: extract input → call a service → respond. No SQL, no business calculations, no `transaction { }`.
- [ ] Services do not also embed Kotlin DTOs deeply — DTOs live near routing/serialisation, not deep in business code that the executor / scheduler calls?
- [ ] Service functions are explicit about side effects in their names (`getStrategyAndRefreshFromChain` — yes; `getStrategy` that secretly calls chain — no)?
- [ ] All `ChainClient` calls inside services wrapped in try/catch and converted to a typed result (sealed class or exception subclass), not propagated as raw `Exception`?
- [ ] No "magic string" status comparisons — `StrategyEventStatus` constants used everywhere (open TODO `Tables.kt:83`, `UniswapStrategy.kt`, `Routing.kt`)?
- [ ] `calcTickRange` exists in **one** place (e.g. `StrategyMath.kt`)? Open TODO: `Routing.kt:63-71` and `UniswapStrategy.kt:204-212` previously had two implementations with different rounding.

### How to inspect

```bash
# Routing should not contain transaction { }, SQL, or numeric tick math
git grep -nE 'transaction\s*\{|Strategies\.|StrategyEvents\.|tickLower|tickUpper|floorDiv' apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt

# Untyped chain errors leaking
git grep -nE 'chainClient\.[a-zA-Z]+\(' apps/api/src/main/kotlin/fi/lagrange | grep -v 'try\|catch'

# String-literal status checks
git grep -nE 'status\s*==\s*"(pending|in_progress|success|failed)"' apps/api/src

# Duplicate calcTicks / tick math
git grep -nE 'fun calcTick|fun calculateNewRange|tickSpacing' apps/api/src
```

### Red flags

- A handler that does `transaction { Strategies.update { ... } }` directly — should be `strategyService.updateX(...)`.
- A `chainClient.execute(...)` whose exception path is just "let it bubble" — the user sees a 500 with `connection refused` in the body.
- Two implementations of "compute new tick range" — even if equivalent today, they will drift. Each rebalance disagreeing on ticks is silent drift in money-handling code.

### Reference
[`BEST_PRACTICES.md §1.1 Service Boundaries`](../BEST_PRACTICES.md), [`§2.4 Service Layer`](../BEST_PRACTICES.md).

---

## 5. Strategy and scheduling

### Audit questions

- [ ] `StrategyScheduler` ([`apps/api/src/main/kotlin/fi/lagrange/strategy/StrategyScheduler.kt`](../../apps/api/src/main/kotlin/fi/lagrange/strategy/StrategyScheduler.kt)) instantiates strategies through `ProtocolStrategy` interface, not a hard reference to `UniswapStrategy`? Open TODO: `StrategyScheduler.kt:30`.
- [ ] No `runBlocking { }` on a `fixedRateTimer` callback for long operations — uses a `CoroutineScope` per scheduler instead. Open TODO in `BEST_PRACTICES.md §2.5`.
- [ ] Scheduler restarts cleanly on pod restart: `loadAndStartAll()` is idempotent (existing timers are cancelled before starting new ones)?
- [ ] No timer leak when a strategy is paused / stopped — the timer is cancelled in `pause`, `resume`, and `stop` paths?
- [ ] `ExecutorRegistry` ([`CLAUDE.md`](../../CLAUDE.md)) sketched — even if v2/v3 not built, the seam exists?

### How to inspect

```bash
# Scheduler internals
sed -n '1,$p' apps/api/src/main/kotlin/fi/lagrange/strategy/StrategyScheduler.kt

# runBlocking in scheduler
git grep -nE 'runBlocking|Thread\.sleep' apps/api/src/main/kotlin/fi/lagrange/strategy

# CoroutineScope and SupervisorJob
git grep -nE 'CoroutineScope|SupervisorJob|launch \{' apps/api/src/main/kotlin/fi/lagrange/strategy

# Hardcoded strategy class
git grep -n 'UniswapStrategy(' apps/api/src/main/kotlin/fi/lagrange/strategy
```

### Red flags

- `runBlocking { executeOnce(...) }` on a `fixedRateTimer` — one slow strategy starves others.
- A `private val executor = UniswapStrategy(...)` field on `StrategyScheduler` — blocks v2.
- A strategy that is paused but its timer is still firing (often a missed `cancel()` call on the `Timer`).
- A `Timer` with a daemon=false flag — JVM never exits cleanly on shutdown.

### Reference
[`BEST_PRACTICES.md §2.5 Strategy & Scheduling`](../BEST_PRACTICES.md). [`StrategyScheduler.kt`](../../apps/api/src/main/kotlin/fi/lagrange/strategy/StrategyScheduler.kt), [`UniswapStrategy.kt`](../../apps/api/src/main/kotlin/fi/lagrange/strategy/UniswapStrategy.kt), [`ProtocolStrategy.kt`](../../apps/api/src/main/kotlin/fi/lagrange/strategy/ProtocolStrategy.kt).

---

## 6. Error handling

### Audit questions

- [ ] No `catch (e: Exception) { /* ignore */ }` — every catch either logs **with stack trace and context** or rethrows?
- [ ] No `catch (_: Exception) { ... }` that hides what went wrong without logging? **Open TODO `Routing.kt:345`: `DELETE /strategies/{id}` swallows close failures, leaving funds at risk.**
- [ ] Recoverable errors at the api level → record `failed` event in DB and Telegram alert (per `BEST_PRACTICES.md §1.4` table)?
- [ ] Routing handlers respond with structured `{ error: "..." }` for client-visible failures, never echo raw stack traces?
- [ ] `StatusPages.kt` covers the exception types that actually escape services — anything new added to `services/` checked here?

### How to inspect

```bash
# Silent catch blocks
git grep -nB1 -A2 'catch (_:' apps/api/src
git grep -nB1 -A4 'catch (e: Exception)' apps/api/src | grep -B4 -A2 -E '/\* ?(non-fatal|ignore|noop)|\}\s*$'

# Stack traces echoed to client
git grep -nE 'stackTrace|printStackTrace|cause\.toString' apps/api/src
```

### Red flags

- `catch (e: Exception) { log.warn("nope") }` — context-free, useless during incident.
- A "non-fatal" comment shielding a code path that handles money on-chain.
- An exception class without a `StatusPages` mapping → every occurrence becomes a 500.

### Reference
[`BEST_PRACTICES.md §1.4 Error Handling Hierarchy`](../BEST_PRACTICES.md), [`StatusPages.kt`](../../apps/api/src/main/kotlin/fi/lagrange/plugins/StatusPages.kt).

---

## 7. Coroutines and concurrency

### Audit questions

- [ ] No `runBlocking` outside main / startup paths or test code?
- [ ] `Dispatchers.IO` used for blocking JDBC / chain calls when launching coroutines?
- [ ] `SupervisorJob` used so one strategy's failure doesn't cancel siblings?
- [ ] No `GlobalScope.launch` — every coroutine has a scoped lifetime tied to a request or to a managed object?
- [ ] Cancellation respected: long-running tasks check `coroutineContext.isActive` between RPC calls?

### How to inspect

```bash
git grep -nE 'GlobalScope\.|runBlocking\s*\{' apps/api/src
git grep -n 'Dispatchers\.' apps/api/src
git grep -n 'isActive' apps/api/src
```

### Red flags

- `GlobalScope.launch { ... }` — survives the request, leaks state, confuses shutdown.
- `Dispatchers.Default` for a JDBC call — starves the limited Default pool.
- A coroutine that catches `CancellationException` and continues — breaks structured concurrency.

### Reference
[`BEST_PRACTICES.md §2.5`](../BEST_PRACTICES.md).

---

## 8. Logging

### Audit questions

- [ ] Every service uses an SLF4J logger named after the class (`LoggerFactory.getLogger(StrategyService::class.java)`)?
- [ ] Structured key=value or JSON output, not concatenated strings?
- [ ] `requestId` correlation id present on every `chain/` request and every log line in the rebalance cycle? **Open TODO `ChainClient.kt`: `requestId` not forwarded.**
- [ ] No log statement with secret-bearing fields (cross-link to [`security.md §9`](security.md))?
- [ ] `CallLogging` not configured at `TRACE` level — only `method, path, status, durationMs` ([`BEST_PRACTICES.md §1.5`](../BEST_PRACTICES.md))?

### How to inspect

```bash
# Logger declarations
git grep -nE 'LoggerFactory\.getLogger' apps/api/src

# Format style (string concat vs structured)
git grep -nE 'log\.(info|warn|error|debug)\(".*\$\{?[a-zA-Z_]' apps/api/src | head

# CallLogging level
git grep -nE 'level\s*=\s*Level\.' apps/api/src
```

### Red flags

- A logger called by `Application.kt` for *every* class — losing per-package level control.
- `log.info("processing $request")` where `$request` includes wallet phrase.
- `log.error("error", e.message)` — stack trace lost; should be `log.error("context", e)`.

### Reference
[`BEST_PRACTICES.md §1.5 Observability`](../BEST_PRACTICES.md), [`security.md §9`](security.md).

---

## 9. DTO / Serialisation discipline

### Audit questions

- [ ] All wire types annotated `@Serializable`?
- [ ] DTOs separate from domain models? E.g. `StrategyRecord` (internal) vs `StrategyDto` (over the wire)?
- [ ] `kotlinx.serialization.Serializable` used consistently — no Jackson, no Gson?
- [ ] No `@SerialName` rename on a field unless absolutely necessary (drift over time)?
- [ ] Numbers that represent money or chain amounts go over the wire as **strings**, not `Double` / `Long`?

### How to inspect

```bash
git grep -n '@Serializable' apps/api/src/main/kotlin/fi/lagrange | head -30

# Mixed serialisation libs
git grep -nE 'com\.fasterxml\.jackson|com\.google\.gson' apps/api/src

# Doubles for token amounts in DTOs
git grep -nE ': Double[ ,)]' apps/api/src/main/kotlin/fi/lagrange/services
```

### Red flags

- An on-chain `amount` field declared `Double` — silent precision loss for any value above `2^53`.
- A new endpoint that imports `ObjectMapper` — wrong library, project standard is kotlinx.
- A polymorphic response type (sealed hierarchy) without `@SerialName` discriminator — fragile to refactors.

### Reference
[`BEST_PRACTICES.md §1.6 Decimal & Financial Math`](../BEST_PRACTICES.md), [`numerical-correctness.md`](numerical-correctness.md).

---

## 10. Build hygiene

### Audit questions

- [ ] `./gradlew build` succeeds from a clean checkout (no `~/.gradle/caches` leftovers)?
- [ ] `./gradlew test` runs and passes?
- [ ] `kotlinOptions.jvmTarget` ([`build.gradle.kts:78`](../../apps/api/build.gradle.kts)) matches Docker base image JDK (currently both 17)?
- [ ] No `compileOnly` or `runtimeOnly` mixed up that breaks production builds?
- [ ] No SNAPSHOT / RC dependencies pinned in `dependencies { }` — only released versions?
- [ ] Detekt or ktlint configured (CONSIDER — flag if missing)?

### How to inspect

```bash
( cd apps/api && ./gradlew --no-daemon build )
git grep -nE 'SNAPSHOT|-rc|-beta|-alpha' apps/api/build.gradle.kts
ls apps/api/.editorconfig apps/api/detekt.yml 2>/dev/null
```

### Red flags

- A SNAPSHOT pinned to a private repo — breaks reproducible builds.
- `compileOnly("...something runtime needs...")` — fine in tests, nukes production.
- A module that does `implementation("...:latest.release")` — silent updates.

### Reference
[`apps/api/build.gradle.kts`](../../apps/api/build.gradle.kts).

---

## How to run this review

1. **Open a fresh Claude Code session** (do not reuse one that recently edited Kotlin code).
2. From repo root, walk top-to-bottom through sections 1 → 10. Run every command. Paste output as evidence.
3. Mark **yes / no / partial** for each audit question.
4. Tag findings:
   - **[critical]** money-handling correctness or auth bypass (e.g. `getUserId()` returns NPE; `DELETE /strategy` swallows close failure; missing on-chain owner check on register).
   - **[high]** rule violation that compounds over time (e.g. raw `transaction { }` in routing; N+1 queries; duplicated tick math).
   - **[medium]** SHOULD violations (e.g. magic-string status comparisons; missing `iat` claim).
   - **[low]** style / naming / dead code.
5. Track these recurring TODOs from `BEST_PRACTICES.md §2` until each is closed:
   - `Routing.kt` direct `transaction { }` blocks (§1.1).
   - `getStats()` two-query pattern (§2.2).
   - `getEventHistory()` N+1 (§2.2).
   - `Strategies.userId` missing index (§2.2).
   - `recordRebalanceEvent` re-fetches decimals (§2.2).
   - `StrategyEventStatus` constants (§2.2).
   - `getUserId()` `!!` (§2.3).
   - On-chain owner check on register strategy (§2.3).
   - Hardcoded `UniswapStrategy` in scheduler (§2.5).
   - Duplicate `calcTickRange` (§2.4).

A typical pass takes **45-75 minutes** on this codebase, dominated by walking through `Routing.kt` and `StrategyService.kt`.
