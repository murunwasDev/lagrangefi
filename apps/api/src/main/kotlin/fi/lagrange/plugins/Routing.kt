package fi.lagrange.plugins

import fi.lagrange.config.AppConfig
import fi.lagrange.model.RebalanceEvents
import fi.lagrange.services.ChainClient
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction

@Serializable
data class RebalanceEventDto(
    val id: Int,
    val tokenId: String,
    val status: String,
    val newTickLower: Int?,
    val newTickUpper: Int?,
    val newTokenId: String?,
    val txHashes: String?,
    val errorMessage: String?,
    val triggeredAt: String,
    val completedAt: String?,
)

fun Application.configureRouting(chainClient: ChainClient, config: AppConfig) {
    routing {
        get("/health") {
            call.respond(mapOf("status" to "ok"))
        }

        route("/api/v1") {
            get("/status") {
                call.respond(mapOf("rebalancer" to "running"))
            }

            get("/position") {
                try {
                    val position = chainClient.getPosition(config.rebalancer.positionTokenId)
                    call.respond(position)
                } catch (e: Exception) {
                    call.respond(HttpStatusCode.ServiceUnavailable, mapOf("error" to (e.message ?: "chain service unavailable")))
                }
            }

            get("/pool-state") {
                try {
                    val poolState = chainClient.getPoolState(config.rebalancer.positionTokenId)
                    call.respond(poolState)
                } catch (e: Exception) {
                    call.respond(HttpStatusCode.ServiceUnavailable, mapOf("error" to (e.message ?: "chain service unavailable")))
                }
            }

            get("/rebalances") {
                val events = transaction {
                    RebalanceEvents.selectAll()
                        .orderBy(RebalanceEvents.triggeredAt, org.jetbrains.exposed.sql.SortOrder.DESC)
                        .limit(50)
                        .map { row ->
                            RebalanceEventDto(
                                id = row[RebalanceEvents.id],
                                tokenId = row[RebalanceEvents.tokenId],
                                status = row[RebalanceEvents.status],
                                newTickLower = row[RebalanceEvents.newTickLower],
                                newTickUpper = row[RebalanceEvents.newTickUpper],
                                newTokenId = row[RebalanceEvents.newTokenId],
                                txHashes = row[RebalanceEvents.txHashes],
                                errorMessage = row[RebalanceEvents.errorMessage],
                                triggeredAt = row[RebalanceEvents.triggeredAt].toString(),
                                completedAt = row[RebalanceEvents.completedAt]?.toString(),
                            )
                        }
                }
                call.respond(events)
            }
        }
    }
}
