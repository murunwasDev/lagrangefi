# Kotlin Code Review Guide

A comprehensive checklist for analyzing Kotlin code — covering correctness, design, security, performance, and AI maintainability.  
Each rule is tagged: **MUST** (correctness/security risk if skipped) · **SHOULD** (strongly recommended) · **CONSIDER** (worth doing when time permits).

---

## Quick-Reference Checklist

Use this during PR review. Each item links to the full rule below.

**Design**
- [ ] Functions have one clear responsibility; handlers delegate, don't compute ([1.1](#11-single-responsibility--must))
- [ ] No speculative abstractions for features not yet built ([1.7](#17-yagni--you-arent-gonna-need-it--should))
- [ ] Inputs validated at boundaries with `require()` before any logic runs ([1.8](#18-fail-fast--must))
- [ ] Functions either change state or return data — not both ([1.9](#19-command-query-separation-cqs--should))
- [ ] Financial math is in pure functions; DB writes are in separate functions ([1.10](#110-functional-core-imperative-shell--should))

**Kotlin**
- [ ] No `!!` anywhere ([2.4](#24-avoid--non-null-assertion--must))
- [ ] `sealed` used for fixed state sets; no bare `String` constants for status ([2.3](#23-use-sealed-class--sealed-interface-for-exhaustive-state--should))
- [ ] `val` used everywhere `var` is not needed ([2.1](#21-prefer-val-over-var--must))

**Correctness**
- [ ] Every multi-step DB write in a single `transaction {}` ([6.1](#61-every-multi-step-db-write-must-be-in-one-transaction--must))
- [ ] External side effects (chain calls) are preceded by a DB intent record ([6.2](#62-insert-the-intent-record-before-the-side-effect--must))
- [ ] No silent `catch (_: Exception) {}` blocks ([4.1](#41-never-swallow-exceptions-silently--must))

**Security**
- [ ] No string interpolation into Telegram / external APIs ([7.1](#71-never-interpolate-user-input-into-strings-sent-to-external-systems--must))
- [ ] No wallet phrases or tokens in logs ([7.2](#72-sensitive-values-must-not-appear-in-logs--must))
- [ ] All `/api/v1/*` routes inside `authenticate("jwt")` ([7.4](#74-always-authenticate-before-authorization--must))

**Precision (financial code)**
- [ ] No `Double` for monetary values — use `BigDecimal` ([9.1](#91-never-use-double-for-monetary-amounts--must))
- [ ] `BigDecimal` constructed from `String`, not `Double` ([9.3](#93-construct-bigdecimal-from-string-not-double--must))
- [ ] All `BigDecimal.divide()` calls have explicit scale + `RoundingMode` ([9.2](#92-always-specify-scale-and-rounding-mode-on-division--must))

**Performance**
- [ ] No in-memory filtering of DB results ([8.1](#81-filter-in-sql-not-in-kotlin--must))
- [ ] Indexes exist for all columns used in `WHERE` / `JOIN` ([8.2](#82-add-indexes-for-every-column-used-in-where--join--must))

**Observability**
- [ ] Every Telegram alert contains entity name, id, and next step ([11.3](#113-every-alert-must-include-enough-context-to-act-on--must))

---

## Table of Contents

1. [Design Principles](#1-design-principles)
   - *SOLID*
   - [1.1 Single Responsibility](#11-single-responsibility--must)
   - [1.2 Open for Extension](#12-open-for-extension--should)
   - [1.3 Liskov Substitution](#13-liskov-substitution--consider)
   - [1.4 Interface Segregation](#14-interface-segregation--should)
   - [1.5 Dependency Inversion](#15-dependency-inversion--should)
   - *General*
   - [1.6 DRY — Don't Repeat Yourself](#16-dry--dont-repeat-yourself--should)
   - [1.7 YAGNI](#17-yagni--you-arent-gonna-need-it--should)
   - [1.8 Fail Fast](#18-fail-fast--must)
   - [1.9 Command-Query Separation](#19-command-query-separation-cqs--should)
   - [1.10 Functional Core, Imperative Shell](#110-functional-core-imperative-shell--should)
   - [1.11 Composition over Inheritance](#111-composition-over-inheritance--should)
   - [1.12 Law of Demeter](#112-law-of-demeter--consider)
2. [Kotlin Idioms](#2-kotlin-idioms)
3. [Null Safety](#3-null-safety)
4. [Error Handling](#4-error-handling)
5. [Concurrency and Coroutines](#5-concurrency-and-coroutines)
6. [Data Integrity and Transactions](#6-data-integrity-and-transactions)
7. [Security](#7-security)
8. [Performance](#8-performance)
9. [Financial and Numeric Precision](#9-financial-and-numeric-precision)
10. [Testability](#10-testability)
11. [Observability](#11-observability)
12. [Readability](#12-readability)
13. [AI Maintainability](#13-ai-maintainability)

---

## 1. Design Principles

SOLID was written for Java-style OOP. Kotlin is a multi-paradigm language — it has OOP, but also functional types, sealed classes, extension functions, and `final` by default. The underlying goals of SOLID (low coupling, high cohesion, testability, replaceability) are still fully relevant. The mechanisms often are not.

---

### SOLID Principles

---

### 1.1 Single Responsibility — MUST

**Goal:** Each class and function should have one reason to change.

This principle is language-agnostic and applies fully in Kotlin. It is not about OOP — it applies equally to top-level functions, extension functions, and classes.

**Bad — route handler doing DB work, business logic, and HTTP response:**
```kotlin
post("/strategies/start") {
    val req = call.receive<StartStrategyRequestDto>()
    val poolState = chainClient.getPoolByPair(WETH, USDC, req.feeTier)
    val (tickLower, tickUpper) = calcTickRange(poolState.tick, req.feeTier, req.rangePercent)
    val mintResult = chainClient.mint(...)
    // 80 more lines of BigDecimal math, DB inserts, fee calculations...
    call.respond(HttpStatusCode.Created, result)
}
```

**Good — handler extracts inputs, delegates, returns:**
```kotlin
post("/strategies/start") {
    val userId = call.getUserId()
    val req = call.receive<StartStrategyRequestDto>()
    val result = strategyService.startStrategy(userId, req)
    call.respond(HttpStatusCode.Created, result)
}
```

**Signal:** A function longer than ~40 lines or with more than 2 levels of nesting probably has multiple responsibilities.

---

### 1.2 Open for Extension — SHOULD

**Goal:** Adding new behavior should not require editing existing, working code.

In Java this was achieved through inheritance. In Kotlin, prefer:
- **Registry pattern** for pluggable implementations
- **`sealed class` + `when`** — the compiler flags missing cases when you add a new type
- **Extension functions** — add behavior to a type from outside without touching it

**Bad — must edit this file every time a new protocol is added:**
```kotlin
fun execute(type: String, request: RebalanceRequest) {
    when (type) {
        "uniswap" -> uniswapExecutor.execute(request)
        "aave"    -> TODO() // must edit this file to add v2
    }
}
```

**Good — registry pattern; adding a new executor never touches existing code:**
```kotlin
class ExecutorRegistry {
    private val executors = mutableMapOf<String, ProtocolExecutor>()
    fun register(type: String, executor: ProtocolExecutor) { executors[type] = executor }
    fun execute(type: String, request: RebalanceRequest) = executors[type]?.execute(request)
        ?: error("No executor for type $type")
}
```

**Good — sealed class variant; compiler enforces exhaustiveness:**
```kotlin
sealed interface StrategyType
object Uniswap : StrategyType
object Aave    : StrategyType  // adding this causes every when(type) to fail to compile until handled

fun execute(type: StrategyType, request: RebalanceRequest) = when (type) {
    is Uniswap -> uniswapExecutor.execute(request)
    is Aave    -> aaveExecutor.execute(request)
    // no else needed — sealed enforces this is exhaustive
}
```

---

### 1.3 Liskov Substitution — CONSIDER

**Goal:** A subtype should be fully substitutable for its base type.

Kotlin makes this mostly a non-issue by design: classes are `final` by default. You must explicitly opt in to subclassing with `open`. In practice, prefer composition over inheritance, and LSP violations rarely arise.

Check for it only when you see `open class` or `abstract class` in the codebase.

**Bad — subclass narrows the contract:**
```kotlin
interface PositionFetcher {
    fun getPosition(tokenId: String): Position  // contract: always returns Position
}

class CachedPositionFetcher : PositionFetcher {
    override fun getPosition(tokenId: String): Position {
        return cache[tokenId] ?: throw NotFoundException("not in cache") // breaks contract
    }
}
```

**Good:** Either return `Position?` in the interface, or make the cache fetcher fall back to the real source.

---

### 1.4 Interface Segregation — SHOULD

**Goal:** Callers should not be forced to depend on methods they don't use.

In Kotlin, a **functional type** is idiomatic for single-method contracts. A `(String) -> Unit` is injectable, mockable, and needs no interface declaration. Use a named interface when the contract has multiple related methods, when you want named documentation on each method, or when multiple implementations need to be distinguishable by type.

**Prefer functional type — single-method dependency, easy to inject and test:**
```kotlin
// Less preferred: interface for one method adds ceremony with no benefit
interface Notifier {
    suspend fun sendAlert(message: String)
}

// Preferred: functional type is equally injectable and mockable
class StrategyScheduler(private val sendAlert: suspend (String) -> Unit) { ... }
// inject: StrategyScheduler(sendAlert = telegram::sendAlert)
// test:   StrategyScheduler(sendAlert = { /* no-op */ })
```

**Prefer interface — multiple related methods, named contract:**
```kotlin
// Here an interface is the right choice: 3 methods, logically grouped
interface ChainClient {
    suspend fun getPosition(tokenId: String): Position
    suspend fun getPoolState(tokenId: String): PoolState
    suspend fun mint(request: MintRequest): MintResult
}
// Tests inject a FakeChainClient; type is self-documenting
```

---

### 1.5 Dependency Inversion — SHOULD

**Goal:** High-level modules should depend on abstractions, not concrete implementations. Dependencies should be injected, not constructed internally.

This goal applies fully in Kotlin. The abstraction does not have to be a named interface — a functional type or a data parameter works equally well for small dependencies.

**Bad — concrete dependency constructed inside the class:**
```kotlin
class StrategyScheduler {
    private val telegram = TelegramNotifier(botToken, chatId) // untestable, unswappable
}
```

**Good — injected functional type (small dependency):**
```kotlin
class StrategyScheduler(private val sendAlert: suspend (String) -> Unit) { ... }
```

**Good — injected interface (large dependency with multiple methods):**
```kotlin
class StrategyScheduler(private val chainClient: ChainClient) { ... }
// ChainClient is an interface; tests inject a FakeChainClient
```

---

### General Design Principles

---

### 1.6 DRY — Don't Repeat Yourself — SHOULD

**Goal:** Every piece of knowledge should have a single authoritative representation.

Duplication means two places to update when the logic changes — and the second place is always the one you forget.

**Bad — same tick-range logic in two places:**
```kotlin
// in UniswapStrategy.kt
val spacing = when (fee) { 100 -> 1; 500 -> 10; 3000 -> 60; else -> 200 }
val tickLower = Math.floorDiv(rawLower, spacing) * spacing

// in Routing.kt — same logic, copy-pasted
val spacing = when (fee) { 100 -> 1; 500 -> 10; 3000 -> 60; else -> 200 }
val tickLower = Math.floorDiv(rawLower, spacing) * spacing
```

**Good — one canonical function:**
```kotlin
// StrategyMath.kt — single source of truth
fun calcTickRange(currentTick: Int, fee: Int, rangePercent: Double): Pair<Int, Int> { ... }

// both callers use it
val (tickLower, tickUpper) = calcTickRange(poolState.tick, req.feeTier, req.rangePercent)
```

**Important caveat — the Rule of Three:** Do not abstract on the first or second occurrence. Wait until you see the same pattern three times and fully understand it. A premature abstraction that doesn't fit all cases is harder to change than the original duplication.

```kotlin
// Two similar DB update blocks is not yet a pattern — wait for the third before abstracting.
// Forcing them into a shared helper with an awkward parameter list is worse than duplication.
```

---

### 1.7 YAGNI — You Aren't Gonna Need It — SHOULD

**Goal:** Do not build for hypothetical future requirements. Build exactly what is needed now.

Speculative abstractions add complexity today for requirements that may never arrive, or may arrive in a different shape than anticipated.

**Bad — generic "multi-exchange" abstraction for a system that only uses Uniswap:**
```kotlin
class ExchangeAdapterFactory {
    fun create(type: ExchangeType, config: ExchangeConfig): ExchangeAdapter = when (type) {
        ExchangeType.UNISWAP -> UniswapAdapter(config)
        ExchangeType.BYBIT   -> TODO() // v3 feature, not needed yet
        ExchangeType.AAVE    -> TODO() // v2 feature, not needed yet
    }
}
```

**Good — implement Uniswap directly; design the interface when v2 starts:**
```kotlin
// v1: no factory, no enum, just the concrete implementation
class UniswapExecutor(private val chainClient: ChainClient) {
    fun rebalance(request: RebalanceRequest): RebalanceResult { ... }
}
// When AAVE is actually being built, extract ProtocolExecutor then.
```

**The rule:** Design interfaces to *accommodate* extension (don't make it impossible), but don't *implement* the extension until it's needed. A well-named function with clear inputs/outputs is easy to wrap in an interface later. An over-engineered abstraction is hard to undo.

---

### 1.8 Fail Fast — MUST

**Goal:** Detect and report errors at the earliest possible point, before bad state propagates deeper into the system.

A wrong value that travels silently through 5 function calls before causing a failure is far harder to debug than an immediate crash with a clear message. This is especially important in financial code — a silent wrong amount is worse than a loud exception.

**Bad — bad input accepted, error surfaces far from the source:**
```kotlin
fun calcTickRange(currentTick: Int, fee: Int, rangePercent: Double): Pair<Int, Int> {
    // if rangePercent is 0.0 or negative, the result is silently wrong
    val rawLower = currentTick + (Math.log(1.0 - rangePercent) / log1_0001).toInt()
    ...
}
```

**Good — validate at the boundary before computing:**
```kotlin
fun calcTickRange(currentTick: Int, fee: Int, rangePercent: Double): Pair<Int, Int> {
    require(rangePercent > 0.0) { "rangePercent must be positive, got $rangePercent" }
    require(rangePercent < 1.0) { "rangePercent must be less than 1.0, got $rangePercent" }
    require(fee in setOf(100, 500, 3000, 10000)) { "Unsupported fee tier: $fee" }
    ...
}
```

**Apply at system boundaries:**
- HTTP request parameters — validate before touching the DB or chain
- Service method inputs — `require()` preconditions at the top of the function
- DB results — fail immediately if a required row is missing rather than returning a default that silently corrupts downstream state

---

### 1.9 Command-Query Separation (CQS) — SHOULD

**Goal:** A function should either change state (command) or return data (query) — never both.

Mixing reads and writes in one function makes call sites hard to reason about: does calling this function have side effects? Can I call it twice safely?

**Bad — one function records a poll tick AND returns updated stats; side effect is invisible at the call site:**
```kotlin
fun recordPollTickAndGetStats(strategyId: Int, inRange: Boolean): StrategyStatsDto {
    // updates totalPollTicks, inRangeTicks in DB  ← command
    // then fetches and returns the updated stats  ← query
}

// At call site — does this have side effects? Unclear.
val stats = strategyService.recordPollTickAndGetStats(strategyId, inRange = true)
```

**Good — separate the write from the read:**
```kotlin
fun recordPollTick(strategyId: Int, inRange: Boolean): Unit { ... }  // command only

fun getStats(strategyId: Int, userId: Int): StrategyStatsDto? { ... }  // query only

// At call site — intent is explicit:
strategyService.recordPollTick(strategyId, inRange = true)
val stats = strategyService.getStats(strategyId, userId)
```

**Pragmatic exceptions:** Functions that both write and return the written value (e.g. `insert { ... } get id`) are acceptable when atomicity is required — fetching after insert would be a second round-trip. Kotlin's `also`, `apply`, and builder patterns also intentionally return `this`. The rule targets logic where the side effect is invisible or surprising, not well-known patterns.

---

### 1.10 Functional Core, Imperative Shell — SHOULD

**Goal:** Push all side effects (DB writes, HTTP calls, Telegram alerts) to the outer shell. Keep the core — calculations, transformations, decisions — as pure functions with no side effects.

Pure functions are trivial to test, trivially composable, and safe to call multiple times. Kotlin makes this natural: pure logic lives as top-level functions; side effects live in service classes.

**Bad — decision logic and side effects tangled together:**
```kotlin
fun recordRebalanceEvent(strategyId: Int, fees0: String, ...) = transaction {
    // 40 lines of BigDecimal math (pure)
    val feesUsd = toUsd(fees0, dec0, ethPriceUsd, ethSideIsToken0)
    val driftPct = (priceAtEnd - priceAtDecision) / priceAtDecision * 100
    // then immediately writes to 3 tables (side effects)
    StrategyEvents.update { ... }
    RebalanceDetails.insert { ... }
    StrategyStats.update { ... }
}
```

**Good — separate pure computation from persistence:**
```kotlin
// Pure core — no DB, no coroutines, fully testable
fun computeRebalanceMetrics(
    fees0: String,
    fees1: String,
    priceAtDecision: BigDecimal,
    priceAtEnd: BigDecimal?,
    ...
): RebalanceMetrics { ... }

// Imperative shell — only persistence, no math
fun persistRebalanceMetrics(strategyId: Int, eventId: Int, metrics: RebalanceMetrics) = transaction {
    StrategyEvents.update { it[status] = "success" }
    RebalanceDetails.insert { ... }
    StrategyStats.update { ... }
}

// Orchestrator — calls both in order
fun recordRebalanceEvent(strategyId: Int, eventId: Int, ...) {
    val metrics = computeRebalanceMetrics(...)
    persistRebalanceMetrics(strategyId, eventId, metrics)
}
```

The pure `computeRebalanceMetrics` function can be unit-tested with no DB setup. The `persistRebalanceMetrics` shell is thin enough that an integration test covers it completely.

---

### 1.11 Composition over Inheritance — SHOULD

**Goal:** Prefer assembling behavior from smaller pieces over inheriting it from a base class.

Kotlin enforces this by making classes `final` by default. It also provides the `by` delegation keyword, which implements composition at the language level with zero boilerplate.

**Bad — inheritance for code reuse, creating tight coupling:**
```kotlin
abstract class BaseStrategy {
    fun calcTickRange(...): Pair<Int, Int> { ... }  // shared utility
    abstract fun shouldRebalance(...): Boolean
}

class UniswapStrategy : BaseStrategy() {
    override fun shouldRebalance(...) = true
}
// UniswapStrategy is now coupled to BaseStrategy's entire surface
```

**Good — compose behavior using delegation and standalone functions:**
```kotlin
// Shared logic is a top-level function — no inheritance needed
fun calcTickRange(currentTick: Int, fee: Int, rangePercent: Double): Pair<Int, Int> { ... }

// Strategy is a simple interface
interface ProtocolStrategy {
    fun shouldRebalance(position: Position, poolState: PoolState): Boolean
}

// UniswapStrategy uses calcTickRange directly and implements only its own logic
class UniswapStrategy : ProtocolStrategy {
    override fun shouldRebalance(position: Position, poolState: PoolState) =
        poolState.tick !in position.tickLower..position.tickUpper
}
```

**Kotlin `by` delegation — compose multiple behaviors without inheritance:**

Plain constructor injection already achieves composition. Use `by` when you want the outer class to *publicly implement* the delegated interface — for example, a decorator that adds behavior while still satisfying the original contract.

```kotlin
interface StrategyRepository {
    fun findById(id: Int): StrategyRecord?
    fun save(record: StrategyRecord): StrategyRecord
}

// Decorator: adds caching, still satisfies StrategyRepository
class CachingStrategyRepository(
    private val inner: StrategyRepository,
) : StrategyRepository by inner {  // delegates all methods to inner by default
    private val cache = mutableMapOf<Int, StrategyRecord>()

    override fun findById(id: Int): StrategyRecord? =  // override just this one
        cache.getOrPut(id) { inner.findById(id) ?: return null }
}
```

**Avoid `by` when the delegated interfaces are internal concerns.** If `Logger` and `Notifier` are private implementation details of `StrategyScheduler`, use constructor injection instead — `by` would expose `log()` and `notify()` as public methods on the scheduler, leaking internal concerns onto the public API.

```kotlin
// Good — internal dependencies stay private
class StrategyScheduler(
    private val logger: Logger,
    private val notifier: Notifier,
) {
    fun tick() {
        logger.log("tick")       // private, not exposed on StrategyScheduler
        notifier.notify("alert")
    }
}
```

---

### 1.12 Law of Demeter — CONSIDER

**Goal:** An object should only talk to its immediate collaborators, not reach through them to access other objects.

A chain like `strategy.stats.fees.token0` means this code knows about three internal structures. Any one of them changing breaks this call site.

**Bad — reaching through the object graph:**
```kotlin
val fees = strategyService.findById(strategyId, userId)?.stats?.feesCollected?.token0
//                                                       ↑ knows about stats  ↑ knows about feesCollected
```

**Good — ask for the thing you actually need:**
```kotlin
val fees = strategyService.getFeesCollected(strategyId, userId)
// one collaborator, one responsibility, one change point
```

**In Kotlin, watch for:** Long `?.` chains on domain objects. Each `?.` step is a Law of Demeter violation and also a sign that a service method is missing.

The rule is a CONSIDER rather than MUST because Kotlin data classes are often used as transparent value containers — `strategy.name`, `position.tickLower` are fine. The law applies to **behavior**, not to reading fields off a plain data object.

---

### Summary: Design goals vs. Kotlin tools

| Goal (SOLID name) | Kotlin's answer |
|---|---|
| Single Responsibility | Top-level functions, extension functions — no class required |
| Open for Extension | `sealed` + `when`, registry pattern, extension functions |
| Liskov Substitution | `final` by default — compose instead, rarely needed |
| Interface Segregation | Functional types `(A) -> B` for single-method contracts |
| Dependency Inversion | Constructor injection + functional types or interfaces |
| DRY | Canonical top-level functions; abstract after 3 occurrences |
| YAGNI | Build what's needed now; design interfaces to accommodate, not implement |
| Fail Fast | `require()` at every system boundary |
| CQS | Separate `query*` / `find*` from `update*` / `record*` |
| Functional Core | Pure `compute*` functions + thin `persist*` shell |
| Composition | `by` delegation, constructor injection — no `open class` |
| Law of Demeter | One-step collaborators; long `?.` chains signal a missing service method |

---

## 2. Kotlin Idioms

### 2.1 Prefer `val` over `var` — MUST

Mutable state is a source of bugs. Use `val` by default; only use `var` when mutation is genuinely required.

**Bad:**
```kotlin
var result: String? = null
result = fetchData()
```

**Good:**
```kotlin
val result = fetchData()
```

---

### 2.2 Use data classes for DTOs — MUST

Data classes give you `equals`, `hashCode`, `copy`, and `toString` for free. Plain classes for DTOs lose all of these.

**Bad:**
```kotlin
class StrategyRecord(val id: Int, val name: String)
```

**Good:**
```kotlin
data class StrategyRecord(val id: Int, val name: String)
```

---

### 2.3 Use `sealed class` / `sealed interface` for exhaustive state — SHOULD

When a value has a fixed set of states, `sealed` forces every `when` branch to be handled.

**Bad:**
```kotlin
const val STATUS_ACTIVE = "ACTIVE"
const val STATUS_STOPPED = "STOPPED"
// Compiler can't enforce exhaustiveness on a String
```

**Good:**
```kotlin
sealed interface StrategyState {
    object Active : StrategyState
    data class Stopped(val reason: String?) : StrategyState
}

// when(state) { ... } without else will fail to compile if a case is missing
```

---

### 2.4 Avoid `!!` (non-null assertion) — MUST

`!!` throws `NullPointerException` with no context. Every `!!` is a bug waiting to happen.

**Bad:**
```kotlin
val userId = call.principal<JWTPrincipal>()!!.payload.getClaim("userId").asInt()
```

**Good:**
```kotlin
val userId = call.principal<JWTPrincipal>()?.payload?.getClaim("userId")?.asInt()
    ?: throw UnauthorizedException("Invalid token")
```

---

### 2.5 Prefer `when` expressions over `if-else` chains — SHOULD

`when` is more readable and enforces exhaustiveness on sealed types.

**Bad:**
```kotlin
val spacing = if (fee == 100) 1 else if (fee == 500) 10 else if (fee == 3000) 60 else 200
```

**Good:**
```kotlin
val spacing = when (fee) {
    100   -> 1
    500   -> 10
    3000  -> 60
    10000 -> 200
    else  -> 60
}
```

---

### 2.6 Use scope functions appropriately — SHOULD

| Function | Receiver | Returns | Use when |
|----------|----------|---------|----------|
| `let`    | `it`     | lambda result | null-safe transform |
| `apply`  | `this`   | receiver | builder pattern / configuration |
| `run`    | `this`   | lambda result | compute something using the receiver |
| `also`   | `it`     | receiver | side effect (logging, assertion) without changing the chain |
| `with`   | `this`   | lambda result | group operations on an object without chaining |

**Bad — `also` used for transformation (confusing intent):**
```kotlin
val result = fetchUser().also { it.name.uppercase() }
```

**Good:**
```kotlin
val upperName = fetchUser().let { it.name.uppercase() }
```

---

## 3. Null Safety

### 3.1 Never return null where an empty collection suffices — SHOULD

**Bad:**
```kotlin
fun getEvents(strategyId: Int): List<EventDto>? // caller must null-check before iterating
```

**Good:**
```kotlin
fun getEvents(strategyId: Int): List<EventDto> = transaction {
    StrategyEvents.selectAll().where { ... }.map { toDto(it) }
} // returns emptyList() when nothing found
```

---

### 3.2 Model absence explicitly with sealed types — CONSIDER

For domain cases where "not found" has different meaning from "error", avoid nulls entirely.

```kotlin
sealed interface LookupResult<out T> {
    data class Found<T>(val value: T) : LookupResult<T>
    object NotFound : LookupResult<Nothing>
    data class Error(val cause: Throwable) : LookupResult<Nothing>
}
```

---

### 3.3 Audit all `?.let { }` chains — SHOULD

A long chain of `?.` operators can silently skip logic when any step is null. Make sure silent null propagation is intentional and the fallback behavior is correct.

**Bad — null poolState silently skips decimal resolution with no log:**
```kotlin
val dec0 = poolState?.decimals0 ?: 18  // 18 is correct for WETH but wrong for other tokens
```

**Good — at minimum log the fallback:**
```kotlin
val dec0 = poolState?.decimals0 ?: run {
    logger.warn("poolState unavailable for strategy $strategyId; falling back to decimals0=18")
    18
}
```

---

## 4. Error Handling

### 4.1 Never swallow exceptions silently — MUST

Silent catches hide bugs and make incidents impossible to diagnose.

**Bad:**
```kotlin
try {
    strategyService.finalizeCloseEvent(...)
} catch (_: Exception) { /* non-fatal */ }
```

**Good — at minimum log it:**
```kotlin
try {
    strategyService.finalizeCloseEvent(...)
} catch (e: Exception) {
    logger.error("finalizeCloseEvent failed for strategy $strategyId", e)
    // still non-fatal, but now observable
}
```

---

### 4.2 Classify exceptions by recoverability — SHOULD

Not all exceptions are equal. Separate network errors (retryable) from contract violations (not retryable).

**Bad — catch-all treats all failures identically:**
```kotlin
} catch (e: Exception) {
    call.respond(HttpStatusCode.InternalServerError, e.message)
}
```

**Good:**
```kotlin
} catch (e: ChainTimeoutException) {
    call.respond(HttpStatusCode.ServiceUnavailable, mapOf("error" to "Chain unavailable, try again"))
} catch (e: IllegalArgumentException) {
    call.respond(HttpStatusCode.BadRequest, mapOf("error" to e.message))
} catch (e: Exception) {
    logger.error("Unexpected error", e)
    call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Internal error"))
}
```

---

### 4.3 Use `runCatching` for expected failure cases — SHOULD

`runCatching` makes the "this can fail" intent explicit and keeps the happy path unindented.

```kotlin
val poolState = runCatching { chainClient.getPoolState(tokenId) }
    .getOrElse { e ->
        logger.warn("Pool state unavailable: ${e.message}")
        return@post call.respond(HttpStatusCode.ServiceUnavailable, ...)
    }
```

---

### 4.4 Map domain exceptions to HTTP status codes in one place — MUST

Don't scatter `HttpStatusCode.BadRequest` responses across route handlers. Use Ktor's `StatusPages` plugin.

**Bad — every route repeats the same mapping:**
```kotlin
} catch (e: UnauthorizedException) {
    call.respond(HttpStatusCode.Unauthorized, ...)
}
```

**Good — one place:**
```kotlin
install(StatusPages) {
    exception<UnauthorizedException> { call, _ -> call.respond(HttpStatusCode.Unauthorized) }
    exception<IllegalArgumentException> { call, e -> call.respond(HttpStatusCode.BadRequest, e.message) }
}
```

---

## 5. Concurrency and Coroutines

### 5.1 Use `suspend` functions for I/O — MUST

Blocking I/O inside a coroutine blocks the thread and starves other coroutines. Use `suspend` + `withContext(Dispatchers.IO)` for blocking calls.

**Bad:**
```kotlin
fun fetchPrice(): Double = URL("https://...").readText().toDouble() // blocks coroutine thread
```

**Good:**
```kotlin
suspend fun fetchPrice(): Double = withContext(Dispatchers.IO) {
    URL("https://...").readText().toDouble()
}
```

---

### 5.2 Avoid shared mutable state across coroutines — MUST

Shared mutable state without synchronization causes data races.

**Bad:**
```kotlin
private val activeStrategies = mutableMapOf<Int, Job>() // accessed from multiple coroutines
```

**Good — use `ConcurrentHashMap` or a `Mutex`:**
```kotlin
private val activeStrategies = java.util.concurrent.ConcurrentHashMap<Int, Job>()
// or
private val mutex = Mutex()
private val activeStrategies = mutableMapOf<Int, Job>()

suspend fun start(id: Int, job: Job) = mutex.withLock { activeStrategies[id] = job }
```

---

### 5.3 Always handle coroutine cancellation — SHOULD

Coroutines can be cancelled at any suspension point. Ensure cleanup runs regardless.

**Bad:**
```kotlin
suspend fun runStrategy(strategy: Strategy) {
    while (true) {
        doWork(strategy)
        delay(strategy.pollIntervalSeconds * 1000)
        // if cancelled during doWork, resources may not be released
    }
}
```

**Good:**
```kotlin
suspend fun runStrategy(strategy: Strategy) {
    try {
        while (isActive) {
            doWork(strategy)
            delay(strategy.pollIntervalSeconds * 1000)
        }
    } finally {
        // always runs, even on cancellation
        releaseResources(strategy)
    }
}
```

---

### 5.4 Use `supervisorScope` for independent child coroutines — SHOULD

In a `coroutineScope`, one failing child cancels all siblings. Use `supervisorScope` when children should be independent.

```kotlin
// Bad: one strategy failure kills all others
coroutineScope {
    strategies.forEach { launch { runStrategy(it) } }
}

// Good: each strategy is independent
supervisorScope {
    strategies.forEach { launch { runStrategy(it) } }
}
```

---

## 6. Data Integrity and Transactions

### 6.1 Every multi-step DB write must be in one transaction — MUST

If a crash occurs between two writes outside a transaction, the database is left in an inconsistent state.

**Bad — two separate transactions; a crash between them leaves an orphaned event:**
```kotlin
fun insertPendingEvent(strategyId: Int): Int = transaction {
    StrategyEvents.insert { ... } get StrategyEvents.id
}

fun updateStrategy(strategyId: Int) = transaction {
    Strategies.update { ... }
}
// caller calls these sequentially — not atomic
```

**Good — one transaction:**
```kotlin
fun insertPendingEventAndUpdateStrategy(strategyId: Int) = transaction {
    val eventId = StrategyEvents.insert { ... } get StrategyEvents.id
    Strategies.update { ... }
    eventId
}
```

---

### 6.2 Insert the intent record before the side effect — MUST

For operations with external side effects (on-chain calls, HTTP calls), persist intent first. This enables recovery after a crash.

```kotlin
// CORRECT ORDER:
val eventId = strategyService.insertPendingCloseEvent(strategyId, idempotencyKey) // persist intent
try {
    chainClient.close(idempotencyKey = idempotencyKey, ...)                        // external side effect
} catch (e: Exception) {
    strategyService.markCloseEventFailed(eventId, e.message)                       // record failure
}
strategyService.finalizeCloseEvent(eventId, ...)                                   // record success
```

---

### 6.3 Make idempotency keys durable — MUST

In-memory idempotency sets are lost on pod restart, creating a window for duplicate execution.

**Bad:**
```kotlin
private val processedKeys = mutableSetOf<String>() // in-memory, lost on restart
```

**Good:**
```kotlin
// Store idempotency key in DB before executing; check DB on each request
fun isAlreadyProcessed(key: String): Boolean = transaction {
    IdempotencyKeys.selectAll().where { IdempotencyKeys.key eq key }.any()
}
```

---

### 6.4 Read-then-write patterns need pessimistic locking — SHOULD

A read followed by a conditional write is a TOCTOU race under concurrent load.

**Bad:**
```kotlin
val activeCount = Strategies.selectAll().where { ... }.count() // read
require(activeCount == 0L) { "Already have active strategy" }  // check
Strategies.insert { ... }                                       // write — race here
```

**Good — use DB-level uniqueness constraint as the final guard:**
```kotlin
// Add: UNIQUE constraint on (userId) WHERE status IN ('ACTIVE','INITIATING')
// Then catch the constraint violation instead of relying solely on the app-level check
try {
    Strategies.insert { ... }
} catch (e: ExposedSQLException) {
    if (e.isUniqueConstraintViolation()) throw IllegalArgumentException("Already have active strategy")
    throw e
}
```

---

## 7. Security

### 7.1 Never interpolate user input into strings sent to external systems — MUST

String interpolation into Telegram messages, SQL, shell commands, or external APIs creates injection vulnerabilities.

**Bad:**
```kotlin
telegram.sendMessage("{\"text\": \"Strategy ${strategy.name} stopped\"}") // name could contain "}"
```

**Good — use serialization:**
```kotlin
@Serializable
data class TelegramMessage(val text: String)

telegram.sendMessage(Json.encodeToString(TelegramMessage("Strategy ${strategy.name} stopped")))
```

---

### 7.2 Sensitive values must not appear in logs — MUST

Wallet phrases, JWT tokens, and private keys must never be logged.

**Bad:**
```kotlin
logger.info("Starting strategy for user $userId with phrase $walletPhrase")
```

**Good:**
```kotlin
logger.info("Starting strategy for user $userId")
// walletPhrase is never mentioned in logs
```

---

### 7.3 Minimize the lifetime of decrypted secrets — SHOULD

Decrypted wallet phrases should be used immediately and not stored in variables that outlive the call.

**Bad:**
```kotlin
val phrase = walletService.getDecryptedPhrase(userId)
// ... 30 lines of business logic ...
chainClient.mint(walletPrivateKey = phrase) // phrase lives too long
```

**Good:**
```kotlin
chainClient.mint(
    walletPrivateKey = walletService.getDecryptedPhrase(userId)
        ?: return@post call.respond(HttpStatusCode.BadRequest, ...)
)
```

---

### 7.4 Always authenticate before authorization — MUST

Authentication (who are you?) must always run before authorization (what can you do?). Never skip `authenticate("jwt")` on protected routes.

```kotlin
authenticate("jwt") {                   // MUST wrap all protected routes
    route("/api/v1") {
        get("/strategies") {
            val userId = call.getUserId() // always inside the auth block
            ...
        }
    }
}
```

---

### 7.5 Validate and bound all user-supplied numeric inputs — SHOULD

**Bad:**
```kotlin
val pollIntervalSeconds: Long = 60 // no upper bound; user could set 1ms and hammer the chain
```

**Good:**
```kotlin
require(req.pollIntervalSeconds in 10..86400) { "pollIntervalSeconds must be between 10 and 86400" }
```

---

## 8. Performance

### 8.1 Filter in SQL, not in Kotlin — MUST

Fetching all rows and filtering in memory causes full table scans.

**Bad:**
```kotlin
strategyService.listForUser(userId)
    .firstOrNull { it.status == StrategyStatus.ACTIVE } // filters entire history in memory
```

**Good:**
```kotlin
fun findActiveForUser(userId: Int): StrategyRecord? = transaction {
    Strategies.selectAll()
        .where { (Strategies.userId eq userId) and (Strategies.status eq StrategyStatus.ACTIVE) }
        .firstOrNull()?.let { rowToRecord(it) }
}
```

---

### 8.2 Add indexes for every column used in WHERE / JOIN — MUST

Queries on unindexed columns become table scans as data grows.

```kotlin
// Tables.kt
object Strategies : Table("strategies") {
    val userId = integer("user_id").index()          // MUST: used in every user query
    val status = varchar("status", 32).index()       // SHOULD: used in active-strategy checks
}
```

---

### 8.3 Avoid N+1 queries — SHOULD

Fetching a list and then querying each item individually multiplies DB round-trips.

**Bad:**
```kotlin
val strategies = strategyService.listForUser(userId)
val stats = strategies.map { strategyService.getStats(it.id, userId) } // N extra queries
```

**Good — join or batch:**
```kotlin
fun listWithStats(userId: Int): List<StrategyWithStats> = transaction {
    (Strategies innerJoin StrategyStats)
        .selectAll()
        .where { Strategies.userId eq userId }
        .map { toStrategyWithStats(it) }
}
```

---

### 8.4 Reuse computed results — SHOULD

Re-fetching data that was already fetched in the same request wastes network and DB time.

**Bad:**
```kotlin
val strategy = strategyService.findById(strategyId, userId)  // fetch 1
val ok = strategyService.stop(strategyId, userId)             // fetch again internally
```

**Good — pass the already-fetched row or use the ownership check result:**
```kotlin
val strategy = strategyService.findById(strategyId, userId)
    ?: return@delete call.respond(HttpStatusCode.NotFound, ...)
// stop() takes the already-verified strategy directly
strategyService.stop(strategy)
```

---

## 9. Financial and Numeric Precision

### 9.1 Never use `Double` for monetary amounts — MUST

Floating-point arithmetic introduces rounding errors that compound over many operations.

**Bad:**
```kotlin
val feesUsd: Double = fees0.toDouble() / 1e18 * ethPrice.toDouble()
```

**Good:**
```kotlin
val feesUsd: java.math.BigDecimal = fees0.toBigDecimal()
    .divide(java.math.BigDecimal.TEN.pow(18), 18, java.math.RoundingMode.HALF_UP)
    .multiply(ethPrice)
    .setScale(2, java.math.RoundingMode.HALF_UP)
```

---

### 9.2 Always specify scale and rounding mode on division — MUST

`BigDecimal.divide()` without a scale throws `ArithmeticException` on non-terminating decimals.

**Bad:**
```kotlin
val human = rawAmount.toBigDecimal().divide(BigDecimal.TEN.pow(decimals)) // crashes on 1/3
```

**Good:**
```kotlin
val human = rawAmount.toBigDecimal()
    .divide(BigDecimal.TEN.pow(decimals), decimals, RoundingMode.HALF_UP)
```

---

### 9.3 Construct BigDecimal from String, not Double — MUST

`BigDecimal(0.1)` is `0.1000000000000000055511151231257827021181583404541015625`. `BigDecimal("0.1")` is exactly `0.1`.

**Bad:**
```kotlin
val price = BigDecimal(ethPrice) // ethPrice is a Double — precision lost at construction
```

**Good:**
```kotlin
val price = BigDecimal(ethPrice.toString()).setScale(8, RoundingMode.HALF_UP)
```

---

### 9.4 Store raw token amounts as strings in the DB — MUST

`Long` overflows at ~9.2 × 10^18. A WETH amount in wei can exceed this. Store as `TEXT` / `VARCHAR` and parse to `BigInteger` in application code.

```kotlin
// Tables.kt
val feesCollectedToken0 = varchar("fees_collected_token0", 78).default("0") // 78 chars covers uint256

// Application code
val fees = row[StrategyStats.feesCollectedToken0].toBigIntegerOrNull() ?: BigInteger.ZERO
```

---

### 9.5 Use `coerceAtLeast(ZERO)` when subtracting unsigned values — SHOULD

Token amounts are logically non-negative. Subtraction can produce negative results if data is inconsistent.

```kotlin
val netPrincipal = (positionStart.toBigIntegerOrNull() ?: BigInteger.ZERO)
    .subtract(fees.toBigIntegerOrNull() ?: BigInteger.ZERO)
    .coerceAtLeast(BigInteger.ZERO)
```

---

## 10. Testability

### 10.1 Pure functions must have unit tests — MUST

Functions with no side effects are trivial to test and high-value to cover. Any financial calculation function is a priority.

```kotlin
// StrategyMath.kt — pure, no DB, no coroutines: easy to test
@Test
fun `calcTickRange produces range wider than rangePercent`() {
    val (lower, upper) = calcTickRange(currentTick = 200_000, fee = 3000, rangePercent = 0.05)
    assertTrue(upper - lower > 0)
    // verify alignment to tick spacing
    assertEquals(0, lower % 60)
    assertEquals(0, upper % 60)
}
```

---

### 10.2 Service classes should depend on interfaces, not concrete DB tables — SHOULD

Services that call Exposed DSL directly are impossible to unit test without a real DB. Extract a repository interface.

```kotlin
interface StrategyRepository {
    fun findById(id: Int, userId: Int): StrategyRecord?
    fun save(record: StrategyRecord): StrategyRecord
}

// In tests:
class FakeStrategyRepository : StrategyRepository {
    private val store = mutableMapOf<Int, StrategyRecord>()
    override fun findById(id: Int, userId: Int) = store[id]?.takeIf { it.userId == userId }
    override fun save(record: StrategyRecord) = record.also { store[it.id] = it }
}
```

---

### 10.3 Integration tests must use a real DB — MUST

Mocked DB tests pass when schema-level constraints would reject the same call in production.

```kotlin
// Use Testcontainers to spin up a real PostgreSQL instance
@Container
val postgres = PostgreSQLContainer("postgres:16")

@BeforeEach
fun setUp() {
    Database.connect(postgres.jdbcUrl, user = postgres.username, password = postgres.password)
    transaction { SchemaUtils.create(Strategies, StrategyEvents) }
}
```

---

### 10.4 Test idempotency explicitly — MUST

Any operation with an idempotency key must have a test that calls it twice and verifies the second call is a no-op.

```kotlin
@Test
fun `duplicate close event with same key is rejected`() {
    val key = UUID.randomUUID().toString()
    chainClient.close(idempotencyKey = key, ...)
    val result = chainClient.close(idempotencyKey = key, ...) // second call
    assertTrue(result.alreadyProcessed)
}
```

---

## 11. Observability

### 11.1 Use structured logging with context — SHOULD

Plain string messages are hard to filter in log aggregators. Include strategyId, userId, and action.

**Bad:**
```kotlin
println("Rebalance done")
```

**Good:**
```kotlin
logger.info("rebalance.completed", mapOf(
    "strategyId" to strategyId,
    "userId" to userId,
    "gasWei" to totalGasWei,
    "feesUsd" to feesUsdNew,
))
```

---

### 11.2 Log at the right level — SHOULD

| Level | When |
|-------|------|
| `ERROR` | Unexpected failure; human action may be required |
| `WARN` | Degraded behavior with a fallback; non-fatal but notable |
| `INFO` | Normal significant events (strategy started, rebalance completed) |
| `DEBUG` | Internal state useful for diagnosing; off in production |

---

### 11.3 Every alert must include enough context to act on — MUST

Telegram or other alerts should answer: what failed, which entity, what to check next.

**Bad:**
```kotlin
telegram.sendAlert("Close failed.")
```

**Good:**
```kotlin
telegram.sendAlert(
    "Strategy <b>${strategy.name}</b> (id=${strategy.id}) close FAILED: ${e.message}. " +
    "Position #${strategy.currentTokenId} may still be open on-chain."
)
```

---

## 12. Readability

### 12.1 Name constants, never embed magic values — MUST

**Bad:**
```kotlin
if (dec0 == 18) { ... } // what does 18 mean? why 18?
```

**Good:**
```kotlin
private const val WETH_DECIMALS = 18
private const val USDC_DECIMALS = 6

val ethSideIsToken0 = dec0 == WETH_DECIMALS
```

---

### 12.2 Comment the "why", not the "what" — SHOULD

Code describes what happens. Comments explain why it happens — the invariant, the edge case, the business rule.

**Bad:**
```kotlin
// add 1 to tickUpper
val tickUpper = (Math.floorDiv(rawUpper, spacing) + 1) * spacing
```

**Good:**
```kotlin
// +1 ensures the range is wider than the raw log result — without it, a freshly minted
// position can appear out-of-range on the very first scheduler tick due to rounding.
val tickUpper = (Math.floorDiv(rawUpper, spacing) + 1) * spacing
```

---

### 12.3 Keep functions short and linear — SHOULD

Functions with multiple early returns and nested `try/catch` are hard to follow. Extract named helpers for each logical step.

**Bad — 3 nested try/catch, inline math, multiple concerns:**
```kotlin
post("/strategies/start") {
    val userId = call.getUserId()
    val phrase = walletService.getDecryptedPhrase(userId)
        ?: return@post call.respond(...)
    val req = call.receive<StartStrategyRequestDto>()
    val poolState = try { chainClient.getPoolByPair(...) } catch (e: Exception) { return@post ... }
    val (tickLower, tickUpper) = calcTickRange(...)
    val mintResult = try { chainClient.mint(...) } catch (e: Exception) { return@post ... }
    // ... 60 more lines
}
```

**Good — linear, each step named:**
```kotlin
post("/strategies/start") {
    val userId = call.getUserId()
    val req = call.receive<StartStrategyRequestDto>()
    val result = strategyService.startStrategy(userId, req)
    call.respond(HttpStatusCode.Created, result)
}
```

---

### 12.4 Align related assignments visually — CONSIDER

For dense configuration blocks, vertical alignment helps the eye scan column-by-column.

```kotlin
it[RebalanceDetails.swapCostAmountIn]      = swapCost?.amountIn
it[RebalanceDetails.swapCostAmountOut]     = swapCost?.amountOut
it[RebalanceDetails.swapCostFairAmountOut] = swapCost?.fairAmountOut
it[RebalanceDetails.swapCostDirection]     = swapCost?.direction
```

---

## 13. AI Maintainability

### 13.1 Write intention-revealing method names — MUST

An AI reading a method name should be able to predict its contract without reading the body.

**Bad:**
```kotlin
fun handleEvent(id: Int, key: String): Int   // what kind of event? what does Int mean?
```

**Good:**
```kotlin
fun insertPendingCloseEvent(strategyId: Int, idempotencyKey: String): Int  // clear: inserts, pending, returns event id
```

---

### 13.2 Keep methods under ~50 lines — MUST for AI

An AI editing a 150-line method must hold the entire method in context before touching any part of it. Short methods are safe to edit locally.

- If a method is long, extract private helpers with descriptive names.
- Each helper should do one computable thing: `computeSwapCostUsd(...)`, `computePriceDrift(...)`.

---

### 13.3 Document non-obvious invariants inline — MUST

Business rules that aren't derivable from the type system must be written as comments. An AI that doesn't know the invariant will break it.

```kotlin
// ethSideIsToken0 assumes the pool is WETH/USDC with WETH as token0.
// For a USDC/WETH pool (token0=USDC), this must be false.
// This value is computed once per strategy and passed through; do not re-derive it
// from decimals alone — decimals are not unique to WETH.
val ethSideIsToken0 = dec0 == WETH_DECIMALS
```

---

### 13.4 Separate computation from persistence — SHOULD

Functions that mix math with DB writes are hard for an AI to modify without breaking something. Extract a `compute*` function that returns a plain data object, then a `persist*` function that writes it.

See [1.10 Functional Core, Imperative Shell](#110-functional-core-imperative-shell--should) for the full pattern and example. The same rule applies here: pure `compute*` functions are safe for an AI to edit independently of the `persist*` shell.

---

### 13.5 Put related code in one file — SHOULD

An AI asked to modify a feature should find all related code in one place, not scattered across five files.

- DTOs, service methods, and constants for a single domain concept should live in the same file or package.
- Avoid utility files that grow into grab-bags (`Utils.kt`, `Helpers.kt`).

---

### 13.6 CLAUDE.md is part of the codebase — MUST

Keep `CLAUDE.md` and `BEST_PRACTICES.md` in sync with the code. Stale documentation misleads AI more than no documentation — it confidently suggests wrong approaches.

- When you add a new pattern, add a rule.
- When you remove a pattern, remove its rule.
- When a known issue is resolved, remove it from the TODO list.
