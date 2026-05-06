# Runbook: WALLET_ENCRYPTION_KEY rotation

`WALLET_ENCRYPTION_KEY` is the AES-256-GCM key that protects every user's BIP39 mnemonic / private key in the `wallets.encrypted_phrase` column (and Alpaca creds in `trader_settings.encrypted_api_*`). Lose it and every user must re-enter their wallet from scratch — there is no recovery.

This runbook covers three scenarios:

1. **Scheduled rotation** — periodic key change, no incident.
2. **Emergency rotation** — known/suspected compromise.
3. **Lost key** — recovery is not possible; only re-onboarding.

---

## Scenario 1 — Scheduled rotation (no compromise)

Current `WalletService` (`apps/api/src/main/kotlin/fi/lagrange/services/WalletService.kt`) only knows one key at a time, so rotation requires a brief api outage to re-encrypt every row in a single transaction.

### Pre-flight

- [ ] Pause all active strategies via the API (`PATCH /api/v1/strategies/:id/pause` for each), or accept that in-flight rebalances will fail and need retry. The api should be drained of in-progress chain calls before the migration.
- [ ] Take a fresh Postgres backup of the `wallets` and `trader_settings` tables. Store it encrypted with a key **different from** `WALLET_ENCRYPTION_KEY` (so this rotation doesn't make the backup unrecoverable too).
- [ ] Generate the new key: `openssl rand -base64 32`. Store it somewhere you'll still have access to in 30 minutes (password manager, not just your shell history).

### Migration

The simplest implementation is a one-shot Kotlin script run as a Job in the same namespace, with both old and new keys provided as env vars:

```kotlin
// scripts/RotateWalletKey.kt — write, build, run as a kubectl Job
fun main() {
    val oldKey = System.getenv("WALLET_ENCRYPTION_KEY_OLD") ?: error("missing")
    val newKey = System.getenv("WALLET_ENCRYPTION_KEY_NEW") ?: error("missing")
    DatabaseConfig.init(/* ... */)
    val oldSvc = WalletService(oldKey)
    val newSvc = WalletService(newKey)
    transaction {
        Wallets.selectAll().forEach { row ->
            val userId = row[Wallets.userId]
            val phrase = oldSvc.getDecryptedPhrase(userId)!!
            newSvc.upsertWallet(userId, phrase)
        }
        // Repeat for TraderSettings.encrypted_api_key / encrypted_api_secret via SecretEncryptor.
    }
    println("Rotated ${Wallets.selectAll().count()} wallets.")
}
```

### Cut-over

1. Apply the migration Job. Wait for completion. Verify count matches expectations.
2. Update `api-secret`:
   ```bash
   kubectl -n <ns> delete secret api-secret
   kubectl -n <ns> create secret generic api-secret \
     --from-literal=WALLET_ENCRYPTION_KEY=<NEW> \
     --from-literal=...  # all other keys unchanged
   ```
3. Restart the api: `kubectl -n <ns> rollout restart deployment/api`.
4. Smoke-test: log in as a real user, fetch `/me/wallet/balances`. If the balance returns, decryption succeeded. If you see "decryption failed" / "Tag mismatch" — the migration didn't cover that row. **Stop and investigate before deleting the old key.**
5. Hold on to the old key for at least 24h before destroying. If anything decrypts wrong, you'll need it.

---

## Scenario 2 — Emergency rotation (suspected compromise)

If `WALLET_ENCRYPTION_KEY` may have been exposed (k8s secret leaked, dev laptop stolen with a `.env` file, etc.):

1. **Move all funds first.** The encrypted phrases protect *future* operations, but if the key is leaked the attacker can already decrypt the existing DB rows by combining a DB dump with the leaked key. Move all non-trivial funds to a fresh wallet immediately. Treat existing wallets as compromised.
2. Then run Scenario 1's migration to re-encrypt with a new key.
3. Force-rotate all user wallets: invalidate the existing wallet rows and require each user to re-enter their phrase via `PUT /me/wallet`. There is no in-app flow for this in v1 — communicate with users out-of-band (email/Telegram).
4. Audit access: who had `kubectl get secret -n <ns> api-secret`? Rotate any other secrets they could have read (`JWT_SECRET`, `TELEGRAM_BOT_TOKEN`, `DATABASE_PASSWORD`).

---

## Scenario 3 — Lost key

The key is gone (bricked node, deleted secret with no backup, etc.). There is no recovery — AES-256-GCM is not breakable.

1. Truncate `wallets` and `trader_settings.encrypted_*` columns, or wipe rows.
2. Force every user to re-onboard their wallet via `PUT /me/wallet`.
3. Resume strategies once wallets are re-entered.

The point of this section is to make sure **#3 never happens**. Concrete preventive measures:

- The k8s secret is the only authoritative copy. Snapshot it to an offline password manager (1Password, Bitwarden) at creation time and after every rotation.
- The Postgres backup encryption key MUST be different from `WALLET_ENCRYPTION_KEY` — otherwise losing one loses both.
- Document who has access to the key in the team's secret index.

---

## Future improvement: dual-key support

Today's `WalletService` ctor takes a single key and `decrypt()` uses it directly. A backwards-compatible dual-key extension would:

- Accept `currentKey` and an optional `previousKey`.
- `decrypt()` tries `currentKey` first; on `AEADBadTagException`, retries with `previousKey`.
- `encrypt()` always uses `currentKey`.
- The migration Job becomes optional — every read silently re-encrypts with `currentKey` (write-back-on-read), and the old key can be dropped from config once a full `SELECT *` of `wallets` has succeeded.

This eliminates the rotation outage. Worth implementing before the first prod rotation.
