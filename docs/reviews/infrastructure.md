# Infrastructure Review Playbook

> Audit playbook for the Kubernetes manifests, Kustomize overlays, secrets, and runtime safety knobs that ship lagrangefi.

**Scope:**
- `k8s/base/` — service-agnostic resources
- `k8s/overlays/{prod,test}/` — environment-specific patches
- Secret and ConfigMap shape (consumed by api / chain)
- Probes, replicas, resources, NetworkPolicy
- Postgres StatefulSet and PVC

**Sister playbooks:** [`security.md §2, §6`](security.md) for secrets and inter-service trust; [`ci-cd.md`](ci-cd.md) for image build / deploy pipeline; [`observability.md §6, §8`](observability.md) for probes and log collection.

**Reference:** [`BEST_PRACTICES.md §6 k8s`](../BEST_PRACTICES.md), [`§7 CI/CD`](../BEST_PRACTICES.md), [`CLAUDE.md "Kubernetes"`](../../CLAUDE.md).

---

## 1. Base / overlay separation

### Audit questions

- [ ] `k8s/base/` contains **no** environment-specific values (image tags, replica counts, resource overrides, host names)?
- [ ] Overlays patch only what differs between environments — no full re-declaration of a Deployment?
- [ ] Each overlay's `kustomization.yaml` references `../../base`, has its own `namespace`, and only adds `patches` / `images` / additional `resources`?
- [ ] No drift between `prod` and `test` patches that isn't intentional? E.g. resource limits intentionally lower in test, ingress host different — anything else needs justification.

### How to inspect

```bash
# Image tag in base — should not be a SHA, only a logical name
git grep -nE 'image:' k8s/base

# Hostname / DNS in base
git grep -niE 'host:|hosts:' k8s/base

# Overlay structure
cat k8s/overlays/prod/kustomization.yaml
cat k8s/overlays/test/kustomization.yaml
diff <(ls k8s/overlays/prod) <(ls k8s/overlays/test)
```

### Red flags

- A `replicas: 3` in `k8s/base/web/deployment.yaml` instead of in the prod overlay.
- An ingress host in `k8s/base/web/ingress.yaml` (currently confirm — should be patched in overlay).
- A Service in base that doesn't exist in test (or vice versa) — patch drift.
- `image: lagrangefi/api:latest` resolving to a different SHA in different envs because the registry's `:latest` floats — verify overlays always pin SHA.

### Reference
[`BEST_PRACTICES.md §6.1 (mention of base/overlays)`](../BEST_PRACTICES.md). [`k8s/base/kustomization.yaml`](../../k8s/base/kustomization.yaml).

---

## 2. Image tagging

### Audit questions

- [ ] No `:latest` reference in any overlay? Base manifests contain `lagrangefi/api:latest` as a placeholder which Kustomize image-name overrides should always replace before apply.
- [ ] Overlays pin image tags to `sha-<7char>` per [`BEST_PRACTICES.md §7.1`](../BEST_PRACTICES.md)?
- [ ] CI auto-updates the `test` overlay's `newTag` to current SHA on push to `main`? (currently — verify by checking `.github/workflows/ci.yml`)
- [ ] The prod overlay still requires **manual** SHA bump per the comment in [`k8s/overlays/prod/kustomization.yaml:13`](../../k8s/overlays/prod/kustomization.yaml)? Auto-deploy to prod is a foot-gun.
- [ ] Pulled images use immutable tags (SHA tags don't get re-pushed at the same digest)?

### How to inspect

```bash
git grep -nE ':latest' k8s/

# Overlays — image tag values
git grep -nE 'newTag:' k8s/overlays/

# CI updates the test overlay
git grep -nE 'kustomize edit set image|sed.*newTag' .github/workflows/
```

### Red flags

- A `newTag: sha-placeholder` (literal string) actually applied — silent failure on `kubectl apply`.
- A prod overlay updated by CI accidentally — the `prod/` folder must not be touched by automation.
- `imagePullPolicy: Always` on a SHA tag — forces unnecessary network on every pod start.

### Reference
[`BEST_PRACTICES.md §7.1 Image Tagging`](../BEST_PRACTICES.md), [`k8s/overlays/prod/kustomization.yaml`](../../k8s/overlays/prod/kustomization.yaml), [`k8s/overlays/test/kustomization.yaml`](../../k8s/overlays/test/kustomization.yaml).

---

## 3. Secrets and ConfigMaps

### Audit questions

- [ ] `api-secret` populated with exactly: `DATABASE_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `JWT_SECRET`, `WALLET_ENCRYPTION_KEY` per [`CLAUDE.md`](../../CLAUDE.md)?
- [ ] `postgres-secret` populated with exactly: `user`, `password`?
- [ ] **No `chain-secret`** anywhere? (Chain no longer holds wallet keys per `CLAUDE.md "Wallet key flow"` — its presence in any cluster is a compromise indicator.)
- [ ] All Secret values created via `kubectl create secret generic --from-literal=...`, not committed YAML?
- [ ] `.gitignore` covers `*-secret.yaml` patterns ([`.gitignore:25-26`](../../.gitignore) — yes)?
- [ ] ConfigMaps (`api-config`, `chain-config`) hold only non-sensitive values: URLs, chat-id, port?
- [ ] Secret rotation procedure documented somewhere?
- [ ] `WALLET_ENCRYPTION_KEY` rotation strategy documented (rotation re-encrypts every wallet — non-trivial)?

### How to inspect

```bash
# Secrets vs ConfigMaps in committed manifests
git grep -nE 'kind: Secret' k8s/
git grep -nE 'kind: ConfigMap' k8s/

# secretRef / configMapRef wiring in pod specs
git grep -nE 'secretRef:|configMapRef:' k8s/

# chain-secret
git grep -nE 'chain-secret' k8s/

# Documented setup commands
sed -n '/Secrets/,/ConfigMaps/p' k8s/overlays/prod/kustomization.yaml
```

### Red flags

- A `kind: Secret` in `k8s/` with a non-empty `data:` block — even base64 is not encryption.
- An `envFrom: configMapRef: ... api-secret` typo where a Secret got named `*-config` — credentials in a ConfigMap.
- A `chain-secret` left over from before the per-request key model — its existence is a hint that someone reverted the change locally.
- `WALLET_ENCRYPTION_KEY` documented as "any string" rather than `openssl rand -base64 32`.

### Reference
[`CLAUDE.md "Secrets required"`](../../CLAUDE.md), [`BEST_PRACTICES.md §1.2`](../BEST_PRACTICES.md), [`§6.5`](../BEST_PRACTICES.md). [`security.md §2, §3`](security.md).

---

## 4. NetworkPolicy

### Audit questions

- [ ] `chain-service-policy` ([`k8s/base/worker/network-policy.yaml`](../../k8s/base/worker/network-policy.yaml)) restricts ingress to chain pods to api pods only, on the documented port (3001 currently — yes)?
- [ ] Default-deny policy considered for the namespace? (Without it, every pod can talk to every pod by default. Adding default-deny later requires verifying every legitimate flow first.)
- [ ] `web` does not have direct network access to `chain` (architecturally enforced via NetworkPolicy on chain pod selector)?
- [ ] Postgres NetworkPolicy: only `api` and (if applicable) any backup/admin tooling can reach Postgres on port 5432?

### How to inspect

```bash
git grep -rn 'kind: NetworkPolicy' k8s/

# Default-deny pattern
git grep -niE 'policyTypes:\s*$|default-deny|deny-all' k8s/
```

### Red flags

- A pod added under a namespace with no NetworkPolicy and assumed-default-allow connectivity — misses the security boundary.
- A change to `chain-service-policy` that adds `from: namespaceSelector: {}` (any pod in the namespace) — breaks the api-only constraint.

### Reference
[`BEST_PRACTICES.md §6.4 NetworkPolicy`](../BEST_PRACTICES.md), [`security.md §6`](security.md). [`network-policy.yaml`](../../k8s/base/worker/network-policy.yaml).

---

## 5. Probes

[`BEST_PRACTICES.md §6`](../BEST_PRACTICES.md) implies probes; current state is **no `livenessProbe` or `readinessProbe` configured**. Both `/health` endpoints exist in app code but no manifest references them.

### Audit questions

- [ ] Both api and chain Deployments have `readinessProbe` pointing at `/health` (and chain's `/health` does an RPC ping per [`observability.md §6`](observability.md))?
- [ ] `livenessProbe` separate from readiness, with a higher `failureThreshold`?
- [ ] `initialDelaySeconds` set so the JVM (api) has time to boot (~20-30s)?
- [ ] No `httpGet.path: /` (returns 404 if root not handled) — explicit `/health`?
- [ ] Postgres StatefulSet has a `tcpSocket` readiness probe on 5432?
- [ ] Probes don't embed credentials (the `/health` endpoint must be unauthenticated)?

### How to inspect

```bash
git grep -nE 'livenessProbe:|readinessProbe:' k8s/
git grep -nE '/health' apps/
```

### Red flags

- No probes anywhere — k8s ships traffic to a JVM still loading.
- A probe that authenticates (via header or cookie) — needs to handle credential rotation.
- `livenessProbe.failureThreshold: 1` — first transient failure restarts the pod.

### Reference
[`BEST_PRACTICES.md §6`](../BEST_PRACTICES.md), [`observability.md §6`](observability.md). [`Routing.kt:64`](../../apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt), [`server.ts:19`](../../apps/chain/src/server.ts).

---

## 6. Resource requests, limits, replicas

### Audit questions

- [ ] Every container has `resources.requests` set so the scheduler can place it correctly?
- [ ] `resources.limits` set to prevent runaway consumption of node resources?
- [ ] api / chain replicas set to **1** in base, increased only in prod overlay (current: web overlay does this, api does not — verify intentionality)?
- [ ] **api replicas must be 1** because the `StrategyScheduler` holds in-memory state (timers per active strategy). Two pods would duplicate every rebalance. [`BEST_PRACTICES.md §6.8 Replica Safety`](../BEST_PRACTICES.md) — confirm.
- [ ] **chain replicas can be > 1** but the in-memory `processedKeys` (idempotency cache) is per-pod — duplicate chain pods accept duplicate idempotency keys. Until DB-backed dedup ships, also keep at 1, or confirm the api side never retries after a failed call to a different pod.
- [ ] **web replicas > 1** is fine (stateless React + nginx).

### How to inspect

```bash
git grep -nE 'resources:|requests:|limits:' k8s/
git grep -nE 'replicas:' k8s/

# Strategy scheduler in-memory state
git grep -n 'ConcurrentHashMap\|fixedRateTimer' apps/api/src/main/kotlin/fi/lagrange/strategy
```

### Red flags

- `replicas: 3` on api — silent duplication of every rebalance.
- A container with `requests` but no `limits` — bad neighbour scenarios on shared nodes.
- `requests: cpu: 500m` for a process that uses 50m — wastes scheduler capacity.

### Reference
[`BEST_PRACTICES.md §6.8 Replica Safety`](../BEST_PRACTICES.md), [`api-deployment.yaml`](../../k8s/base/worker/api-deployment.yaml), [`chain-deployment.yaml`](../../k8s/base/worker/chain-deployment.yaml).

---

## 7. CronJob — duplicate-run prevention

### Audit questions

- [ ] [`k8s/base/worker/cronjob.yaml:8`](../../k8s/base/worker/cronjob.yaml) uses `concurrencyPolicy: Forbid` per [`CLAUDE.md "Kubernetes"`](../../CLAUDE.md)? Currently yes.
- [ ] Schedule sane (`* * * * *` = every minute, OK)?
- [ ] `successfulJobsHistoryLimit` and `failedJobsHistoryLimit` both ≤ 3?
- [ ] `restartPolicy: Never` so a crashed Job doesn't re-execute the rebalance from scratch (since the rebalance handles its own idempotency / recovery)?
- [ ] Wait — the README and CLAUDE.md describe the api as a long-running Deployment (not a CronJob) plus a separate scheduler. Is the CronJob actually used? Or is it legacy from an earlier architecture? **Investigate** — currently there are *both* `api-deployment.yaml` and `cronjob.yaml`. If the Deployment is the active one, the CronJob may be redundant and should be removed.

### How to inspect

```bash
sed -n '1,$p' k8s/base/worker/cronjob.yaml
git grep -n 'CronJob\|cronjob' .github/workflows/

# Is the CronJob even pulled in by base kustomization?
cat k8s/base/kustomization.yaml
cat k8s/base/worker/kustomization.yaml 2>/dev/null
```

### Red flags

- Both Deployment and CronJob running — every minute the CronJob also bootstraps the scheduler, double rebalance.
- `concurrencyPolicy: Allow` (default) — overlapping jobs in case the previous didn't finish.
- A schedule of `*/5 * * * *` on a system that the user expects to rebalance every minute — confusion.

### Reference
[`CLAUDE.md "Kubernetes"`](../../CLAUDE.md), [`BEST_PRACTICES.md §6`](../BEST_PRACTICES.md). [`cronjob.yaml`](../../k8s/base/worker/cronjob.yaml).

---

## 8. Postgres StatefulSet

### Audit questions

- [ ] `kind: StatefulSet`, not Deployment ([`k8s/base/postgres/statefulset.yaml`](../../k8s/base/postgres/statefulset.yaml))?
- [ ] `volumeClaimTemplates` (PVC) for data — never `emptyDir`?
- [ ] `replicas: 1` (single primary; HA Postgres is post-MVP)?
- [ ] `livenessProbe` / `readinessProbe` configured?
- [ ] Postgres image pinned to a major version (e.g. `postgres:15-alpine`), not `:latest`?
- [ ] A backup mechanism in place (CronJob with `pg_dump` + offsite copy, or managed-Postgres snapshots)? Cross-link to [`database.md §9`](database.md).
- [ ] Storage class explicit (default storage-class drift between clusters is a real cause of broken deploys)?

### How to inspect

```bash
sed -n '1,$p' k8s/base/postgres/statefulset.yaml
git grep -niE 'pg_dump\|backup\|cronjob' k8s/
```

### Red flags

- `kind: Deployment` for Postgres with `emptyDir` — data lost on every pod replace.
- `image: postgres:latest` — surprise major upgrade.
- No PVC retention policy — `kubectl delete sts postgres` deletes the volume in some clusters.

### Reference
[`BEST_PRACTICES.md §6.7 Stateful (PVC)`](../BEST_PRACTICES.md), [`database.md §9`](database.md).

---

## 9. Ingress and TLS

### Audit questions

- [ ] Web ingress (`k8s/base/web/ingress.yaml` and overlay `ingress-host.yaml`) terminates TLS — not plain HTTP exposed to the internet?
- [ ] HSTS header set at the ingress controller (cross-link to [`security.md §7`](security.md))?
- [ ] Ingress class explicit (e.g. `ingressClassName: nginx`) — leaving it unset relies on a cluster default that may change?
- [ ] No ingress for chain or api (only web, by design — api is reached internally by web's nginx reverse-proxy or the same domain)?
- [ ] Cert-manager (or equivalent) configured to renew TLS certs?

### How to inspect

```bash
git grep -rn 'kind: Ingress' k8s/
git grep -rn 'tls:' k8s/
git grep -rn 'cert-manager.io' k8s/
```

### Red flags

- An ingress on chain — bypasses NetworkPolicy and exposes wallet-key-bearing endpoints to the internet.
- An ingress without `tls:` — wallet phrase travels over plain HTTP from browser to api.
- Self-signed cert in prod — modern browsers warn aggressively.

### Reference
[`security.md §7`](security.md). [`k8s/base/web/ingress.yaml`](../../k8s/base/web/ingress.yaml).

---

## 10. RBAC and ServiceAccounts

### Audit questions

- [ ] Each Deployment binds to a dedicated ServiceAccount, not `default`?
- [ ] No SA has cluster-wide RBAC (`ClusterRole` / `ClusterRoleBinding`) unless absolutely necessary?
- [ ] No SA with `secrets` `get` permission outside of api / chain that need it?
- [ ] No `automountServiceAccountToken: true` on pods that don't talk to the k8s API?

### How to inspect

```bash
git grep -rn 'serviceAccountName:' k8s/
git grep -rn 'kind: (ClusterRole|Role|ServiceAccount)' k8s/
git grep -rn 'automountServiceAccountToken' k8s/
```

### Red flags

- All pods running as `default` SA — every pod can list everything via the in-pod token.
- A `ClusterRoleBinding: cluster-admin` for any app SA.

### Reference
[`security.md`](security.md), [`BEST_PRACTICES.md §6`](../BEST_PRACTICES.md).

---

## 11. Pod-security context

### Audit questions

- [ ] Every container runs as a non-root user (`runAsNonRoot: true`, `runAsUser: 1000+`)?
- [ ] `readOnlyRootFilesystem: true` for stateless services (api, chain, web)?
- [ ] `allowPrivilegeEscalation: false`?
- [ ] `capabilities.drop: [ALL]`?
- [ ] `seccompProfile.type: RuntimeDefault`?

### How to inspect

```bash
git grep -rn 'securityContext:' k8s/
git grep -rn 'runAsNonRoot\|readOnlyRootFilesystem\|allowPrivilegeEscalation\|seccomp' k8s/
```

### Red flags

- No `securityContext` on any pod — all run as root.
- A pod that needs `readOnlyRootFilesystem: false` without comment — usually means writing to `/tmp` and should use an `emptyDir` mount.

### Reference
*(no specific BEST_PRACTICES entry — Pod Security Standards 'restricted' is the target)*.

---

## How to run this review

1. **Open a fresh Claude Code session.** Have `kubectl` access to the test cluster if you want to spot-check live state.
2. Walk top-to-bottom through sections 1 → 11. Run inspection commands. Paste output.
3. Tag findings:
   - **[critical]** any cluster-side path that compromises wallets (e.g. chain ingress added; secret in ConfigMap; multiple api replicas; chain-secret revived).
   - **[high]** missing probes leading to bad-pod traffic; `:latest` reaching prod; CronJob duplicating Deployment work.
   - **[medium]** `runAsNonRoot` not set; missing default-deny NetworkPolicy.
   - **[low]** style: comment drift between prod and test overlay.
4. Recurring TODOs to track each pass:
   - Probes wiring (§5).
   - CronJob vs Deployment duplication (§7) — clarify which is canonical.
   - Default-deny NetworkPolicy (§4).
   - Postgres backup (§8) — cross-link to [`database.md §9`](database.md).
   - Pod-security context (§11).

A typical pass takes **30-45 minutes** plus optional time for live cluster checks.
