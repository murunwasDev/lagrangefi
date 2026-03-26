package fi.lagrange.auth

import com.auth0.jwt.JWT
import com.auth0.jwt.algorithms.Algorithm
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.auth.jwt.*
import io.ktor.server.response.*
import java.util.Date

object JwtConfig {
    private const val ISSUER = "lagrangefi"
    private const val AUDIENCE = "lagrangefi-web"
    private const val VALIDITY_MS = 24 * 60 * 60 * 1000L // 24 hours

    private lateinit var algorithm: Algorithm

    fun init(secret: String) {
        algorithm = Algorithm.HMAC256(secret)
    }

    fun generateToken(userId: Int, username: String): String =
        JWT.create()
            .withIssuer(ISSUER)
            .withAudience(AUDIENCE)
            .withClaim("userId", userId)
            .withClaim("username", username)
            .withExpiresAt(Date(System.currentTimeMillis() + VALIDITY_MS))
            .sign(algorithm)

    fun configureKtor(app: Application) {
        app.install(Authentication) {
            jwt("jwt") {
                realm = "lagrangefi"
                verifier(
                    JWT.require(algorithm)
                        .withIssuer(ISSUER)
                        .withAudience(AUDIENCE)
                        .build()
                )
                validate { credential ->
                    val userId = credential.payload.getClaim("userId").asInt()
                    if (userId != null) JWTPrincipal(credential.payload) else null
                }
                challenge { _, _ ->
                    call.respond(HttpStatusCode.Unauthorized, mapOf("error" to "Invalid or expired token"))
                }
            }
        }
    }
}

/** Extract the authenticated userId from a JWT-protected call */
fun ApplicationCall.getUserId(): Int =
    principal<JWTPrincipal>()!!.payload.getClaim("userId").asInt()
