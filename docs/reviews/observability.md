# Observability Review Playbook

> Audit playbook for logs, correlation IDs, metrics, and alerts. Observability is what tells you *what just happened* during an incident.

**Scope:**
- Structured logging across `apps/api`, `apps/chain`, `apps/web`
- Correlation IDs (`X-Request-Id`) end-to-end
- Telegram alerts ([`apps/api/src/main/kotlin/fi/lagrange/services/TelegramNotifier.kt`](../../apps/api/src/main/kotlin/fi/lagrange/services/TelegramNotifier.kt))
- Metrics (Prometheus / OpenTelemetry — currently absent)
- k8s log collection and dashboards

**Sister playbooks:** [`security.md §9`](security.md) for log hygiene (no secrets in logs), [`api-style.md §8`](api-style.md) for SLF4J usage in services, [`infrastructure.md`](infrastructure.md) for log collection wiring.

**Reference:** [`BEST_PRACTICES.md §1.5 Observability`](../BEST_PRACTICES.md), [`CLAUDE.md "Alerting"`](../../CLAUDE.md).

---

## 1. Structured logs

### Audit questions

- [ ] Every service uses a real logger (SLF4J in api, Fastify's `request.log` in chain, no `console.log` in either except boot banners)?
- [ ] Logs are JSON or `key=value` pairs — not concatenated strings that humans skim and machines can't parse?
- [ ] Each log line includes: timestamp, level, logger name, message, plus a context map (no raw `printStackTrace` to stdout)?
- [ ] No PII or secret material in any log line — confirmed by grep, not just by intent (cross-link to [`security.md §9`](security.md))?
- [ ] `logback.xml` (or equivalent) committed and pinning the production format and level — currently **no `logback.xml` in repo**, default Logback patterns in use. Flag.
- [ ] No `level: TRACE` or `DEBUG` shipping to production by default?

### How to inspect

```bash
# Logger usage
git grep -nE 'LoggerFactory\.getLogger\(' apps/api/src
git grep -nE 'request\.log\.|server\.log\.|reply\.log\.' apps/chain/src

# console.log outside boot
git grep -nE '\bconsole\.(log|error|warn|info)\b' apps/chain/src apps/api/src

# Logback config
ls apps/api/src/main/resources/logback*.xml 2>/dev/null
git grep -nE 'level\s*=' apps/api/src/main/resources

# String concatenation in log calls
git grep -nE 'log\.(info|warn|error|debug)\("[^"]*\$\{?[a-zA-Z]' apps/api/src
```

### Red flags

- A `log.info("strategy ${strategy} started")` with `strategy.toString()` containing the wallet phrase via auto-generated data-class `toString()`.
- A free-form log message that future tooling cannot parse: `"Things happened: ${result}, ${error}"` — JSON beats prose.
- A debug-level statement still emitting in production because the default Logback level is DEBUG.

### Reference
[`BEST_PRACTICES.md §1.5`](../BEST_PRACTICES.md), [`security.md §9`](security.md).

---

## 2. Correlation IDs end-to-end

A rebalance touches: `StrategyScheduler` → `UniswapStrategy.execute` → `ChainClient.rebalance` (HTTP) → chain `routes/execute.ts` → `services/rebalance.ts` → on-chain. Without a single id flowing through, an incident requires manual log-stitching.

### Audit questions

- [ ] api generates a `requestId` (UUID v4) at the start of each rebalance cycle?
- [ ] api sends `X-Request-Id` as an HTTP header on every `chain` call? **Open TODO `ChainClient.kt`** ([`BEST_PRACTICES.md §1.5`](../BEST_PRACTICES.md)) — verify whether forwarding has been added.
- [ ] chain reads the header and includes it on every log line for that request (Fastify supports `requestIdHeader: 'x-request-id'` in its config)?
- [ ] api logs always include the `requestId` for that cycle (using SLF4J MDC or a structured-log context)?
- [ ] The `requestId` is also stored as `strategy_events.idempotency_key`? **Or** is there a separate `requestId` column? Document the relationship.
- [ ] Telegram alerts include the `requestId` (or idempotency key) — so an operator can copy-paste it into a log query?

### How to inspect

```bash
# api side: requestId generation
git grep -nE 'requestId|UUID\.randomUUID' apps/api/src/main/kotlin/fi/lagrange/strategy

# api → chain header forwarding
git grep -nE 'X-Request-Id|x-request-id|setHeader.*Request' apps/api/src

# chain side: read header, include in logs
git grep -nE 'requestIdHeader|X-Request-Id|x-request-id' apps/chain/src

# Telegram messages with id
git grep -nE 'idempotency|requestId' apps/api/src/main/kotlin/fi/lagrange/services/TelegramNotifier.kt
```

### Red flags

- A `requestId` declared in api but never sent on the wire — chain can't correlate.
- Chain ignores the header and uses Fastify's auto-generated `req.id` — different namespace, two ids per request.
- A Telegram alert that says "rebalance failed" with no id — which strategy, which run?

### Reference
[`BEST_PRACTICES.md §1.5`](../BEST_PRACTICES.md), [`ChainClient.kt`](../../apps/api/src/main/kotlin/fi/lagrange/services/ChainClient.kt).

---

## 3. Required log fields per cycle

### Audit questions

- [ ] Every rebalance cycle logs (somewhere, ideally as one structured event) the following minimum fields per [`BEST_PRACTICES.md §1.5`](../BEST_PRACTICES.md):
  - `strategyId`
  - `tickLower`, `tickUpper`, `currentTick`
  - `outcome` (skipped / executed / failed)
- [ ] Plus, ideally: `requestId`, `feesCollectedUsd`, `gasCostUsd`, `swapCostUsd`, `priceDriftPct`, `durationMs`?
- [ ] Every HTTP request to chain logs: `method`, `path`, `statusCode`, `durationMs`?
- [ ] Failure logs include the **stack trace** (not just `e.message`) for the failure category, plus a category tag (`rpc-timeout`, `swap-revert`, `nonce-collision`, `db-error`)?
- [ ] No log line over ~4 KB — large blobs (full receipts, full request bodies) referenced by id, not inlined?

### How to inspect

```bash
# Find rebalance cycle logging
git grep -nE 'log\.(info|warn|error|debug)' apps/api/src/main/kotlin/fi/lagrange/strategy/UniswapStrategy.kt apps/api/src/main/kotlin/fi/lagrange/strategy/StrategyScheduler.kt

# Required-field coverage
git grep -nE 'strategyId|tickLower|currentTick|outcome' apps/api/src/main/kotlin/fi/lagrange/strategy

# Stack trace use
git grep -nE 'log\.error\(.*,\s*e\)|log\.error\(.*Exception' apps/api/src
```

### Red flags

- A rebalance cycle that logs only on success (no log line on the skip-because-in-range path).
- An error log without `e` as a second arg — stack trace lost.
- A massive log line containing a full Ethereum transaction receipt as JSON — log a tx hash instead.

### Reference
[`BEST_PRACTICES.md §1.5`](../BEST_PRACTICES.md). [`UniswapStrategy.kt`](../../apps/api/src/main/kotlin/fi/lagrange/strategy/UniswapStrategy.kt).

---

## 4. Metrics — currently absent

[`BEST_PRACTICES.md §1.5 (SHOULD)`](../BEST_PRACTICES.md): "Emit Prometheus metrics from `api/` and `chain/`". At the time of this playbook, **no metrics are emitted**.

### Audit questions

- [ ] At minimum, the api exports counters for: total rebalances, rebalance success, rebalance failure, active strategies, time-in-range avg?
- [ ] api exports gauges for: chain client response latency, scheduler-loop duration?
- [ ] chain exports counters for: total `/execute/rebalance` calls, success / fail, idempotency-key duplicate count, swap reverts, RPC errors?
- [ ] chain exports a histogram of `gasUsedWei` per action?
- [ ] Pod specs in `k8s/base/` annotated with `prometheus.io/scrape: "true"` and `prometheus.io/port`?
- [ ] If Prometheus is not yet in the cluster, is there a documented next step (managed solution, kube-prometheus-stack chart)?

### How to inspect

```bash
git grep -niE 'prometheus|micrometer|opentelemetry|Counter\.builder|registerCounter' apps/
git grep -nE 'prometheus\.io/scrape' k8s/
```

### Red flags

- A "we don't need metrics yet" stance after the first incident — flag in retrospective.
- Metrics that scrape `WALLET_ENCRYPTION_KEY` env into a label (defensive coding: never use env contents as label values).
- High-cardinality labels (e.g. `userId` as a label) — Prometheus tcost.

### Reference
[`BEST_PRACTICES.md §1.5 (SHOULD)`](../BEST_PRACTICES.md).

---

## 5. Telegram alerts

[`apps/api/src/main/kotlin/fi/lagrange/services/TelegramNotifier.kt`](../../apps/api/src/main/kotlin/fi/lagrange/services/TelegramNotifier.kt) is the only outbound alert channel. Any condition not surfaced here is invisible until a user reports it.

### Audit questions

- [ ] Per [`CLAUDE.md "Alerting"`](../../CLAUDE.md), alerts fire for:
  - [x] Rebalance executed (success) — per strategy name
  - [x] Rebalance failed (with reason) — per strategy name
  - [x] Strategy execution error (unhandled exception)
  - [x] Bot crash / pod restart
  - [ ] (v2) AAVE health factor below warning threshold
  - [ ] (v2) Emergency close triggered
- [ ] Alert text includes:
  - Strategy name and id
  - `requestId` or idempotency key (so it can be looked up in logs)
  - Error category tag (machine-parseable: `[rpc-timeout]`, `[swap-revert]`)
  - For successes: position state delta (rebalances, fees collected, gas cost)
- [ ] No wallet phrase, no private key, no JWT in any alert message (cross-link to [`security.md §9`](security.md))?
- [ ] Alerts are throttled — a strategy that's failing every 60s should produce one rolled-up alert per N minutes, not 60 alerts per hour?
- [ ] Telegram errors (`sendAlert` failure to reach Telegram) are **logged but not silently dropped** — TelegramNotifier currently catches and logs; verify the log goes somewhere actionable.
- [ ] If `botToken` is unset, `sendAlert` logs a warning ([`TelegramNotifier.kt:25`](../../apps/api/src/main/kotlin/fi/lagrange/services/TelegramNotifier.kt) — yes) — is there an external check that catches "Telegram has been silently disabled in production"?

### How to inspect

```bash
# Alert call sites
git grep -nE 'telegramNotifier\.|TelegramNotifier|\.sendAlert' apps/api/src

# Alert text content
git grep -nE 'sendAlert\(' apps/api/src

# Throttling logic
git grep -niE 'throttl|rateLimit|cooldown' apps/api/src/main/kotlin/fi/lagrange/services
```

### Red flags

- Alert fires once per **poll tick** (so a stuck strategy spams chat) — DoS against your own attention.
- `sendAlert("Strategy ${strategy} error: ${e}")` — `${strategy}` is a data class, `toString()` includes the phrase.
- An alert pipeline pointing at a personal Telegram chat instead of a team channel.
- A new failure class added in `services/` without a corresponding `sendAlert` call — silently broken.

### Reference
[`CLAUDE.md "Alerting"`](../../CLAUDE.md), [`security.md §9`](security.md).

---

## 6. Health checks and probes

### Audit questions

- [ ] api exposes `/health` (currently does — [`Routing.kt:64-66`](../../apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt))?
- [ ] chain exposes `/health` (currently does — [`server.ts:19`](../../apps/chain/src/server.ts))?
- [ ] `readinessProbe` in k8s manifests points at `/health` for both?
- [ ] `livenessProbe` distinct from `readiness` (liveness should not fail on transient external dep issues, only on actual process problems)?
- [ ] Health checks include a real dependency check — e.g. api `/health` performs a `SELECT 1` against Postgres so a broken DB is visible without waiting for a request?
- [ ] Chain `/health` performs an RPC ping (`getBlockNumber`)?

### How to inspect

```bash
# Health endpoint definitions
git grep -nE 'get\("/health"|server\.get\(.*"/health"' apps/api/src apps/chain/src

# Probe configs in k8s
git grep -rn 'livenessProbe\|readinessProbe' k8s/
```

### Red flags

- `/health` returns "ok" while DB is unreachable — pod stays in service, every request 5xxs.
- `livenessProbe.failureThreshold: 1` — single transient failure restarts the pod.
- `readinessProbe.initialDelaySeconds: 0` and `httpGet.path: /` — the root path returns 404 while routing is still loading.

### Reference
[`Routing.kt`](../../apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt), [`server.ts`](../../apps/chain/src/server.ts), [`infrastructure.md`](infrastructure.md).

---

## 7. Frontend observability

### Audit questions

- [ ] Frontend errors caught by a top-level error boundary, surfaced in the UI, and (eventually) sent to a collection endpoint?
- [ ] No `console.log` in production bundles ([`frontend-style.md §10`](frontend-style.md))?
- [ ] Failed API calls visible to the user (not silent), and surfaced to the dev via the browser network tab — no request body bloat that obscures real responses?
- [ ] Web Vitals or a similar metric exists at least informally?

### How to inspect

```bash
git grep -nE 'ErrorBoundary|componentDidCatch|getDerivedStateFromError' apps/web/src
git grep -nE 'console\.(log|warn|error)' apps/web/src
```

### Red flags

- React 19 error overlay only — production users see white screen.
- No global rejection handler (`window.addEventListener('unhandledrejection', ...)`).

### Reference
[`frontend-style.md`](frontend-style.md).

---

## 8. Log collection and dashboards

### Audit questions

- [ ] Cluster log collection (Loki / EFK / managed equivalent) wired in test and prod?
- [ ] Operators have at least one saved query / dashboard for: rebalance latency, error rate, Telegram alert volume?
- [ ] Logs retained at least 30 days in prod?
- [ ] No log forwarding to a third-party system that isn't security-reviewed?

### How to inspect

```bash
git grep -rn 'fluentbit\|fluentd\|loki\|promtail\|vector\.dev' k8s/
ls docs/runbooks 2>/dev/null
```

### Red flags

- Logs land in pod stdout and are gone when the pod restarts — only `kubectl logs --previous` saves you (and only for one prior).
- Dashboards exist but no one knows the URL.

### Reference
[`infrastructure.md`](infrastructure.md).

---

## How to run this review

1. **Open a fresh Claude Code session.**
2. Walk top-to-bottom through sections 1 → 8. Run inspection commands. Paste output as evidence.
3. Mark **yes / no / partial** with file:line citations.
4. Tag findings:
   - **[critical]** an incident class would currently produce no signal at all (e.g. all swap reverts go unalerted; `/health` returns ok while DB down).
   - **[high]** known SHOULDs that have not progressed (no Prometheus, no `requestId` propagation).
   - **[medium]** missing alert categories, missing log fields, missing dashboards.
   - **[low]** style: log-format inconsistencies, alert prefix typos.
5. After the review, simulate an incident on paper: imagine the bot stops rebalancing at 03:00. Walk forward through the available signals. If you cannot reconstruct what happened from logs/alerts/metrics, identify the gap.
6. Recurring TODOs to track each pass:
   - Logback config not committed (§1).
   - `requestId` propagation (§2) — open TODO in `BEST_PRACTICES.md §1.5`.
   - Prometheus metrics (§4).
   - Alert throttling (§5).
   - Real-dependency `/health` checks (§6).

A typical pass takes **30-45 minutes**.
