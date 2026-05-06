# Frontend Style Review Playbook

> Audit playbook for `apps/web` — React 19 + Vite + TypeScript + Tailwind. Targets the rules in [`BEST_PRACTICES.md §4 apps/web`](../BEST_PRACTICES.md).

**Scope:** `apps/web/src/**` only. Token storage and CORS belong to [`security.md`](security.md). Type contracts shared with the api are checked in [`api-contracts.md`](api-contracts.md).

**Reference:** [`BEST_PRACTICES.md §4`](../BEST_PRACTICES.md). Note that the section title says "shadcn/ui" but the current `package.json` does not actually include shadcn/ui or Radix — confirm whether this was removed (in which case `BEST_PRACTICES.md` needs updating) or never adopted.

---

## 1. API layer

The single chokepoint for HTTP traffic is [`apps/web/src/api.ts`](../../apps/web/src/api.ts) via `apiFetch<T>()`.

### Audit questions

- [ ] Every component that fetches data does so through a function in `api.ts`, never a raw `fetch()` call?
- [ ] Every `apiFetch` call site provides the generic `T` explicitly?
- [ ] All exported `api.ts` functions have explicit return types matching the domain types in [`types.ts`](../../apps/web/src/types.ts) (or `packages/shared` once unified)?
- [ ] Every `.then` / `await` is paired with explicit error handling — no `.catch(() => clearToken())` style swallowing of non-auth errors?
- [ ] No `as any` or unchecked `as SomeType` without a comment explaining why the type system can't express the constraint?
- [ ] `useEffect` calls that fetch on mount use `AbortController` and abort on unmount?

### How to inspect

```bash
# Raw fetch outside api.ts (allowed only inside api.ts itself)
git grep -nE '\bfetch\(' apps/web/src | grep -v 'apps/web/src/api\.ts'

# apiFetch call sites without an explicit generic
git grep -nE 'apiFetch\(' apps/web/src | grep -v 'apiFetch<'

# .catch handlers that ignore the error
git grep -nE '\.catch\(\(\) =>|\.catch\(_\s*=>|catch \{[^}]*\}' apps/web/src

# AbortController usage
git grep -n 'AbortController' apps/web/src
```

### Red flags

- A page that fetches in `useEffect` without an `AbortController` — when the user navigates away mid-fetch, the response sets state on an unmounted component (React 19 surfaces this as a warning, not an error, easy to miss).
- A `catch` block that calls `clearToken()` on every error rather than only on 401 — the user gets logged out because the strategy stats endpoint returned 500. See [`AuthContext.tsx:25`](../../apps/web/src/context/AuthContext.tsx) for an existing example: `.catch(() => clearToken())` inside the `useEffect` triggers logout for any failure to fetch `/me`, including transient 5xx.
- A direct `fetch()` call inside a component bypassing `apiFetch` — no auth header, no 401 handling.
- An `apiFetch('/...')` without `<Type>`, returning `Promise<unknown>` and `as`-cast at the caller.

### Reference
[`BEST_PRACTICES.md §4.1 API Layer`](../BEST_PRACTICES.md). Implementation: [`api.ts:29-52`](../../apps/web/src/api.ts).

---

## 2. State management

### Audit questions

- [ ] No global state library (Redux / Zustand / Jotai) introduced — auth via Context, page data via local `useState`?
- [ ] No derived state stored in `useState` + `useEffect` (use `useMemo` instead)?
- [ ] No mirror of remote data in a long-lived ref or context — each page fetches what it needs?
- [ ] If `useAsync` exists ([`BEST_PRACTICES.md §4.2`](../BEST_PRACTICES.md) recommends it), every async fetch in pages uses it instead of three separate `useState` calls?

### How to inspect

```bash
# Detect derived state anti-pattern: useState that is set inside useEffect from other state
git grep -nB2 -A8 'useEffect' apps/web/src/pages/ | grep -B2 -A4 'set[A-Z][a-zA-Z]*('

# Multiple useState calls per page (loading / error / data triplet)
git grep -nA1 'useState<.*loading' apps/web/src

# Confirm there is no global store
git grep -nE 'zustand|redux|jotai|recoil|valtio' apps/web/package.json apps/web/src
```

### Red flags

- A `useState` whose value is set in a `useEffect` whose only dependency is another `useState` value — almost always should be `useMemo`.
- A `Context` that exposes mutable state for non-auth concerns (positions, strategies). These belong in the page that owns the screen.
- Three near-identical `useState`s for `data`, `loading`, `error` in every page — extract `useAsync` per the SHOULD rule.

### Reference
[`BEST_PRACTICES.md §4.2 State Management`](../BEST_PRACTICES.md). [`AuthContext.tsx`](../../apps/web/src/context/AuthContext.tsx).

---

## 3. Error and loading states

### Audit questions

- [ ] Every page that fetches data renders **three** states explicitly (loading → error → success), never an empty page during fetch?
- [ ] Form submissions surface server error messages inline (not just `console.error`)?
- [ ] The submit button is disabled while a request is in flight?
- [ ] No silent `setError("")` after a failed request that overwrites a real error?

### How to inspect

```bash
# Every page should render an error / loading branch
git grep -nE 'if \(loading\)|if \(error\)' apps/web/src/pages

# Submit handlers that don't disable the button
git grep -nB2 -A20 'onSubmit' apps/web/src/pages | grep -E 'disabled=|disabled \?'

# console.error without a user-visible message (suspect)
git grep -nB2 -A3 'console\.error' apps/web/src
```

### Red flags

- `<button type="submit">` with no `disabled={loading}` — user double-clicks, two strategies created.
- A page that renders `<Layout>{data && <Content data={data} />}</Layout>` with no fallback for the unloaded state — looks broken instead of "loading".
- A try/catch around `await api.startStrategy(...)` that swallows the error to `console.error`, leaving the form looking like it submitted successfully.

### Reference
[`BEST_PRACTICES.md §4.3 Error States`](../BEST_PRACTICES.md), [`§4.5 Forms`](../BEST_PRACTICES.md).

---

## 4. Type safety

### Audit questions

- [ ] `StrategyStatus` value set is consistent everywhere ([`types.ts:24`](../../apps/web/src/types.ts) currently defines `INITIATING | ACTIVE | STOPPED_MANUALLY | STOPPED_ON_ERROR`; `BEST_PRACTICES.md §4.4` flags this as a known mismatch with `packages/shared`)? **This is a known bug — verify whether it has been fixed since the playbook was written.**
- [ ] No `as any` in source (zero tolerance)?
- [ ] No `// @ts-ignore` or `// @ts-expect-error` without a one-line justification on the next line?
- [ ] All `apiFetch<T>()` provide T explicitly (also covered in §1)?
- [ ] Runtime validation of API responses with `zod` / `valibot` if it has been adopted (the SHOULD in `BEST_PRACTICES.md §4.4`)?
- [ ] `tsc --noEmit` is clean and `npm run build` does not warn?

### How to inspect

```bash
# Type assertions hot-spots
git grep -nE '\bas any\b' apps/web/src
git grep -nE '@ts-(ignore|expect-error|nocheck)' apps/web/src
git grep -nE '\bas [A-Z][A-Za-z]+(?!\.)' apps/web/src   # `as SomeType`

# StrategyStatus values used at runtime
git grep -nE "['\"](INITIATING|ACTIVE|STOPPED_MANUALLY|STOPPED_ON_ERROR|active|paused|stopped)['\"]" apps/web/src

# Runtime schema check libs
git grep -nE 'from ["\x27]zod["\x27]|from ["\x27]valibot["\x27]' apps/web/src
```

### Red flags

- An `as any` followed by a property access — usually a sign the contract drifted and someone hushed the compiler.
- A `as` cast inside a `.then(...)` — type inference gave up, response shape is unverified.
- A `@ts-ignore` with no explanation directly above.

### Reference
[`BEST_PRACTICES.md §4.4 Type Safety`](../BEST_PRACTICES.md). [`types.ts`](../../apps/web/src/types.ts).

---

## 5. Forms and input validation

### Audit questions

- [ ] Required fields, numeric ranges, and address formats validated **client-side** before the request fires?
- [ ] Inline per-field errors, not just one global banner?
- [ ] Submit button disabled during in-flight request?
- [ ] If `react-hook-form` was adopted, every multi-field form uses it (no per-field `useState` proliferation)?
- [ ] Numeric inputs are `<input type="number">` or formatted-text with strict parsing? No accidental `parseInt` of `"" | undefined`?

### How to inspect

```bash
# Manual useState for form fields (suspect)
git grep -nE 'useState<string>\(""\)' apps/web/src/pages | wc -l

# react-hook-form adoption
grep -n 'react-hook-form' apps/web/package.json
git grep -nE "from 'react-hook-form'" apps/web/src

# Number parsing without guards
git grep -nE 'parseInt\(|parseFloat\(|Number\(' apps/web/src
```

### Red flags

- A `parseInt(input)` that produces `NaN` and is then sent to the server, which produces a 400 — could have been validated at the boundary.
- A wallet phrase input field that does not check word count (12/15/18/21/24) or hex shape before submitting.
- `onSubmit` that doesn't `e.preventDefault()`, causing a page reload that clears all React state.

### Reference
[`BEST_PRACTICES.md §4.5 Forms & Input Validation`](../BEST_PRACTICES.md).

---

## 6. Component size and boundaries

### Audit questions

- [ ] No component file over ~250 lines (BEST_PRACTICES says ~150, allow some breathing room before flagging)?
- [ ] Pages split into a container (data fetching, state, errors) and a view (pure, props-in)?
- [ ] Utility functions like `tickToPrice`, `formatUsd`, `computeAPY` live in their own `lib/` or `utils/` files, not at the top of `pages/*.tsx`?
- [ ] No component imports from another component's local helpers (signal that helpers should be promoted to a shared file)?

### How to inspect

```bash
# File sizes — anything over 250 lines is suspect
wc -l apps/web/src/components/*.tsx apps/web/src/pages/*.tsx | sort -nr

# Top-of-file utility functions in pages (anti-pattern)
git grep -nE '^function (formatUsd|tickToPrice|computeAPY|truncateAddress|priceFromSqrt)' apps/web/src/pages

# Cross-page helper imports
git grep -nE "from '\\.\\./pages" apps/web/src
```

### Red flags

- A page file > 1000 lines — current state: [`StrategyPage.tsx`](../../apps/web/src/pages/StrategyPage.tsx) is **~2300 lines**. This is the single biggest stylistic gap in the frontend. Flag at every review until split.
- Repeated copy-paste of `formatUsd` / `truncateAddress` across pages instead of a shared module.
- A "view" component that calls `apiFetch` directly — defeats the container/view split.

### Reference
[`BEST_PRACTICES.md §4.6 Component Design`](../BEST_PRACTICES.md).

---

## 7. Hooks discipline

### Audit questions

- [ ] `eslint-plugin-react-hooks` enabled (currently configured in [`eslint.config.js:15`](../../apps/web/eslint.config.js))?
- [ ] No `eslint-disable react-hooks/exhaustive-deps` without a comment justifying it?
- [ ] No conditional `useState` / `useEffect` (called inside `if`)? Should be impossible if the lint rule is on, but still grep.
- [ ] Custom hooks named `use*` and start with a verb (`useStrategy`, `useWalletBalances`)?

### How to inspect

```bash
# Disabled exhaustive-deps
git grep -nE 'eslint-disable.*exhaustive-deps' apps/web/src

# useEffect with empty deps that references state — bug-prone
git grep -nB3 -A8 'useEffect.*\[\]' apps/web/src

# Verify lint runs clean on commit
( cd apps/web && npm run lint )
```

### Red flags

- `// eslint-disable-next-line react-hooks/exhaustive-deps` followed by no comment — silent dependency lie.
- An effect with `[]` deps that closes over `userId` — first-render value is captured forever, breaks on user switch.
- A custom hook that returns an object with mutated fields — React's rules of hooks expects stable identities.

### Reference
[`BEST_PRACTICES.md §4`](../BEST_PRACTICES.md), [`eslint.config.js`](../../apps/web/eslint.config.js).

---

## 8. Styling — Tailwind discipline

The project uses Tailwind via `@tailwindcss/vite` ([`apps/web/package.json:22`](../../apps/web/package.json)). Inline `style={{ ... }}` should be the exception.

### Audit questions

- [ ] Tailwind utilities for the vast majority of styles? `style={{ ... }}` only for genuinely dynamic values (computed widths, percentages from data)?
- [ ] No raw colour literals in TSX (`#fff`, `rgb(...)`) — use Tailwind colour utilities or theme tokens?
- [ ] Tailwind `@apply` not used in CSS files (defeats the point of utility CSS)?
- [ ] Dark mode strategy consistent — either everything assumes dark (current state, slate-900 background) or class-based toggle is fully wired?
- [ ] No `!important` (`!`-prefixed Tailwind class) without a comment explaining why specificity needed forcing?

### How to inspect

```bash
# Inline styles count
git grep -nE 'style=\{\{' apps/web/src | wc -l

# Raw colours
git grep -nE '#[0-9a-fA-F]{3,8}|rgba?\(' apps/web/src

# @apply usage
git grep -n '@apply' apps/web/src

# Forced specificity
git grep -nE 'className=".*![a-z]' apps/web/src
```

### Red flags

- A growing pile of `style={{ ... }}` for static values that should be Tailwind classes.
- A custom CSS file accreting alongside Tailwind — pick one.
- Random colour hex codes that don't appear in `tailwind.config.js`.

### Reference
[`apps/web/tailwind.config.js`](../../apps/web/tailwind.config.js), [`apps/web/src/index.css`](../../apps/web/src/index.css), [`apps/web/src/App.css`](../../apps/web/src/App.css).

---

## 9. Routing and protected routes

### Audit questions

- [ ] All authenticated routes wrapped in `<ProtectedRoute>` ([`ProtectedRoute.tsx`](../../apps/web/src/components/ProtectedRoute.tsx))?
- [ ] No public route that expects a logged-in user (e.g. a profile link going to `/profile` without protection)?
- [ ] Catch-all route (`path="*"`) redirects, not 404s into oblivion ([`App.tsx:34`](../../apps/web/src/App.tsx))?
- [ ] Login page redirects to the protected route on success and clears errors on remount?
- [ ] No route bypasses `AuthProvider` (it should wrap the entire `<Routes>`)?

### How to inspect

```bash
# All Route definitions
git grep -nE 'path="' apps/web/src/App.tsx

# Each protected page rendered through ProtectedRoute?
git grep -nB1 -A1 'ProtectedRoute' apps/web/src/App.tsx
```

### Red flags

- A new page added in `App.tsx` without `<ProtectedRoute>` wrapping — silent unauthenticated access.
- A redirect to `/login` from inside a page rather than from `<ProtectedRoute>` — duplicated logic that drifts.
- `<BrowserRouter>` nested inside another router — multiple history instances, navigation breaks.

### Reference
[`App.tsx`](../../apps/web/src/App.tsx), [`ProtectedRoute.tsx`](../../apps/web/src/components/ProtectedRoute.tsx).

---

## 10. Build hygiene

### Audit questions

- [ ] `npm run build` succeeds with no TypeScript errors and no Vite warnings?
- [ ] `tsc --noEmit` matches `npm run build` (no separate TS errors hidden by Vite's transform)?
- [ ] `npm run lint` passes — no eslint warnings tolerated?
- [ ] Unused dependencies removed from `package.json` (e.g. `recharts` if no chart is rendered any more)?
- [ ] No `console.log` in shipped bundle (only `console.error` / `console.warn` for genuine error paths)?

### How to inspect

```bash
( cd apps/web && npm run lint )
( cd apps/web && npm run build )
git grep -nE 'console\.log\b' apps/web/src

# Unused-dep heuristic
( cd apps/web && npx depcheck )   # if depcheck installed
```

### Red flags

- Build succeeds but `tsc --noEmit` fails — Vite's `esbuild` is more permissive than `tsc`. Both must pass.
- A growing list of "TS-XXXX errors are pre-existing" excuses.
- `console.log` in a production code path — leaks data through DevTools and clutters logs at scale.

### Reference
[`apps/web/package.json scripts`](../../apps/web/package.json), [`apps/web/tsconfig.app.json`](../../apps/web/tsconfig.app.json).

---

## How to run this review

1. **Open a fresh Claude Code session.** Do not reuse one that recently edited frontend code.
2. From the repo root, walk top-to-bottom through sections 1 → 10. Run every command. Paste output as evidence.
3. For every audit question, mark **yes / no / partial**.
4. Tag findings:
   - **[critical]** breaks a key user flow or causes data loss / wrong actions.
   - **[high]** breaks `BEST_PRACTICES.md §4` MUST rules.
   - **[medium]** SHOULD violations or > 250-line files.
   - **[low]** style nits, missing comments, dead deps.
5. Open issues for `[critical]`/`[high]` findings before any follow-up work; do not in-line-fix during the review.
6. Particular attention items this codebase keeps regressing on:
   - **`StrategyPage.tsx` size** — track until below 500 lines.
   - **StrategyStatus type drift** ([`BEST_PRACTICES.md §4.4`](../BEST_PRACTICES.md)) — verify the canonical set is in `packages/shared` and both api/web import it.
   - **AuthContext error handling** ([`AuthContext.tsx:25`](../../apps/web/src/context/AuthContext.tsx)) — `.catch(() => clearToken())` swallows non-auth errors.

A typical full pass takes **30-60 minutes** on the current codebase.
