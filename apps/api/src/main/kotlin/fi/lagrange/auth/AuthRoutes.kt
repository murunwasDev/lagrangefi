package fi.lagrange.auth

import fi.lagrange.services.UserService
import fi.lagrange.services.WalletService
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.serialization.Serializable

@Serializable data class RegisterRequest(val username: String, val password: String)
@Serializable data class LoginRequest(val username: String, val password: String)
@Serializable data class AuthResponse(val token: String, val userId: Int, val username: String)
@Serializable data class MeResponse(val userId: Int, val username: String, val hasWallet: Boolean)
@Serializable data class WalletRequest(val phrase: String)

fun Route.authRoutes(userService: UserService, walletService: WalletService, chainClient: fi.lagrange.services.ChainClient) {
    route("/auth") {
        post("/register") {
            val req = call.receive<RegisterRequest>()
            try {
                val user = userService.register(req.username, req.password)
                val token = JwtConfig.generateToken(user.id, user.username)
                call.respond(HttpStatusCode.Created, AuthResponse(token, user.id, user.username))
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to e.message))
            }
        }

        post("/login") {
            val req = call.receive<LoginRequest>()
            val user = userService.authenticate(req.username, req.password)
                ?: return@post call.respond(HttpStatusCode.Unauthorized, mapOf("error" to "Invalid credentials"))
            val token = JwtConfig.generateToken(user.id, user.username)
            call.respond(AuthResponse(token, user.id, user.username))
        }
    }

    // Protected routes for the authenticated user
    authenticate("jwt") {
        route("/me") {
            get {
                val userId = call.getUserId()
                val user = userService.findById(userId)
                    ?: return@get call.respond(HttpStatusCode.NotFound, mapOf("error" to "User not found"))
                call.respond(MeResponse(userId, user.username, walletService.hasWallet(userId)))
            }

            route("/wallet") {
                /** Returns whether the user has a wallet configured (never returns the phrase) */
                get {
                    val userId = call.getUserId()
                    call.respond(mapOf("hasWallet" to walletService.hasWallet(userId)))
                }

                /** Store or replace the wallet phrase (mnemonic or raw private key) */
                put {
                    val userId = call.getUserId()
                    val req = call.receive<WalletRequest>()
                    if (req.phrase.isBlank()) {
                        return@put call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Phrase cannot be blank"))
                    }
                    walletService.upsertWallet(userId, req.phrase)
                    call.respond(mapOf("ok" to true))
                }

                /** Returns ETH and USDC balances for the user's configured wallet */
                get("/balances") {
                    val userId = call.getUserId()
                    val phrase = walletService.getDecryptedPhrase(userId)
                        ?: return@get call.respond(HttpStatusCode.BadRequest, mapOf("error" to "No wallet configured"))
                    try {
                        val balances = chainClient.getWalletBalances(phrase)
                        call.respond(balances)
                    } catch (e: Exception) {
                        call.respond(HttpStatusCode.ServiceUnavailable, mapOf("error" to (e.message ?: "chain service unavailable")))
                    }
                }
            }
        }
    }
}
