package fi.lagrange.plugins

import fi.lagrange.strategy.UniswapStrategy
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*

fun Application.configureRouting(strategy: UniswapStrategy) {
    routing {
        get("/health") {
            call.respond(mapOf("status" to "ok"))
        }

        // API routes — to be expanded with full position/history endpoints
        route("/api/v1") {
            get("/status") {
                call.respond(mapOf("rebalancer" to "running"))
            }
        }
    }
}
