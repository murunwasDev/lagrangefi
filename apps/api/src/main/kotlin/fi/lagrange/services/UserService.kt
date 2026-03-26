package fi.lagrange.services

import fi.lagrange.model.Users
import kotlinx.datetime.Clock
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import org.mindrot.jbcrypt.BCrypt

data class UserRecord(
    val id: Int,
    val username: String,
)

class UserService {

    /** Register a new user. Throws IllegalArgumentException if username is taken. */
    fun register(username: String, password: String): UserRecord {
        require(username.length in 3..64) { "Username must be 3–64 characters" }
        require(password.length >= 8) { "Password must be at least 8 characters" }

        val hash = BCrypt.hashpw(password, BCrypt.gensalt(12))
        val now = Clock.System.now()

        return transaction {
            val existing = Users.selectAll().where { Users.username eq username }.firstOrNull()
            if (existing != null) throw IllegalArgumentException("Username already taken")

            val id = Users.insert {
                it[Users.username] = username
                it[passwordHash] = hash
                it[createdAt] = now
            } get Users.id

            UserRecord(id = id, username = username)
        }
    }

    /** Authenticate a user. Returns UserRecord on success, null on failure. */
    fun authenticate(username: String, password: String): UserRecord? = transaction {
        val row = Users.selectAll().where { Users.username eq username }.firstOrNull()
            ?: return@transaction null
        if (!BCrypt.checkpw(password, row[Users.passwordHash])) return@transaction null
        UserRecord(id = row[Users.id], username = row[Users.username])
    }

    /** Lookup a user by ID. Returns null if not found. */
    fun findById(userId: Int): UserRecord? = transaction {
        Users.selectAll().where { Users.id eq userId }.firstOrNull()
            ?.let { UserRecord(id = it[Users.id], username = it[Users.username]) }
    }
}
