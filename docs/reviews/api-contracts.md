# API Contracts Review Playbook

> Audit playbook for the three contract boundaries:
> 1. `web ↔ api` — REST + JWT, types in [`apps/web/src/types.ts`](../../apps/web/src/types.ts) and Kotlin DTOs.
> 2. `api ↔ chain` — REST, types in [`packages/shared/src/index.ts`](../../packages/shared/src/index.ts) and Kotlin DTOs in [`ChainClient.kt`](../../apps/api/src/main/kotlin/fi/lagrange/services/ChainClient.kt).
> 3. `packages/shared` — the single TypeScript module that both `web` and `chain` import.

**Sister playbooks:** [`api-style.md §9`](api-style.md) for serialisation discipline; [`chain-style.md §7`](chain-style.md) for OpenAPI; [`frontend-style.md §4`](frontend-style.md) for type-safety in web.

**Reference:** [`BEST_PRACTICES.md §3.6 OpenAPI Contract`](../BEST_PRACTICES.md), [`§4.4 Type Safety`](../BEST_PRACTICES.md), [`§5 packages/shared`](../BEST_PRACTICES.md), [`CLAUDE.md "API endpoints"`](../../CLAUDE.md).

---

## 1. OpenAPI spec for `api ↔ chain`

[`BEST_PRACTICES.md §3.6 (MUST)`](../BEST_PRACTICES.md): "The OpenAPI spec at `apps/chain/openapi.yaml` must exist and be kept up to date."

**Current state:** `apps/chain/openapi.yaml` does **not exist**. This is the single largest contract gap.

### Audit questions

- [ ] `apps/chain/openapi.yaml` exists in the repo?
- [ ] Every Fastify route in [`apps/chain/src/routes/`](../../apps/chain/src/routes/) is represented in the spec, with request/response schemas?
- [ ] Error response shapes (`{ error: string, idempotencyKey?: string }`, `{ success: false, error: string }`) documented?
- [ ] Spec linted in CI (`@redocly/cli lint` or `openapi-validator`)?
- [ ] PRs that add a new chain route also add to the spec — enforced via CI check that spec covers all routes?
- [ ] `@fastify/swagger` ([`apps/chain/package.json:18`](../../apps/chain/package.json)) wired to serve the spec at `/docs` in dev?
- [ ] Kotlin client (`ChainClient.kt`) DTOs match the spec — same fields, same nullability, same types?

### How to inspect

```bash
ls apps/chain/openapi.yaml 2>/dev/null && echo "exists" || echo "MISSING"

# Routes in code
grep -rE "server\.(get|post|put|delete|patch)" apps/chain/src/routes

# Kotlin client DTOs
grep -E '@Serializable|data class' apps/api/src/main/kotlin/fi/lagrange/services/ChainClient.kt | head -30

# Spec lint in CI
git grep -niE 'redocly|openapi-validator|spectral' .github/workflows/
```

### Red flags

- `openapi.yaml` missing entirely — every contract change is a manual diff exercise across two repos.
- A route in `routes/` not in the spec — `chain` is forgiving; `api` may rely on a returned field that doesn't exist.
- Spec drifts after a refactor — verify on each PR touching `routes/` or `services/` (or `packages/shared`).
- `@fastify/swagger` listed as dep but no server-side wiring.

### Reference
[`BEST_PRACTICES.md §3.6`](../BEST_PRACTICES.md), [`chain-style.md §7`](chain-style.md). [`apps/chain/src/routes/`](../../apps/chain/src/routes/).

---

## 2. `packages/shared` as the source of TS types

[`packages/shared/src/index.ts`](../../packages/shared/src/index.ts) holds the TypeScript types used by both `chain` (Fastify route bodies) and `web` (frontend interfaces). Per [`BEST_PRACTICES.md §5`](../BEST_PRACTICES.md), this is the canonical contract for TypeScript consumers.

### Audit questions

- [ ] `packages/shared/src/index.ts` exists and exports all types used across services?
- [ ] `apps/chain/src/**` imports types from `@lagrangefi/shared`, never re-declares them locally?
- [ ] `apps/web/src/**` imports types from `@lagrangefi/shared` for any cross-service type — currently [`apps/web/src/types.ts`](../../apps/web/src/types.ts) **redeclares** types like `Position`, `PoolState`, `Strategy`. Verify whether this is intentional drift or a bug.
- [ ] Workspace dependency `"@lagrangefi/shared": "*"` in both `chain` and `web` `package.json`?
- [ ] Shared types changes are backward-compatible (no surprise required field added) or properly version-coordinated?
- [ ] Status enum values (`StrategyStatus`) are defined in `packages/shared` once — currently web has `INITIATING | ACTIVE | STOPPED_MANUALLY | STOPPED_ON_ERROR` ([`apps/web/src/types.ts:24`](../../apps/web/src/types.ts)) while shared/api may use different values? Cross-link to [`frontend-style.md §4`](frontend-style.md).

### How to inspect

```bash
sed -n '1,$p' packages/shared/src/index.ts | head -60

# chain imports from shared
git grep -nE "from '@lagrangefi/shared'" apps/chain/src

# web imports from shared (suspect: should pull at least Position, Strategy, etc.)
git grep -nE "from '@lagrangefi/shared'" apps/web/src

# Type duplication: same name in shared and web/types.ts
diff \
  <(grep -E '^export interface ' packages/shared/src/index.ts | awk '{print $3}' | sort) \
  <(grep -E '^export interface ' apps/web/src/types.ts | awk '{print $3}' | sort)
```

### Red flags

- A type re-declared in `apps/web/src/types.ts` that drifts from `packages/shared/src/index.ts` — the frontend silently parses a different schema than what the api sends.
- Optional vs required field mismatch: `web/types.ts` says `amount0: string` while `shared/index.ts` says `amount0?: string` — runtime undefined sneaks through.
- A new field in `shared` that breaks chain build (no `?` modifier and old data flowing in).

### Reference
[`BEST_PRACTICES.md §5 packages/shared`](../BEST_PRACTICES.md), [`frontend-style.md §4`](frontend-style.md). [`packages/shared/src/index.ts`](../../packages/shared/src/index.ts).

---

## 3. `web ↔ api` REST contract

There is no formal contract document for the `web ↔ api` boundary — it lives implicitly in [`apps/web/src/api.ts`](../../apps/web/src/api.ts) on one side and [`apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt`](../../apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt) on the other. Path drift between the two is the most common source of "frontend works in dev, breaks against real api" bugs.

### Audit questions

- [ ] Every `apiFetch('/...', ...)` URL in [`api.ts`](../../apps/web/src/api.ts) maps to a route in `Routing.kt` or `AuthRoutes.kt`?
- [ ] HTTP method matches (`GET` vs `POST` vs `PATCH` vs `DELETE`)?
- [ ] Request body shape matches the Kotlin `@Serializable` DTO?
- [ ] Response shape declared as a TypeScript generic on `apiFetch<T>` matches the Kotlin DTO?
- [ ] Error response shape consistent: `{ "error": "..." }` from api, parsed as `body.error` in [`api.ts:45,49`](../../apps/web/src/api.ts) — yes?
- [ ] `Authorization: Bearer ${token}` set on every protected route ([`api.ts:24-27`](../../apps/web/src/api.ts))?
- [ ] No web call hardcodes a path that has been renamed in api (e.g. `apiFetch('/api/v1/strategies/start')` while api now exposes `POST /api/v1/strategies`)?
- [ ] api endpoint listed in [`CLAUDE.md "API endpoints"`](../../CLAUDE.md) matches reality?

### How to inspect

```bash
# All web → api URLs
grep -nE "apiFetch\(['\"]" apps/web/src/api.ts | sort -u

# All api routes (Ktor)
grep -nE 'route\(\"|get\(\"|post\(\"|put\(\"|delete\(\"|patch\(\"' apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt apps/api/src/main/kotlin/fi/lagrange/auth/AuthRoutes.kt

# Mismatches: a URL in web that doesn't appear in any Kotlin route
for url in $(grep -oE "apiFetch\(['\"][/a-zA-Z0-9_-]+" apps/web/src/api.ts | sed "s/apiFetch(['\"]//"); do
  if ! grep -q "\"$url" apps/api/src/main/kotlin/fi/lagrange; then echo "ORPHAN: $url"; fi
done
```

### Red flags

- `apiFetch('/api/v1/strategies/start')` in web ([`api.ts:117`](../../apps/web/src/api.ts)) vs a Kotlin handler at `/api/v1/strategies/start` (does it exist?) — verify.
- A web call to a route that exists but expects a different body shape — the api returns 400 with the field name; the user sees "Internal error".
- A web call against a route the api fixed weeks ago in a refactor; auth integration test never caught it because the test stubs `apiFetch` itself.
- `CLAUDE.md "API endpoints"` listing missing-or-extra routes vs reality.

### Reference
[`CLAUDE.md`](../../CLAUDE.md), [`apps/web/src/api.ts`](../../apps/web/src/api.ts), [`Routing.kt`](../../apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt), [`AuthRoutes.kt`](../../apps/api/src/main/kotlin/fi/lagrange/auth/AuthRoutes.kt).

---

## 4. JWT contract

### Audit questions

- [ ] Token format: `Authorization: Bearer <jwt>`. No cookie, no custom header?
- [ ] Token claims: `userId: Int`, `username: String`, `iss: lagrangefi`, `aud: lagrangefi-web`, `exp` 24h ([`JwtConfig.kt`](../../apps/api/src/main/kotlin/fi/lagrange/auth/JwtConfig.kt))?
- [ ] `iat` claim added (open TODO `BEST_PRACTICES.md §2.3`)?
- [ ] No `email` / `role` claims — there is no concept yet?
- [ ] Web stores token in `localStorage['lagrangefi_token']` ([`api.ts:10`](../../apps/web/src/api.ts)) — flag for security review (XSS exfil risk; cross-link to [`security.md §7`](security.md))?
- [ ] On 401, web clears token and redirects to `/login` ([`api.ts:39-42`](../../apps/web/src/api.ts))?
- [ ] `noRedirect` flag used for explicit auth flows (`/auth/login`, `/auth/register`) so the user sees the error inline, not a redirect loop?

### How to inspect

```bash
# Claims in token
sed -n '/generateToken/,/}$/p' apps/api/src/main/kotlin/fi/lagrange/auth/JwtConfig.kt

# Token storage
git grep -nE 'localStorage|sessionStorage' apps/web/src

# 401 handling
sed -n '/401/p' apps/web/src/api.ts
```

### Red flags

- Web sets `Authorization` from `localStorage` with no expiry check — uses a stale (expired) token until the api 401s and redirects, leaving form state mid-submission.
- A second JWT-like header (`X-Auth-Token`) added in addition to `Authorization` — drift.
- A backend handler reading `Authorization: Token ...` while the frontend sends `Bearer` — silent 401.

### Reference
[`BEST_PRACTICES.md §2.3`](../BEST_PRACTICES.md), [`security.md §4, §7`](security.md). [`JwtConfig.kt`](../../apps/api/src/main/kotlin/fi/lagrange/auth/JwtConfig.kt), [`api.ts`](../../apps/web/src/api.ts).

---

## 5. Error envelope consistency

### Audit questions

- [ ] api errors all shaped `{ "error": "human readable message" }` — no mixing with `{ "message": ... }` or raw strings?
- [ ] HTTP status codes consistent: 400 for validation, 401 for auth missing/invalid, 403 for forbidden, 404 for not-found, 409 for conflict (idempotency duplicates), 500 for unhandled, 503 for "chain unreachable" ([`Routing.kt`](../../apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt))?
- [ ] chain returns `{ success: false, error: "..." }` for known business failures, HTTP 500 for unhandled (Fastify default)?
- [ ] No stack traces or framework internals leaking in error bodies?
- [ ] Frontend `apiFetch` ([`api.ts:48-50`](../../apps/web/src/api.ts)) parses `body.error` — covers both shapes?

### How to inspect

```bash
# api error responses
git grep -nE "respond\(.*HttpStatusCode" apps/api/src/main/kotlin/fi/lagrange/plugins
git grep -nE "mapOf\(\"error\"" apps/api/src/main/kotlin/fi/lagrange

# chain error returns
git grep -nE "success:\s*false" apps/chain/src
git grep -nE "reply\.code\(" apps/chain/src

# StatusPages mappings (api)
sed -n '1,$p' apps/api/src/main/kotlin/fi/lagrange/plugins/StatusPages.kt
```

### Red flags

- `respond(InternalServerError, e)` — passes the exception object, kotlinx serialises the message field plus stack — leaks framework internals.
- A 200 response with `{ success: false }` — "successful 200 with semantic failure" pattern fights the rest of the system.
- Web shows raw HTTP status numbers to users instead of the `error` field.

### Reference
[`BEST_PRACTICES.md §1.4 Error Handling`](../BEST_PRACTICES.md), [`StatusPages.kt`](../../apps/api/src/main/kotlin/fi/lagrange/plugins/StatusPages.kt).

---

## 6. Versioning

### Audit questions

- [ ] All user-scoped endpoints under `/api/v1/*` (currently — yes, [`Routing.kt:72`](../../apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt))?
- [ ] Auth and "current user" routes (`/auth/*`, `/me/*`) intentionally outside the version prefix?
- [ ] No breaking change introduced under `/api/v1` without a version bump path planned?
- [ ] `packages/shared` types versioned with the package (no separate `@lagrangefi/shared@2`)?
- [ ] When a v2 endpoint is added, frontend can opt-in (e.g. via a feature flag), not forced over from day one?

### How to inspect

```bash
git grep -nE 'route\("/api/v[12]"' apps/api/src
git grep -nE 'apiFetch\("/api/v[12]' apps/web/src
```

### Red flags

- A `/api/v2/*` introduced without a deprecation plan for v1.
- Mixed `/api/v1/strategies` and `/strategies` paths — inconsistent.
- Version bump in `packages/shared` not communicated to either consumer.

### Reference
[`Routing.kt`](../../apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt).

---

## 7. Idempotency keys on the wire

### Audit questions

- [ ] `RebalanceRequest` and `CloseRequest` ([`packages/shared/src/index.ts`](../../packages/shared/src/index.ts)) declare `idempotencyKey: string` as required?
- [ ] Kotlin DTOs in `ChainClient.kt` mirror this — required, not nullable?
- [ ] On the wire, `idempotencyKey` is a UUID v4 string (length 36, dashes at correct positions)?
- [ ] Chain's 409 response shape `{ error, idempotencyKey }` documented and parsed by api ([`UniswapStrategy.kt`](../../apps/api/src/main/kotlin/fi/lagrange/strategy/UniswapStrategy.kt) handles 409)?

### How to inspect

```bash
git grep -nE 'idempotencyKey' apps/api/src apps/chain/src packages/shared/src

# UUID validation server-side
git grep -nE 'UUID\.fromString|isValidUUID|matches.*\\\\b[0-9a-f]{8}' apps/chain/src
```

### Red flags

- Chain accepts any string as `idempotencyKey` — nothing prevents api accidentally sending an empty string and the dedup map gathering `""` keys.
- A response from chain that doesn't include the offending key — api can't dedupe its retries.

### Reference
[`BEST_PRACTICES.md §1.3, §3.7`](../BEST_PRACTICES.md), [`on-chain-safety.md §3`](on-chain-safety.md).

---

## 8. Numeric types on the wire

Cross-link to [`numerical-correctness.md §5`](numerical-correctness.md). Specifically for contracts:

### Audit questions

- [ ] All raw token amounts (uint256-shaped) sent as **strings** in JSON, not numbers?
- [ ] All gas-cost-wei values sent as numbers (fits Long but watch for `Long.MAX_VALUE` cumulatively)?
- [ ] All USD values sent as decimal strings (e.g. `"123.45"`) so JS doesn't convert via float?
- [ ] Tick values sent as integers?
- [ ] `slippageTolerance` sent as a decimal `number` (e.g. `0.005`) per [`packages/shared/src/index.ts:36`](../../packages/shared/src/index.ts)?
- [ ] Contract types' precision documented (e.g. "`liquidity: string` — uint128 raw")?

### How to inspect

```bash
# String vs number for token-shaped fields in shared
grep -nE 'amount|fees|liquidity|sqrtPrice|gas' packages/shared/src/index.ts
```

### Red flags

- An amount field declared `number` in shared — frontend parses up to `2^53`, then silently rounds.
- A new `liquidity: bigint` field added in chain code that JSON-serialises with a custom replacer — frontend doesn't know.

### Reference
[`numerical-correctness.md §5`](numerical-correctness.md), [`packages/shared/src/index.ts`](../../packages/shared/src/index.ts).

---

## 9. Documentation

### Audit questions

- [ ] [`CLAUDE.md "API endpoints"`](../../CLAUDE.md) lists every public route and accurately reflects current shapes?
- [ ] When endpoints are added/removed, `CLAUDE.md` is updated in the same PR (else doc drift)?
- [ ] [`README.md`](../../README.md) shows a curl/HTTPie example for at least one auth flow?
- [ ] [`apps/web/README.md`](../../apps/web/README.md) (if present) explains how to point the dev server at a real api vs `dev:mock`?
- [ ] No documentation of an endpoint that no longer exists (orphaned doc)?

### How to inspect

```bash
sed -n '/## API endpoints/,/## /p' CLAUDE.md | head -40

# Compare to actual routes
diff \
  <(grep -oE '"/[a-zA-Z0-9/_-]+(:|/")' CLAUDE.md | sort -u) \
  <(grep -oE '"/[a-zA-Z0-9/_-]+(:|/")' apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt | sort -u)
```

### Red flags

- A route in `CLAUDE.md` not in code — confusing for new devs and Claude itself.
- A route in code not in `CLAUDE.md` — undocumented surface area.

### Reference
[`CLAUDE.md`](../../CLAUDE.md).

---

## How to run this review

1. **Open a fresh Claude Code session.**
2. Walk top-to-bottom through sections 1 → 9. Run inspection commands. Paste output.
3. Tag findings:
   - **[critical]** an api response shape that web does not parse correctly is currently breaking a user flow.
   - **[high]** missing OpenAPI spec; type drift between `packages/shared` and `apps/web/src/types.ts`; route path mismatches.
   - **[medium]** doc drift in `CLAUDE.md` "API endpoints"; missing examples in README.
   - **[low]** error-message wording inconsistency.
4. Pick three random endpoints and trace each through the full contract chain: web `apiFetch` → Kotlin route → DTO → response → web type → component usage. Note any drift.
5. Recurring TODOs to track each pass:
   - OpenAPI spec absent (§1).
   - `packages/shared` adoption in `apps/web` (§2).
   - `iat` claim in JWT (§4).
   - Error-envelope mixed shapes after future refactors (§5).
   - `CLAUDE.md` "API endpoints" drift (§9).

A typical pass takes **30-60 minutes**, dominated by walking each endpoint through the chain.
