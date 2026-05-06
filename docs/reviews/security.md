# Security Review Playbook

> Audit playbook for the security posture of lagrangefi. Walk through each section in order. For every audit question, answer **yes / no / partial** with a file:line citation or command output as evidence.

**Scope:**
- Secrets storage and lifecycle (`.gitignore`, k8s `Secret`s, env vars)
- Authentication (JWT, BCrypt) and authorisation (route guards, ownership checks)
- Wallet encryption (AES-256-GCM, key handling)
- Inter-service trust boundaries (`web ↔ api`, `api ↔ chain`)
- Dependency hygiene (CVEs, lockfiles, pinning)
- Logging hygiene (no secret material in logs / Telegram)

**Out of scope** (covered elsewhere): on-chain safety (slippage, MEV) → see [`on-chain-safety.md`](on-chain-safety.md). Numerical errors that turn into money loss → [`numerical-correctness.md`](numerical-correctness.md).

**Reference:** [`BEST_PRACTICES.md §1.2 Secrets`](../BEST_PRACTICES.md), [`§1.3 Idempotency`](../BEST_PRACTICES.md), [`§2 apps/api`](../BEST_PRACTICES.md), [`§6 k8s`](../BEST_PRACTICES.md).

---

## 1. Secrets in source control

### Audit questions

- [ ] No `.env`, `.env.local`, `*.key`, `*.pem`, `*-secret.yaml`, or wallet keystores tracked in git?
- [ ] `.gitignore` covers every secret-bearing pattern (not just `.env`)?
- [ ] No private keys, mnemonics, RPC keys, Telegram bot tokens, or DB passwords in source?
- [ ] No secrets in committed k8s manifests (only in `Secret` resources applied out-of-band)?
- [ ] `.mcp.json` is gitignored (it carries API tokens)?

### How to inspect

```bash
# Files tracked in git that look secret-bearing
git ls-files | grep -iE '\.(env|key|pem|p12|jks|keystore)$|secret|credentials'

# Secret-shaped strings in tracked source (private keys, JWT secrets, bot tokens)
git grep -nE '0x[a-fA-F0-9]{64}|bot[0-9]{8,}:[A-Za-z0-9_-]{30,}|sk_live_|-----BEGIN'

# k8s yamls with literal data (vs. valueFrom secretKeyRef)
git grep -nE '^\s+(password|token|secret|key):\s*["'\'']?[A-Za-z0-9+/=]{8,}' k8s/

# Verify .gitignore covers secret patterns
cat .gitignore
```

### Red flags

- **Any** match of the second command above. A 64-hex string in source is almost always a leaked private key.
- A `.env.production` file tracked in git (note: `apps/web/.env.production` *is* tracked and should contain only public values like the API URL — confirm it has no secrets).
- A k8s manifest with `data:` containing base64 strings instead of `secretKeyRef`.
- A teammate "temporarily" committed credentials and you can find them with `git log -p` even if the latest tree is clean.

### Reference
[`BEST_PRACTICES.md §1.2`](../BEST_PRACTICES.md). Current `.gitignore` ([.gitignore](../../.gitignore)) covers `.env*`, `k8s/**/secrets.yaml`, `k8s/**/*-secret.yaml`, and `.mcp.json`.

---

## 2. Secrets at runtime (env vars and k8s Secrets)

### Audit questions

- [ ] Every secret env var the api/chain reads is sourced from a k8s `Secret`, never a `ConfigMap`?
- [ ] `api-secret` contains exactly: `DATABASE_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `JWT_SECRET`, `WALLET_ENCRYPTION_KEY` (per [`CLAUDE.md`](../../CLAUDE.md))? No drift?
- [ ] `postgres-secret` contains only `user`, `password`?
- [ ] No `chain-secret` exists any more (the chain service no longer holds wallet keys)?
- [ ] `WALLET_ENCRYPTION_KEY` is 32 bytes after base64-decode? (`WalletService` enforces this at startup but the secret may have been rotated to a wrong size.)
- [ ] All env-var reads in the api go through `AppConfig` / Hoplite, never `System.getenv("...")` inline?

### How to inspect

```bash
# Confirm Hoplite-only access in api
git grep -n 'System\.getenv' apps/api/src

# Every secret consumer should be a k8s SecretKeySelector
git grep -rn 'secretKeyRef\|valueFrom' k8s/

# ConfigMap should never carry secret-shaped keys
git grep -nE 'data:|stringData:' k8s/base/configmap.yaml 2>/dev/null
```

### Red flags

- An inline `System.getenv("JWT_SECRET")` somewhere in business logic — bypasses Hoplite's startup-time validation.
- A `ConfigMap` carrying a key named `*_PASSWORD`, `*_TOKEN`, `*_SECRET`, `*_KEY`.
- A pod env var with literal value in plain manifest (`value: "..."` instead of `valueFrom.secretKeyRef`).
- Missing required key in `api-secret`: pod will start but Hoplite will throw, leaving the rebalance scheduler dead and silent unless you check logs.

### Reference
[`BEST_PRACTICES.md §1.2 Secrets`](../BEST_PRACTICES.md), [`§2.1 Configuration`](../BEST_PRACTICES.md), [`§6 k8s`](../BEST_PRACTICES.md). Config defined in [`apps/api/src/main/resources/application.yaml`](../../apps/api/src/main/resources/application.yaml).

---

## 3. Wallet encryption

The most sensitive code path in the system. `WalletService` ([apps/api/src/main/kotlin/fi/lagrange/services/WalletService.kt](../../apps/api/src/main/kotlin/fi/lagrange/services/WalletService.kt)) encrypts BIP39 mnemonics or raw private keys with AES-256-GCM and stores the ciphertext in `wallets.encrypted_phrase`.

### Audit questions

- [ ] `Cipher.getInstance("AES/GCM/NoPadding")` — exact algorithm string, never `AES/ECB/...` or `AES/CBC/...`?
- [ ] IV is freshly generated per encryption with `SecureRandom` and is **12 bytes**?
- [ ] IV is prepended to the ciphertext (`iv + encrypted`) so decryption can recover it deterministically?
- [ ] GCM tag length is **128 bits**?
- [ ] Key length is enforced as exactly 32 bytes after base64 decode (rejecting 16/24-byte keys at startup)?
- [ ] No code path returns the decrypted phrase to the web client? Only `hasWallet` (boolean) is exposed via `/me/wallet` GET.
- [ ] Decrypted phrase only travels from `WalletService.getDecryptedPhrase` → `ChainClient` request body → discarded in chain after use? No log lines, no DB writes, no Telegram alerts contain it.
- [ ] No phrase validation that gives an oracle (e.g. distinguishing "wrong phrase format" from "wrong padding" via different exception types)?

### How to inspect

```bash
# Confirm GCM mode and key size
sed -n '1,90p' apps/api/src/main/kotlin/fi/lagrange/services/WalletService.kt

# Check no other place in the codebase decrypts wallets
git grep -n 'getDecryptedPhrase\|decrypt(' apps/

# Check the phrase never appears in logs or Telegram
git grep -nE 'phrase|privateKey|walletPrivateKey' apps/api/src apps/chain/src \
  | grep -iE 'log|info|warn|error|debug|telegram|notify'
```

### Red flags

- `Cipher.getInstance("AES")` (defaults to ECB on some JVMs).
- A static / reused IV — catastrophic for GCM (key compromise after two encrypted plaintexts).
- IV stored separately and looked up by user id (race condition + complexity for no benefit).
- A `toString()` override on a wallet-bearing data class that includes the phrase — log statements like `log.info("processing $request")` will leak it.
- A "convenience" endpoint that returns the decrypted phrase for "wallet recovery" — there must not be one.
- Tests fixtures with real encrypted ciphertext + the matching key checked into git.

### Reference
[`BEST_PRACTICES.md §1.2 Secrets`](../BEST_PRACTICES.md), [`CLAUDE.md "Multi-user model" / "Wallet key flow"`](../../CLAUDE.md). Implementation: [`WalletService.kt:27-42`](../../apps/api/src/main/kotlin/fi/lagrange/services/WalletService.kt).

---

## 4. Authentication — passwords and JWTs

### Audit questions

- [ ] Passwords hashed with BCrypt at cost ≥ 10 (current: 12 in [`UserService.kt:22`](../../apps/api/src/main/kotlin/fi/lagrange/services/UserService.kt))?
- [ ] `BCrypt.checkpw` used for verification (constant-time within bcrypt's design), never raw string compare?
- [ ] Username uniqueness enforced at the DB level (unique index on `users.username`) and not only via the in-Kotlin check (race condition on parallel registers)?
- [ ] Minimum password length enforced server-side (≥ 8 currently in [`UserService.kt:20`](../../apps/api/src/main/kotlin/fi/lagrange/services/UserService.kt))?
- [ ] JWT uses HS256 with a secret of at least 32 bytes (`openssl rand -hex 32` produces 64 hex chars = 32 bytes)?
- [ ] JWT verifier checks issuer **and** audience (currently both: `lagrangefi` / `lagrangefi-web`)?
- [ ] Expiry ≤ 24h ([`JwtConfig.kt:15`](../../apps/api/src/main/kotlin/fi/lagrange/auth/JwtConfig.kt))? Refresh-token mechanism is intentionally absent for v1?
- [ ] All protected routes are inside `authenticate("jwt") { ... }` blocks?

### How to inspect

```bash
# Find every route definition and check it's inside an authenticate block
git grep -n 'route("/' apps/api/src
git grep -n 'authenticate("jwt")' apps/api/src

# Check for unguarded routes
sed -n '/^fun Route\./,/^}/p' apps/api/src/main/kotlin/fi/lagrange/auth/AuthRoutes.kt

# JWT secret comes only from env, not source
git grep -n 'HMAC256\|JWT_SECRET' apps/api/src
```

### Red flags

- A protected route (anything user-scoped: `/api/v1/strategies`, `/me/*`) defined outside `authenticate("jwt")`.
- Manual JWT verification (`JWT.decode(...)`) in business logic — bypasses Ktor's auth pipeline.
- A login endpoint that returns different errors for "user not found" vs "wrong password" (user enumeration).
- BCrypt cost dropped to ≤ 8 "for tests" and not reverted.
- The JWT secret committed to `application.yaml` as a default value.

### Reference
[`UserService.kt`](../../apps/api/src/main/kotlin/fi/lagrange/services/UserService.kt), [`JwtConfig.kt`](../../apps/api/src/main/kotlin/fi/lagrange/auth/JwtConfig.kt), [`AuthRoutes.kt`](../../apps/api/src/main/kotlin/fi/lagrange/auth/AuthRoutes.kt).

---

## 5. Authorisation — ownership checks on user-scoped resources

JWT proves *who* the caller is. Authorisation proves *that they may touch this resource*. Every route that takes a `:strategyId` (or any user-owned id) must verify the resource belongs to the JWT's `userId`.

### Audit questions

- [ ] Every `/api/v1/strategies/:id*` handler reads `userId = call.getUserId()` and confirms `strategy.userId == userId` **before** acting?
- [ ] Returning 404 (not 403) for "exists but not yours" so the API doesn't leak existence of others' strategies?
- [ ] No batch endpoints accept a list of ids without verifying ownership of each?
- [ ] Wallet endpoints (`/me/wallet`, `/me/wallet/balances`) only ever read/write the JWT user's own wallet — never accept a `userId` parameter?

### How to inspect

```bash
# Every handler that reads :id should also check ownership
git grep -nE 'parameters\["id"\]|call\.parameters' apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt

# Walk through Routing.kt and for each :strategyId, confirm an ownership check exists
sed -n '1,$p' apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt
```

### Red flags

- A handler that fetches by id without filtering by `userId` in the same query (relies on subsequent runtime check that an attacker can race or skip).
- An admin-only flag in the JWT used to bypass ownership checks — there is no admin role in v1; if you find one, it shouldn't be there yet.
- A diff that adds a new strategy field and forgets to include it in the ownership-checked path.

### Reference
[`BEST_PRACTICES.md §1.1 Service Boundaries`](../BEST_PRACTICES.md), [`§2 apps/api`](../BEST_PRACTICES.md). [`Routing.kt`](../../apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt).

---

## 6. Inter-service trust — `api → chain`

The chain service holds no wallet keys: the api forwards the decrypted phrase per-request in `walletPrivateKey`. This is convenient but means a request body to chain is a wallet-stealing payload.

### Audit questions

- [ ] In production, is the api↔chain hop encrypted (mTLS via service mesh, or shared `X-Api-Secret` header on every request)? **At time of writing, neither is implemented — see open TODO in `BEST_PRACTICES.md §1.2`.**
- [ ] `NetworkPolicy` (`k8s/base/worker/network-policy.yaml`) restricts ingress to chain pods to api pods only, on the documented port?
- [ ] No public ingress / Service of type `LoadBalancer` is created for chain?
- [ ] Chain service binds to the cluster network only (not `0.0.0.0` exposed via NodePort) ?
- [ ] If a shared secret is added, it is rotated when any operator with cluster access leaves the team?

### How to inspect

```bash
# NetworkPolicy contents and pod selectors
sed -n '1,$p' k8s/base/worker/network-policy.yaml
git grep -rn 'kind: Service' k8s/

# Check chain has no Service of type LoadBalancer
git grep -rn 'type: LoadBalancer' k8s/

# Confirm there is no chain ingress in any overlay
git grep -rn 'host:\|ingress' k8s/overlays/
```

### Red flags

- A service mesh "planned" but never installed — the BEST_PRACTICES TODO has been open for months.
- An emergency `kubectl port-forward` left running on the chain service on a shared bastion.
- An `X-Api-Secret` header committed to source.
- A NetworkPolicy in `default-deny` mode globally that accidentally also blocks api → chain (verify by curling chain from an api pod after any policy change).

### Reference
[`BEST_PRACTICES.md §1.2 (TODO)`](../BEST_PRACTICES.md), [`§6.4 NetworkPolicy`](../BEST_PRACTICES.md). [`network-policy.yaml`](../../k8s/base/worker/network-policy.yaml).

---

## 7. Browser / web → api boundary

### Audit questions

- [ ] CORS is configured on the api with a known origin (the dashboard URL), never `*`? **At time of writing, no CORS plugin appears installed in `Application.kt` — confirm whether nginx/ingress handles it instead.**
- [ ] All cookies (if any) set with `Secure; HttpOnly; SameSite=Strict`? (Currently the JWT is stored in localStorage by the web app — see [`AuthContext.tsx`](../../apps/web/src/context/AuthContext.tsx); confirm and decide whether to migrate to a cookie.)
- [ ] No `Access-Control-Allow-Credentials: true` paired with `Access-Control-Allow-Origin: *` (this is rejected by browsers but reviewers still see this misconfiguration; flag it).
- [ ] The web bundle does not embed the JWT or any secret — `Authorization` header is set per request from in-memory state.
- [ ] CSP header (Content-Security-Policy) configured at nginx (see [`apps/web/nginx.conf`](../../apps/web/nginx.conf))? At minimum: `default-src 'self'`, no `unsafe-eval`.
- [ ] HSTS configured at the production ingress?

### How to inspect

```bash
# Search for CORS config (Ktor or nginx)
git grep -n 'CORS\|allowHost\|allowOrigin' apps/api/src
sed -n '1,$p' apps/web/nginx.conf

# JWT storage in the web app
git grep -n 'localStorage\|sessionStorage' apps/web/src

# CSP / HSTS in nginx or ingress
git grep -niE 'content-security-policy|strict-transport-security' apps/web/nginx.conf k8s/
```

### Red flags

- `localStorage.setItem("token", ...)` plus an XSS vector elsewhere = wallet phrase eventually exfiltrable.
- CORS allows `*` and credentials.
- nginx `Access-Control-Allow-Origin` reflected from the request `Origin` without a whitelist.
- React `dangerouslySetInnerHTML` anywhere.

### Reference
[`apps/web/nginx.conf`](../../apps/web/nginx.conf), [`apps/web/src/context/AuthContext.tsx`](../../apps/web/src/context/AuthContext.tsx).

---

## 8. Input validation & abuse resistance

### Audit questions

- [ ] All request bodies validated server-side (lengths, ranges, enum values), not just on the React side?
- [ ] Wallet phrase input rejected if not (a) 12/15/18/21/24 lowercase BIP39 words, **or** (b) 64-hex-char private key (with optional `0x` prefix)?
- [ ] `rangePercent` and `slippageTolerance` clamped to documented ranges (e.g. `0.1 ≤ range ≤ 50`)?
- [ ] Username regex disallows whitespace and control chars (currently only length-checked in [`UserService.kt:19`](../../apps/api/src/main/kotlin/fi/lagrange/services/UserService.kt))?
- [ ] Rate-limiting on `/auth/login`, `/auth/register`, and `/me/wallet` PUT — at minimum at the ingress level?
- [ ] No SQL string interpolation; all DB access goes through Exposed DSL.
- [ ] No `eval`/`Function` constructor in the chain service or web; user-controlled strings never reach a code-evaluation path.

### How to inspect

```bash
# Any raw SQL?
git grep -n 'rawSql\|execSql\|"SELECT\|"INSERT\|"UPDATE\|"DELETE' apps/api/src

# eval/Function in JS/TS
git grep -nE '\beval\(|new Function\(' apps/chain/src apps/web/src

# Validation primitives in Kotlin routes
git grep -nE 'require\(|require\b' apps/api/src
```

### Red flags

- A `WalletRequest.phrase` accepted as-is without format validation (current state: only `isBlank()` check at [`AuthRoutes.kt:62`](../../apps/api/src/main/kotlin/fi/lagrange/auth/AuthRoutes.kt) — phrase can be "abc" and you only find out the next time the chain service tries to load it).
- Any route with no `require(...)` calls validating shape of inputs.
- A login endpoint without throttling, bots will brute-force credentials.

### Reference
[`UserService.kt`](../../apps/api/src/main/kotlin/fi/lagrange/services/UserService.kt), [`AuthRoutes.kt`](../../apps/api/src/main/kotlin/fi/lagrange/auth/AuthRoutes.kt), [`BEST_PRACTICES.md §1.6 Decimal & Financial Math`](../BEST_PRACTICES.md) for value ranges.

---

## 9. Logging hygiene

The api logs to stdout for k8s collection. Anything in those logs is visible to anyone with cluster-log access and forwarded to whatever observability backend you wire up.

### Audit questions

- [ ] No log statement contains `phrase`, `privateKey`, `walletPrivateKey`, `mnemonic`, `password`, or `token` as a value (key names in structured logs are fine)?
- [ ] `RebalanceRequest` and similar wallet-bearing types either have a redacted `toString()` **or** are never passed to a log call?
- [ ] Telegram alerts redact wallet-bearing fields (alerts include user-facing messages — those messages must be safe)?
- [ ] Stack traces from user-input handlers are not echoed back to the client (otherwise a malformed wallet phrase could surface in the response body)?
- [ ] The api never logs request bodies wholesale (e.g. via a verbose Ktor `CallLogging` config) — only `method, path, status, durationMs` per [`BEST_PRACTICES.md §1.5`](../BEST_PRACTICES.md).

### How to inspect

```bash
# Hunt for log calls that interpolate wallet/auth-bearing names
git grep -nE 'log\.(info|warn|error|debug)\(.*(\$|\{).*\b(phrase|privateKey|walletPrivateKey|mnemonic|password|token|secret)' apps/

# CallLogging config in Ktor
git grep -n 'CallLogging\|callLogging' apps/api/src

# Telegram alert content
sed -n '1,$p' apps/api/src/main/kotlin/fi/lagrange/services/TelegramNotifier.kt
```

### Red flags

- `log.info("rebalance request: $req")` where `$req` includes `walletPrivateKey`.
- A `data class` whose default `toString()` covers a wallet field — Kotlin's data-class `toString` is auto-generated; either exclude the field with a non-data class or override `toString()` explicitly.
- A debug-level log of "decrypted wallet for user X: $phrase" left over from local development.

### Reference
[`BEST_PRACTICES.md §1.2 (Never log secret values)`](../BEST_PRACTICES.md), [`§1.5 Observability`](../BEST_PRACTICES.md). [`TelegramNotifier.kt`](../../apps/api/src/main/kotlin/fi/lagrange/services/TelegramNotifier.kt).

---

## 10. Dependency hygiene

### Audit questions

- [ ] Lockfiles committed and current: `package-lock.json` (or `pnpm-lock.yaml`), Gradle's `gradle.lockfile` if used, plus a renovate/dependabot config?
- [ ] Transitive vulnerabilities in dependency tree: `npm audit --omit=dev` returns 0 high/critical for `apps/web`, `apps/chain`, `packages/shared`?
- [ ] For the api: `./gradlew dependencyCheckAnalyze` (OWASP plugin) returns 0 high/critical, **or** at least manual review of `gradle.lockfile` versus advisories happens before each release?
- [ ] Crypto / chain libs are pinned to exact versions, not `^x.y` or `~x.y`: `viem`, `ethers` (if any), `@uniswap/v3-sdk` etc.
- [ ] No package with a `postinstall` script outside `node_modules` of well-known publishers (defence against supply-chain attacks).
- [ ] Deprecated packages flagged: `npm ls --depth=0 2>&1 | grep -i deprecated`.

### How to inspect

```bash
# Lockfiles tracked
git ls-files | grep -E 'package-lock\.json|pnpm-lock\.yaml|gradle\.lockfile'

# Audit each workspace
( cd apps/web   && npm audit --omit=dev --audit-level=high )
( cd apps/chain && npm audit --omit=dev --audit-level=high )
( cd packages/shared && npm audit --omit=dev --audit-level=high )

# Pinned crypto deps
git grep -nE '"(viem|ethers|@uniswap/.*|@openzeppelin/.*)":' apps/ packages/

# Renovate / Dependabot config
ls -la .github/dependabot.yml renovate.json 2>/dev/null
```

### Red flags

- `viem: "^2.x"` (caret range) — a non-patch upgrade can change tx-encoding behaviour. Pin exact.
- `npm audit` reports a critical that has been "ignored" via `.npmrc`'s `audit-level` rather than fixed.
- Lockfile not updated in months while `package.json` has changed (broken workspace install).
- A package `npm publish`ed by a different maintainer than expected (verify on the npm registry web UI).

### Reference
[`apps/web/package.json`](../../apps/web/package.json), [`apps/chain/package.json`](../../apps/chain/package.json), [`apps/api/build.gradle.kts`](../../apps/api/build.gradle.kts).

---

## 11. Misc — operational risks that are technically not "code"

### Audit questions

- [ ] The hot wallet for the test environment holds only nominal funds (single-digit USD), per [`CLAUDE.md`](../../CLAUDE.md)?
- [ ] Production wallet has a documented per-day spending cap *somewhere* (post-MVP — track as a known gap)?
- [ ] Telegram bot token: who has admin access to the bot, can revoke it, and rotates it on team changes?
- [ ] Postgres role used by the api is least-privilege (no `SUPERUSER`, no access to other databases on the same instance)?
- [ ] Backups of the `users` and `wallets` tables are encrypted at rest, and the backup encryption key is **different** from `WALLET_ENCRYPTION_KEY` (rotating one shouldn't make backups unrecoverable, but they shouldn't share fate either)?
- [ ] Recovery procedure documented: if `WALLET_ENCRYPTION_KEY` is lost, every user must re-enter their phrase. Is there a runbook?

### Red flags

- A "shared" Telegram bot used across multiple environments (test + prod) — token leak in test compromises prod alerts.
- Postgres role `lagrange_api` granted `ALL PRIVILEGES ON DATABASE` (instead of just `CONNECT, USAGE` on schema + per-table grants).
- Backups copied to a developer laptop "for analysis" — wallets table copied off the cluster boundary.

### Reference
[`CLAUDE.md "Known risks"`](../../CLAUDE.md), [`BEST_PRACTICES.md §6 k8s`](../BEST_PRACTICES.md).

---

## How to run this review

1. **Open a fresh Claude Code session** (do not reuse a session that previously edited security-related code — it will defend its own work).
2. Open this file and walk top-to-bottom through sections 1 → 11.
3. For each audit question: run the inspection command, paste the relevant output as evidence, mark **yes / no / partial**.
4. Tag each finding with severity:
   - **[critical]** money or wallet keys at risk now (e.g. plaintext phrase in logs, missing JWT verification on a route).
   - **[high]** correctness or stability risk (e.g. JWT secret weak, NetworkPolicy missing).
   - **[medium]** tech debt with no immediate exploit (e.g. CORS not configured because no public api yet).
   - **[low]** cosmetic (typos in env var names, doc drift).
5. **For non-trivial fixes** (anything beyond a one-line config change): write a short plan, confirm with the project owner, then implement. Do not start refactors mid-review.
6. Update [`BEST_PRACTICES.md`](../BEST_PRACTICES.md) section TODOs if a new gap is discovered.

A typical full pass of this playbook on a healthy codebase takes **45-90 minutes**. A pass that uncovers a critical finding will take longer because investigation expands — that is the point.
