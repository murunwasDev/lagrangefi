package fi.lagrange.services

import fi.lagrange.model.Wallets
import kotlinx.datetime.Clock
import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.transactions.transaction
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Handles wallet phrase storage with AES-256-GCM encryption.
 *
 * The encryption key is a Base64-encoded 32-byte value stored in WALLET_ENCRYPTION_KEY env var.
 * Each encrypted value is: base64(IV[12] + ciphertext+tag[variable])
 */
class WalletService(encryptionKeyBase64: String) {

    private val keyBytes: ByteArray = Base64.getDecoder().decode(encryptionKeyBase64).also {
        require(it.size == 32) { "WALLET_ENCRYPTION_KEY must be exactly 32 bytes (base64-encoded)" }
    }

    // --- Encryption helpers ---

    private fun encrypt(plaintext: String): String {
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(128, iv))
        val encrypted = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return Base64.getEncoder().encodeToString(iv + encrypted)
    }

    private fun decrypt(cipherBase64: String): String {
        val combined = Base64.getDecoder().decode(cipherBase64)
        val iv = combined.copyOfRange(0, 12)
        val ciphertext = combined.copyOfRange(12, combined.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(ciphertext), Charsets.UTF_8)
    }

    // --- Public API ---

    /** Store or replace a user's wallet phrase (mnemonic or private key). Encrypted at rest. */
    fun upsertWallet(userId: Int, phrase: String) {
        val encrypted = encrypt(phrase.trim())
        val now = Clock.System.now()
        transaction {
            val existing = Wallets.selectAll().where { Wallets.userId eq userId }.firstOrNull()
            if (existing == null) {
                Wallets.insert {
                    it[Wallets.userId] = userId
                    it[encryptedPhrase] = encrypted
                    it[createdAt] = now
                    it[updatedAt] = now
                }
            } else {
                Wallets.update({ Wallets.userId eq userId }) {
                    it[encryptedPhrase] = encrypted
                    it[updatedAt] = now
                }
            }
        }
    }

    /** Returns true if the user has a wallet configured. */
    fun hasWallet(userId: Int): Boolean = transaction {
        Wallets.selectAll().where { Wallets.userId eq userId }.any()
    }

    /**
     * Decrypt and return the wallet phrase for a user.
     * Returns null if no wallet is configured.
     * The returned phrase is a raw private key (0x...) or BIP39 mnemonic.
     */
    fun getDecryptedPhrase(userId: Int): String? = transaction {
        Wallets.selectAll()
            .where { Wallets.userId eq userId }
            .firstOrNull()
            ?.get(Wallets.encryptedPhrase)
    }?.let { decrypt(it) }
}
