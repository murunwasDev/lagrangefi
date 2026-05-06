# CI/CD Review Playbook

> Audit playbook for GitHub Actions workflows, image builds, and deployment safety.

**Scope:**
- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) — build & push Docker images, auto-update test overlay
- [`.github/workflows/deploy-test.yml`](../../.github/workflows/deploy-test.yml) — manual deploy to the test cluster
- Image tagging, registry hygiene, branch protection, prod deploy gating

**Sister playbooks:** [`testing.md §7`](testing.md) for CI test execution, [`infrastructure.md §2`](infrastructure.md) for image tagging from a k8s perspective, [`security.md §10`](security.md) for dependency scanning.

**Reference:** [`BEST_PRACTICES.md §7 CI/CD`](../BEST_PRACTICES.md), [`CLAUDE.md "CI/CD pipelines"`](../../CLAUDE.md).

---

## 1. Build pipeline shape

### Audit questions

- [ ] [`ci.yml`](../../.github/workflows/ci.yml) triggers on `push: branches: [main]` and `workflow_dispatch` (manual feature-branch builds)?
- [ ] Path filtering (`dorny/paths-filter`) used on `push` so unrelated changes don't rebuild every service?
- [ ] `packages/shared/**` triggers a `chain` rebuild (shared types are baked into the chain image at build time) per [`CLAUDE.md`](../../CLAUDE.md)?
- [ ] Manual builds always build all three services (the path filter is meaningless without a base ref)?
- [ ] `permissions:` minimal per job — only `packages: write` for image pushes, only `contents: write` where the workflow commits back?
- [ ] Concurrency control to prevent overlapping pushes for the same branch (`concurrency: { group: ci-${{ github.ref }} }`)?

### How to inspect

```bash
sed -n '1,50p' .github/workflows/ci.yml
git grep -nE 'concurrency:|permissions:' .github/workflows/
git grep -nE 'paths-filter\|paths:' .github/workflows/ci.yml
```

### Red flags

- A `permissions: write-all` block — every job has full repo access.
- No concurrency guard — two rapid pushes race and one of them silently loses image-tag updates.
- `packages/shared/**` change does not trigger chain rebuild — chain runs against stale shared types.
- A workflow_dispatch path that only rebuilds `web` because the path filter still applied.

### Reference
[`BEST_PRACTICES.md §7.1, §7.2`](../BEST_PRACTICES.md), [`CLAUDE.md "CI/CD pipelines"`](../../CLAUDE.md).

---

## 2. Image tagging and registry

### Audit questions

- [ ] Images tagged `sha-${GITHUB_SHA::7}` ([`ci.yml:95`](../../.github/workflows/ci.yml) — yes)?
- [ ] No `:latest` tag pushed by CI (encourages mutable references)?
- [ ] All three services pushed to GHCR under `ghcr.io/aibob404/lagrangefi-{api,chain,web}`?
- [ ] BuildKit caching enabled (`cache-from: type=gha`, `cache-to: type=gha,mode=max`) per service ([`ci.yml:80-81, 113-114, 146-147`](../../.github/workflows/ci.yml) — yes)?
- [ ] No image push from a fork PR (would require trusting fork code with registry credentials)?
- [ ] Image labels include commit SHA, build timestamp, source-repo URL (OCI spec) for forensics?
- [ ] Registry retention configured (don't keep 1000 SHA tags forever)?

### How to inspect

```bash
git grep -nE 'tags:' .github/workflows/ci.yml
git grep -nE 'cache-from\|cache-to' .github/workflows/ci.yml
git grep -nE 'org\.opencontainers' apps/*/Dockerfile
```

### Red flags

- `tags: ghcr.io/.../lagrangefi-api:latest` alongside `:sha-xxxx` — silent drift if a deploy targets `:latest`.
- A buildx cache scoped wrong (`scope: ${{ github.ref }}`) — every PR gets a fresh cache, defeats the point.
- A push step with `if: github.event_name == 'pull_request'` — PRs from forks can't push, but should be checked anyway.

### Reference
[`BEST_PRACTICES.md §7.1`](../BEST_PRACTICES.md). [`ci.yml`](../../.github/workflows/ci.yml).

---

## 3. Auto-commit back to main

`update-manifests` job ([`ci.yml:149-188`](../../.github/workflows/ci.yml)) commits the test-overlay tag bump back to `main` with `[skip ci]`.

### Audit questions

- [ ] The bot commit name and email are `github-actions[bot]` (visible in audit logs as automation)?
- [ ] `[skip ci]` keeps the auto-commit from triggering an infinite build loop?
- [ ] The auto-commit only changes `k8s/overlays/test/kustomization.yaml` (never source, never `prod`)?
- [ ] The auto-commit can be reverted easily (one file, no logic)?
- [ ] Branch protection on `main` allows the bot to push (or the workflow uses a personal-access-token configured outside default `GITHUB_TOKEN` if branch protection blocks the default token)?
- [ ] If ever signed commits are required on `main`, automation is updated accordingly (otherwise PR-merging breaks)?

### How to inspect

```bash
sed -n '149,$p' .github/workflows/ci.yml

# Branch protection settings (requires gh API access)
gh api repos/aibob404/lagrangefi/branches/main/protection 2>/dev/null
```

### Red flags

- The bot commit modifies any file under `apps/` or `docs/` — broken expectation.
- The bot commit lacks `[skip ci]` and triggers another build.
- Branch protection on `main` blocks `github-actions[bot]` and the workflow silently fails on push.
- A `secrets.PAT_TOKEN` used to bypass branch protection — flag and require justification.

### Reference
[`BEST_PRACTICES.md §7`](../BEST_PRACTICES.md), [`ci.yml:182-188`](../../.github/workflows/ci.yml).

---

## 4. Tests in CI

**Current state:** [`ci.yml`](../../.github/workflows/ci.yml) runs only image builds. **No tests are executed in CI.** This is the single biggest CI gap.

### Audit questions

- [ ] Has a `test` job been added that runs `./gradlew test` (api), `npm test -w @lagrangefi/chain` (chain), and `npm test` (web, once configured)?
- [ ] Tests run **before** the image build, gating the build on a passing test suite?
- [ ] Test results uploaded as workflow artefacts (`actions/upload-artifact`)?
- [ ] Code coverage uploaded (e.g. Codecov action)?
- [ ] OpenAPI linting in CI (`@redocly/cli lint apps/chain/openapi.yaml`)?
- [ ] Linters run: ESLint for web/chain, ktlint/detekt for api, kubeconform for k8s?

### How to inspect

```bash
git grep -nE 'gradlew test|npm test|npm run test|vitest' .github/workflows/
git grep -nE 'eslint|kubeconform|kustomize build' .github/workflows/
git grep -nE 'redocly\|openapi-validator' .github/workflows/
```

### Red flags

- The CI builds a green image despite `npm run lint` exit code 1.
- A `vitest run` step that times out and is silently skipped on retry.
- Lint output goes to stdout but the step `continue-on-error`s — devs ignore it.

### Reference
[`testing.md §7`](testing.md), [`BEST_PRACTICES.md §7`](../BEST_PRACTICES.md).

---

## 5. Security scanning

### Audit questions

- [ ] Container image scanning in CI (`anchore/scan-action`, `aquasecurity/trivy-action`, or GHCR's built-in vulnerability scanner)?
- [ ] Source-level dependency scanning (`actions/dependency-review-action` on PRs)?
- [ ] `npm audit --audit-level=high` runs as part of the workflow (currently it can be added in <5 lines per workspace)?
- [ ] OWASP dependency-check for the api Gradle build?
- [ ] Secret-scanning enabled at the repo level (GitHub native — verify in repo settings)?
- [ ] Tokens used in CI scoped to single-purpose: `GITHUB_TOKEN` for image push only, no long-lived PAT?

### How to inspect

```bash
git grep -niE 'trivy|snyk|grype|anchore|dependency-review|dependency-check' .github/workflows/
git grep -niE 'npm audit\|gradle dependencyCheck' .github/workflows/
```

### Red flags

- A "we'll add scanning later" comment — almost never gets added.
- A scan step that warns on findings but doesn't fail the build — alert fatigue.
- A dependency scan running on a stale lockfile (workflow doesn't `npm ci` first).

### Reference
[`security.md §10`](security.md). [`BEST_PRACTICES.md §7`](../BEST_PRACTICES.md).

---

## 6. Test deploy (`deploy-test.yml`)

[`deploy-test.yml`](../../.github/workflows/deploy-test.yml) runs `workflow_dispatch` only. It SSHes into the cluster server, copies generated manifests, and applies them.

### Audit questions

- [ ] `kubectl rollout status` runs after `kubectl apply`, with a sane timeout (currently 120s — fine for small clusters)?
- [ ] Workflow **fails** the run on rollout timeout — currently the `||` fallback prints "rollout timed out" but **does not fail the step**, since `script_stop: true` only fails on commands that exit non-zero, and `||` swallows the error. **Flag this.**
- [ ] SSH credentials (`SSH_HOST`, `SSH_USER`, `SSH_KEY`) stored as GitHub Actions secrets, never echoed?
- [ ] No `set -x` enabled in the SSH script (would echo the kubectl token in logs)?
- [ ] No prod-deploy workflow at all yet — prod deploys are manual `kubectl apply -k k8s/overlays/prod` from an operator's machine? Confirm and consider whether to add a gated prod deploy workflow.
- [ ] If a prod deploy workflow is added: requires manual approval (Environments protection rule), pinned to a specific reviewer, and only deploys an SHA explicitly entered by the operator?

### How to inspect

```bash
sed -n '1,$p' .github/workflows/deploy-test.yml

# Search for prod deploy
git grep -niE 'overlays/prod\|prod-deploy\|deploy-prod' .github/workflows/
```

### Red flags

- The "rollout timed out" branch produces a green workflow — visible only by reading logs.
- A prod-deploy workflow auto-triggered on tag push without manual approval — one PR can deploy money-handling code to prod.
- An `appleboy/ssh-action` with the SSH key passed as `key:` (correct) but with the host in a `value` field (would commit it).
- `script_stop: true` not set — failed `kubectl apply` doesn't fail the workflow.

### Reference
[`BEST_PRACTICES.md §7.4 (rollout-status fail-fast)`](../BEST_PRACTICES.md), [`CLAUDE.md "CI/CD"`](../../CLAUDE.md). [`deploy-test.yml`](../../.github/workflows/deploy-test.yml).

---

## 7. Branch protection and review

### Audit questions

- [ ] `main` branch protected: PRs required, ≥ 1 approval, status checks must pass, no force-push?
- [ ] No "merge without review" exception even for the maintainer (signing-off is fine; bypass is not)?
- [ ] Stale review dismissal on new commits enabled?
- [ ] `CODEOWNERS` file exists for areas with high blast radius (e.g. `WalletService.kt`, `swap.ts`, `k8s/overlays/prod/`)?
- [ ] Required status checks include the build jobs (and once tests are in CI, those too)?
- [ ] Allow squash merges only? (Avoids merge-commit clutter; `[skip ci]` semantics simpler.)

### How to inspect

```bash
gh api repos/aibob404/lagrangefi/branches/main/protection 2>/dev/null | head -40

ls CODEOWNERS .github/CODEOWNERS 2>/dev/null
```

### Red flags

- Branch protection disabled or "include administrators" off — owner can self-merge unreviewed.
- No required status checks — green tick from a build that didn't actually run.
- CODEOWNERS pointing at users who left the project.

### Reference
[`BEST_PRACTICES.md §7`](../BEST_PRACTICES.md).

---

## 8. Workflow secrets and tokens

### Audit questions

- [ ] All secrets used in workflows have a stated purpose (in a comment near `${{ secrets.X }}` or in a centralised list)?
- [ ] No secret used outside the steps that need it (no `env: SECRET_X: ${{ secrets.X }}` at workflow level)?
- [ ] No `echo ${{ secrets.X }}` anywhere — even with masking, log artefacts can re-surface them?
- [ ] PAT tokens (if any) scoped to fine-grained per-repo, not classic full-account?
- [ ] Tokens rotated when an operator with access leaves the team?

### How to inspect

```bash
git grep -nE 'secrets\.' .github/workflows/
git grep -nE 'env:\s*$' .github/workflows/   # workflow-level env
```

### Red flags

- A `SSH_KEY` declared at workflow `env:` — every step has it, broader leak surface.
- A `secrets.PAT_TOKEN` used to bypass branch protection — never accepted without an audit-trail comment.
- `${{ inputs.something }}` echoed to logs — `workflow_dispatch` inputs are user-controlled.

### Reference
[`security.md §1, §10`](security.md), [`BEST_PRACTICES.md §7`](../BEST_PRACTICES.md).

---

## 9. Reproducibility

### Audit questions

- [ ] Dockerfiles use specific base-image versions (`node:22-alpine`, `eclipse-temurin:17-jdk-alpine`) — no `node:latest`?
- [ ] Lockfiles always honoured during build (`npm ci`, not `npm install`)?
- [ ] Gradle build uses `--no-daemon` in CI (avoids daemon state bleed) and a wrapper-locked Gradle version?
- [ ] Buildx multi-platform output **not** enabled by accident — building amd64 only is faster and matches the cluster nodes?
- [ ] No `RUN` step that depends on the host's network or time (e.g. `apt-get update` without pinning)?

### How to inspect

```bash
git grep -nE 'FROM ' apps/*/Dockerfile
git grep -nE 'npm install\|npm ci' apps/*/Dockerfile .github/workflows/
git grep -n 'platforms:' .github/workflows/
```

### Red flags

- `FROM node:alpine` (no major version) — breaks on Node 23 release.
- `RUN npm install` in Dockerfile — non-determinism.
- `--platform=linux/arm64,linux/amd64` set unnecessarily — slow CI.

### Reference
[`apps/*/Dockerfile`](../../apps/), [`BEST_PRACTICES.md §7`](../BEST_PRACTICES.md).

---

## 10. Pre-merge checks

### Audit questions

- [ ] Pull-request workflow runs on PRs (currently `ci.yml` only triggers on push to main and workflow_dispatch — **PRs from non-main branches do NOT trigger image builds, and tests are also absent**, see §4)?
- [ ] Even without image builds, at least lint and unit tests should run on PRs (gate merge on green)?
- [ ] PR template encourages a description (`/.github/PULL_REQUEST_TEMPLATE.md`)?
- [ ] PR labels (e.g. `area/api`, `area/chain`) routed to CODEOWNERS?

### How to inspect

```bash
git grep -nE 'pull_request:' .github/workflows/
ls .github/PULL_REQUEST_TEMPLATE.md .github/pull_request_template.md 2>/dev/null
```

### Red flags

- A PR can be merged with **zero** automation having run — verify by looking at the latest merged PR's checks tab.
- A push to a feature branch silently rebuilds `main` — wrong trigger configuration.
- A PR template asking for "what changed" but not "test plan" / "rollback plan".

### Reference
[`BEST_PRACTICES.md §7`](../BEST_PRACTICES.md).

---

## How to run this review

1. **Open a fresh Claude Code session.** Have `gh` CLI authenticated to the repo.
2. Walk top-to-bottom through sections 1 → 10. Run inspection commands. Paste output.
3. Tag findings:
   - **[critical]** an automation can deploy money-handling code to prod without review (no branch protection, no manual approval).
   - **[high]** tests / lints / security scans missing from CI; rollout-timeout silently passes.
   - **[medium]** PRs don't trigger any workflow; secrets exposed at workflow `env:` level; no PR template.
   - **[low]** style: workflow naming, comments, alphabetical ordering of jobs.
4. Recurring TODOs to track each pass:
   - Tests in CI (§4).
   - Security scanning (§5).
   - Rollout-timeout treated as failure (§6).
   - PR-trigger added to lint/test (§10).
   - Prod-deploy workflow with manual approval (§6) — open question whether to add.

A typical pass takes **30-45 minutes** plus optional time to query the GitHub API for branch-protection state.
