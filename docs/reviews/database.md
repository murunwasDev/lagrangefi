# Database Review Playbook

> Audit playbook for the lagrangefi PostgreSQL schema, the Exposed `Tables.kt` definitions, and the `.claude/skills/db/schema.md` reference.

**Scope:**
- Schema definitions in [`apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt`](../../apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt)
- Bootstrap and manual migrations in [`apps/api/src/main/kotlin/fi/lagrange/config/DatabaseConfig.kt`](../../apps/api/src/main/kotlin/fi/lagrange/config/DatabaseConfig.kt)
- Skill reference [`.claude/skills/db/schema.md`](../../.claude/skills/db/schema.md) — **must be kept in sync with `Tables.kt`** per [`CLAUDE.md`](../../CLAUDE.md)
- Index strategy, retention, type discipline

**Out of scope:** Application-level Exposed usage (`transaction { }`, ownership checks, N+1) → [`api-style.md`](api-style.md). Numerical correctness of values stored in columns → [`numerical-correctness.md`](numerical-correctness.md).

**Reference:** [`BEST_PRACTICES.md §2.2 Database`](../BEST_PRACTICES.md), [`CLAUDE.md "Documentation"`](../../CLAUDE.md).

---

## 1. Schema source-of-truth and drift detection

The project has two representations of the schema:

1. **Authoritative:** `Tables.kt` (Exposed DSL) — drives `SchemaUtils.createMissingTablesAndColumns` on boot.
2. **Reference for the `/db` skill:** `.claude/skills/db/schema.md` — markdown table per Postgres table.

Per [`CLAUDE.md`](../../CLAUDE.md): _"Must be kept in sync with Tables.kt. Any time you add, remove, or rename a table or column in Tables.kt, update schema.md in the same commit."_

### Audit questions

- [ ] Every `object Foo : Table("foos")` in `Tables.kt` has a matching `## foos` section in `schema.md`?
- [ ] Every column in `Tables.kt` appears in the corresponding `schema.md` table with the right type?
- [ ] Every `varchar` or `decimal` precision matches between code and skill?
- [ ] No table in `schema.md` that no longer exists in `Tables.kt` (orphaned doc)?
- [ ] No "default" value documented in `schema.md` that contradicts the code?
- [ ] Status enum values in `schema.md` (`status: varchar (...)`) match the comment in `Tables.kt` and the constants used at runtime?

### How to inspect

```bash
# Tables in code vs skill
diff \
  <(awk '/^object [A-Z][A-Za-z]+ : Table\("[a-z_]+"\)/ {match($0, /Table\("[a-z_]+"\)/); print substr($0, RSTART+7, RLENGTH-9)}' apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt | sort) \
  <(awk '/^## [a-z_]+/ {print $2}' .claude/skills/db/schema.md | sort)

# Column drift sample for a single table
git grep -n 'val ' apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt | grep -A0 "Strategies"
sed -n '/^## strategies/,/^## /p' .claude/skills/db/schema.md

# Status enum drift
grep -B1 -A1 'INITIATING\|ACTIVE\|STOPPED_MANUALLY\|STOPPED_ON_ERROR\|active\|paused\|stopped' apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt .claude/skills/db/schema.md apps/api/src/main/kotlin/fi/lagrange/model/StatusConstants.kt
```

### Red flags

- A table renamed in `Tables.kt` but the old name still in `schema.md` (currently `strategy_events` in code vs `rebalance_events` in `schema.md` — **this is real drift at time of writing**, flag every review until fixed).
- A new column added in `Tables.kt` (e.g. `swap_cost_*`, `price_drift_*`, `pending_token0`) but missing from `schema.md`.
- Status values out of sync between code (`INITIATING | ACTIVE | STOPPED_MANUALLY | STOPPED_ON_ERROR`) and `schema.md` (`active | paused | stopped`).
- A `decimal(18, 2)` in code documented as plain `decimal` in `schema.md` — precision matters when chaining queries.

### Reference
[`CLAUDE.md`](../../CLAUDE.md), [`Tables.kt`](../../apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt), [`.claude/skills/db/schema.md`](../../.claude/skills/db/schema.md).

---

## 2. Migration strategy

The project uses `SchemaUtils.createMissingTablesAndColumns` on app boot — no Flyway, no Liquibase. Manual `exec("CREATE INDEX ...")` for things `SchemaUtils` cannot manage.

### Audit questions

- [ ] Every schema change goes through `SchemaUtils.createMissingTablesAndColumns` plus, if needed, an idempotent `CREATE ... IF NOT EXISTS` exec block in `DatabaseConfig.init()`?
- [ ] No destructive change relied on in production: `SchemaUtils` will **add** columns/tables but **never** rename or drop them?
- [ ] Renames are done as **add new column → backfill → switch reads → drop old** across multiple deploys, never a single PR?
- [ ] Drop-column or drop-table operations have an explicit, reviewed plan and only run via SQL applied out-of-band — there is no production "drop" code path?
- [ ] Does anyone have a snapshot of the current production schema (`pg_dump --schema-only`) committed somewhere or stored as a known artefact, so disaster recovery has a known starting point?
- [ ] Is a Flyway / Liquibase / sqlx-style migration tool on the roadmap? (`SchemaUtils` is fine for now but does not version, does not record applied changes, and does not refuse risky ops.)

### How to inspect

```bash
# All exec("...") statements in init — these are the manual migrations
sed -n '/transaction \{/,/^    }/p' apps/api/src/main/kotlin/fi/lagrange/config/DatabaseConfig.kt

# Any SchemaUtils.drop / SchemaUtils.statementsRequiredForDatabaseMigration
git grep -nE 'SchemaUtils\.(drop|statementsRequired)' apps/api/src

# Migration tooling
ls apps/api/src/main/resources/db/migration 2>/dev/null
git grep -niE 'flyway|liquibase' apps/api/build.gradle.kts
```

### Red flags

- A `SchemaUtils.drop(...)` call anywhere outside test setup.
- A `removed col` comment in `Tables.kt` with the column actually missing — `SchemaUtils` won't drop it from prod, so prod has the column dangling.
- An `exec("ALTER TABLE ... DROP COLUMN ...")` in `init()` — this runs on **every boot** and may fail repeatedly if the column was already dropped.
- A change to a `default(...)` value expected to retroactively fix existing rows — it doesn't; existing rows keep their old value.

### Reference
[`BEST_PRACTICES.md §2.2 Database`](../BEST_PRACTICES.md), [`DatabaseConfig.kt`](../../apps/api/src/main/kotlin/fi/lagrange/config/DatabaseConfig.kt).

---

## 3. Indexes

Every column used in a `WHERE`, `ORDER BY`, `JOIN`, or `GROUP BY` should have an index. Foreign keys are not auto-indexed by Postgres.

### Audit questions

- [ ] `strategies.user_id` has an index? **Currently** added via manual `exec("CREATE INDEX IF NOT EXISTS strategies_user_id ON strategies(user_id);")` in [`DatabaseConfig.kt:42`](../../apps/api/src/main/kotlin/fi/lagrange/config/DatabaseConfig.kt) — verify still present.
- [ ] `wallets.user_id` is a unique index ([`Tables.kt:16`](../../apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt))?
- [ ] `strategy_events.strategy_id` has an index (it's a heavy query path: list events by strategy)?
- [ ] `strategy_events.idempotency_key` is a unique index ([`Tables.kt:89`](../../apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt) — yes)?
- [ ] `strategy_events.triggered_at` has an index if event listing orders by it?
- [ ] `rebalance_details.strategy_id` has an index?
- [ ] `chain_transactions.strategy_event_id` has an index?
- [ ] `chain_transactions.tx_hash` is unique ([`Tables.kt:132`](../../apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt) — yes)?
- [ ] `strategy_snapshots.strategy_id` has an index, and `(strategy_id, snapshot_at)` composite if range-scanned by time?
- [ ] No "index for every column" anti-pattern — indexes on rarely-queried columns are write overhead?

### How to inspect

```bash
# Indexes declared via Exposed DSL
git grep -nE '\.index\(\)|\.uniqueIndex\(\)' apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt

# Manual exec("CREATE INDEX ...") in init
git grep -nE 'CREATE INDEX' apps/api/src/main/kotlin/fi/lagrange/config

# Live: connect to test DB via the /db skill and run \di
# or: SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename;
```

### Red flags

- A `WHERE strategy_id = ?` query path with no index on `strategy_id` — silent linear scan.
- A `userId` column on a new table without `.index()` — repeats the historical mistake.
- A composite index where a single-column would suffice (or vice versa) without a comment explaining why.
- An `EXPLAIN` of `getEventHistory` showing a Seq Scan over `strategy_events` — open TODO in `BEST_PRACTICES.md §2.2`.

### Reference
[`BEST_PRACTICES.md §2.2`](../BEST_PRACTICES.md), [`Tables.kt`](../../apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt), [`DatabaseConfig.kt`](../../apps/api/src/main/kotlin/fi/lagrange/config/DatabaseConfig.kt).

---

## 4. Type discipline

Token amounts are arbitrary-precision integers (up to 78 decimal digits — uint256). Money values are USD with 2 decimals. Prices and percentages have their own scales.

### Audit questions

- [ ] Raw token amounts stored as `varchar(78)` (decimal string) — never `decimal(...)` or `bigint`?
- [ ] Tick values (`new_tick_lower`, `new_tick_upper`) are `integer` (signed, fits Uniswap's tick range ±887272)?
- [ ] Gas in wei stored as `bigint` (`Long`) — fits up to ~9.2×10^18 wei (~9.2 ETH at 1 gwei)? **Total gas across many rebalances may exceed this** — flag if cumulative `strategy_stats.gas_cost_wei` ever needs to be `numeric`.
- [ ] USD aggregates stored as `decimal(18, 2)` — i.e. up to 999,999,999,999,999.99 USD?
- [ ] ETH price stored as `decimal(18, 8)` — 8 decimals matches Chainlink convention?
- [ ] Percentages stored as `decimal(8, 4)` — up to 9999.9999 (overkill for percent, but explicit)?
- [ ] No `double` for any column that participates in money math? `time_in_range_pct` is currently `double` — fine because it's an analytic ratio, not money.
- [ ] No `varchar(255)` defaults — every text column has a thought-through length, or is `text`?

### How to inspect

```bash
# Token-amount columns must be varchar(78)
git grep -nE 'varchar\("(token0|token1|.*amount.*|fees_collected.*|swap_cost_(amount|token).*|pending_.*|initial_token.*|end_token.*)' apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt

# Anything declared as 'double' — confirm it's not money
git grep -nE '\.double\(' apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt

# decimal precisions
git grep -nE '\.decimal\(' apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt
```

### Red flags

- A new column for a token amount declared `decimal(18, 2)` — silent loss for any value above ~10^16 wei (well below 1 ETH for 18-decimal tokens).
- `gas_cost_wei` becoming `decimal(...)` to "be consistent" — wastes space, no benefit.
- A `double` column added for fees or USD aggregates — flag immediately.
- `varchar(20)` for status tightening to `varchar(15)` while a longer enum value is in flight.

### Reference
[`BEST_PRACTICES.md §1.6`](../BEST_PRACTICES.md), [`§2.2`](../BEST_PRACTICES.md), [`numerical-correctness.md`](numerical-correctness.md).

---

## 5. Constraints, defaults, nullability

### Audit questions

- [ ] Every nullable column has a documented reason — null is not a synonym for "I forgot to default"?
- [ ] Every `.default(...)` matches a sane post-bootstrap value (no `default("0")` for a USD field that should be NULL until measured)?
- [ ] Foreign keys actually defined (`.references(...)`) on every relational column? `RebalanceDetails.strategyId` references both `Strategies.id` (FK) and the `strategy_event_id`'s `StrategyEvents.id`?
- [ ] The Postgres trigger `trg_check_rebalance_details_strategy_id` ([`DatabaseConfig.kt:57-60`](../../apps/api/src/main/kotlin/fi/lagrange/config/DatabaseConfig.kt)) still in place to enforce the denormalisation invariant?
- [ ] Cascade behaviour considered: deleting a `Strategy` would cascade to `Strategies → StrategyStats → StrategyEvents → RebalanceDetails / ChainTransactions / StrategySnapshots`? Currently `references` is a constraint without an `ON DELETE` clause — any delete on `strategies` will fail unless children are removed first.
- [ ] No "soft-delete" flag added without a clear retention plan?

### How to inspect

```bash
# Nullable columns
git grep -nE '\.nullable\(\)' apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt

# Foreign keys
git grep -nE '\.references\(' apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt

# Defaults
git grep -nE '\.default\(' apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt

# Live: confirm trigger exists
# SELECT tgname, tgrelid::regclass FROM pg_trigger WHERE tgname LIKE 'trg_%';
```

### Red flags

- A new column added without a comment about why it's nullable.
- A `.references(...)` removed during a refactor — orphaned rows accumulate.
- Trigger silently dropped because the migration recreated the table — `DROP TRIGGER IF EXISTS` only fires if `init()` runs again, which won't happen mid-uptime.

### Reference
[`Tables.kt`](../../apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt), [`DatabaseConfig.kt`](../../apps/api/src/main/kotlin/fi/lagrange/config/DatabaseConfig.kt).

---

## 6. Retention and growth

A strategy polling every 60 seconds writes ~525 k rows per year per strategy (per [`BEST_PRACTICES.md §2.2 TODO`](../BEST_PRACTICES.md)).

### Audit questions

- [ ] A retention policy is defined for `strategy_events`, `rebalance_details`, `chain_transactions`, `strategy_snapshots`?
- [ ] Cleanup mechanism exists (CronJob, background coroutine, or SQL-side `pg_cron`) — even if disabled in dev, present in prod?
- [ ] Retention numbers documented in `BEST_PRACTICES.md` or this playbook (e.g. 90 days for events, 1 year for snapshots)?
- [ ] DB size monitored; alert when `pg_database_size('lagrange')` exceeds a threshold?
- [ ] Largest tables identified (`SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC`) — are they expected?

### How to inspect

```bash
# Cleanup CronJob in k8s
git grep -rn 'cleanup\|retention' k8s/

# Background cleanup logic in api
git grep -niE 'cleanup|retention|prune|delete from' apps/api/src

# Live (via /db skill):
# SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid))
# FROM pg_stat_user_tables ORDER BY n_live_tup DESC;
```

### Red flags

- No retention discussion anywhere — by year three the events table is 25 m+ rows per strategy.
- A retention CronJob `concurrencyPolicy: Allow` — overlap can deadlock with a deploy.
- A cleanup that runs `DELETE FROM strategy_events WHERE triggered_at < NOW() - INTERVAL '90 days'` without a `LIMIT` — locks the table.

### Reference
[`BEST_PRACTICES.md §2.2 (CONSIDER)`](../BEST_PRACTICES.md).

---

## 7. Read patterns and N+1

### Audit questions

- [ ] Event-history endpoints fetch related rows (`RebalanceDetails`, `ChainTransactions`) via JOIN or single batched `WHERE strategyEventId IN (...)`, not in a loop?
- [ ] No service function returns a `List<X>` and then re-queries each `x` for related fields (open TODO `StrategyService.kt:366-424`)?
- [ ] Pagination on event-history endpoints (no unbounded list response)?
- [ ] The `/api/v1/strategies/:id/rebalances` route has a documented row-count cap (current default is 50; what is the max allowed)?

### How to inspect

```bash
# Loop-then-query pattern
git grep -nB2 -A5 '\.map \{' apps/api/src/main/kotlin/fi/lagrange/services | grep -E 'select|where'

# Pagination params
git grep -nE 'limit|offset|pageSize|pageToken' apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt
```

### Red flags

- A `.map { id -> transaction { ... } }` — N+1, plus N transactions.
- An endpoint that returns 1000+ rows by default — frontend pagination won't help if api buffers them all.
- A reading endpoint inside a `transaction { }` that holds the connection while serialising the response.

### Reference
[`BEST_PRACTICES.md §2.2`](../BEST_PRACTICES.md), [`api-style.md §2`](api-style.md).

---

## 8. Schema invariants enforced in DB (defence in depth)

### Audit questions

- [ ] `trg_check_rebalance_details_strategy_id` trigger present and matches the version in [`DatabaseConfig.kt:46-61`](../../apps/api/src/main/kotlin/fi/lagrange/config/DatabaseConfig.kt)?
- [ ] If new denormalisation is added, a corresponding trigger or `CHECK` constraint is added in the same PR?
- [ ] No CHECK constraints would be more useful (e.g. `CHECK (status IN ('INITIATING','ACTIVE','STOPPED_MANUALLY','STOPPED_ON_ERROR'))`) — flag what's possible without disrupting deploys?

### How to inspect

```bash
# Triggers
# Live: SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname NOT LIKE 'pg_%';

# CHECK constraints
# Live: SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE contype = 'c';
```

### Red flags

- A trigger silently disabled (`ALTER TABLE ... DISABLE TRIGGER ALL`) for a one-off backfill, never re-enabled.
- A status-enum constraint that lags behind a new status value — every strategy create with the new status fails until constraint is updated.

### Reference
[`DatabaseConfig.kt`](../../apps/api/src/main/kotlin/fi/lagrange/config/DatabaseConfig.kt).

---

## 9. Backups and disaster recovery

### Audit questions

- [ ] Postgres backups configured (e.g. `pg_dump` CronJob, `pg_basebackup`, or managed-Postgres snapshots)?
- [ ] Backup retention documented?
- [ ] Restore procedure tested at least once on a copy?
- [ ] Backup contents include `users` and `wallets` (encrypted phrases) — and the operator team understands those rows are recoverable but useless without `WALLET_ENCRYPTION_KEY`?
- [ ] Backup encryption key separate from `WALLET_ENCRYPTION_KEY` (rotating one shouldn't fate-share with the other)?

### How to inspect

```bash
# Backup CronJob in k8s
git grep -rn 'pg_dump\|pg_basebackup\|backup' k8s/

# Documentation
ls docs/runbooks 2>/dev/null
git grep -ni 'restore\|backup' docs/
```

### Red flags

- "We rely on cloud-provider snapshots" — fine, but verify retention period and that operators can self-serve a restore.
- No restore drill ever performed.
- Backup file containing `users + wallets` accessible to anyone with cluster log access.

### Reference
[`security.md §11`](security.md), [`infrastructure.md`](infrastructure.md).

---

## How to run this review

1. **Open a fresh Claude Code session.** Use the `/db` skill if you want to run live `SELECT`s against the test database.
2. Walk top-to-bottom through sections 1 → 9. For each: run the inspection commands, paste output, mark **yes / no / partial**.
3. Tag findings:
   - **[critical]** data loss potential, missing FK that lets orphaned wallets exist, schema drift causing the `/db` skill to produce wrong answers.
   - **[high]** missing index causing observable latency, missing trigger after a new denormalisation, no retention plan.
   - **[medium]** doc drift (`schema.md` vs code), `varchar(255)` not thought-through.
   - **[low]** cosmetic table-naming or capitalisation issues.
4. If `schema.md` drift is found, fix it in the same review session if trivial; otherwise file a follow-up.
5. Recurring TODOs to track each pass:
   - `schema.md` ↔ `Tables.kt` drift (§1) — every new column / renamed table should have already updated `schema.md`.
   - Status-enum drift (§1) — `INITIATING|ACTIVE|STOPPED_MANUALLY|STOPPED_ON_ERROR` vs `active|paused|stopped`.
   - Retention policy not yet enforced (§6).
   - Migration tool decision (`SchemaUtils` vs Flyway/Liquibase) — §2.

A typical pass takes **30-60 minutes** plus optional time to run live queries against the test DB.
