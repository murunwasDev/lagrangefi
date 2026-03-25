package fi.lagrange.plugins

import fi.lagrange.config.AppConfig
import fi.lagrange.model.RebalanceEvents
import fi.lagrange.services.ChainClient
import fi.lagrange.services.MintRequest
import java.util.UUID
import fi.lagrange.strategy.UniswapStrategy
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
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

@Serializable
data class StartStrategyRequest(
    val ethAmount: String = "0",
    val usdcAmount: String = "0",
    val feeTier: Int = 500,
    val rangePercent: Double = 0.05,
)

@Serializable
data class StartStrategyResponse(
    val success: Boolean,
    val tokenId: String? = null,
    val txHashes: List<String> = emptyList(),
    val error: String? = null,
)

// WETH / USDC on Arbitrum (token0 < token1 by address)
private const val WETH = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"
private const val USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831"

fun Application.configureRouting(chainClient: ChainClient, config: AppConfig, strategy: UniswapStrategy) {
    routing {
        get("/health") {
            call.respond(mapOf("status" to "ok"))
        }

        route("/api/v1") {
            get("/status") {
                call.respond(mapOf("rebalancer" to "running"))
            }

            get("/position") {
                val tokenId = strategy.currentTokenId
                if (tokenId.isBlank()) {
                    call.respond(HttpStatusCode.NoContent)
                    return@get
                }
                try {
                    val position = chainClient.getPosition(tokenId)
                    call.respond(position)
                } catch (e: Exception) {
                    call.respond(HttpStatusCode.ServiceUnavailable, mapOf("error" to (e.message ?: "chain service unavailable")))
                }
            }

            get("/pool-state") {
                try {
                    val tokenId = strategy.currentTokenId
                    val poolState = if (tokenId.isBlank()) {
                        chainClient.getPoolByPair(WETH, USDC, 500)
                    } else {
                        chainClient.getPoolState(tokenId)
                    }
                    call.respond(poolState)
                } catch (e: Exception) {
                    call.respond(HttpStatusCode.ServiceUnavailable, mapOf("error" to (e.message ?: "chain service unavailable")))
                }
            }

            post("/strategy/start") {
                val req = call.receive<StartStrategyRequest>()
                try {
                    // 1. Fetch current pool state to get current tick
                    val poolState = chainClient.getPoolByPair(WETH, USDC, req.feeTier)

                    // 2. Calculate tick range
                    val (tickLower, tickUpper) = strategy.calculateRange(
                        poolState.tick, req.feeTier, req.rangePercent
                    )

                    // 3. Mint the position on-chain
                    val mintResult = chainClient.mint(MintRequest(
                        ethAmount = req.ethAmount,
                        usdcAmount = req.usdcAmount,
                        feeTier = req.feeTier,
                        tickLower = tickLower,
                        tickUpper = tickUpper,
                        slippageTolerance = config.rebalancer.slippageTolerance,
                    ))

                    if (mintResult.success && mintResult.tokenId != null) {
                        // 4. Update the active position the strategy is tracking
                        strategy.updateTokenId(mintResult.tokenId)
                        call.respond(StartStrategyResponse(
                            success = true,
                            tokenId = mintResult.tokenId,
                            txHashes = mintResult.txHashes,
                        ))
                    } else {
                        call.respond(HttpStatusCode.UnprocessableEntity, StartStrategyResponse(
                            success = false,
                            error = mintResult.error ?: "Mint returned no tokenId",
                        ))
                    }
                } catch (e: Exception) {
                    call.respond(HttpStatusCode.InternalServerError, StartStrategyResponse(
                        success = false,
                        error = e.message ?: "Unknown error",
                    ))
                }
            }

            put("/strategy/token-id") {
                val body = call.receive<Map<String, String>>()
                val tokenId = body["tokenId"]
                if (tokenId.isNullOrBlank()) {
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to "tokenId is required"))
                    return@put
                }
                strategy.updateTokenId(tokenId)
                call.respond(mapOf("tokenId" to tokenId))
            }

            post("/strategy/close") {
                val tokenId = strategy.currentTokenId
                if (tokenId.isBlank()) {
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to "No active position to close"))
                    return@post
                }
                try {
                    val idempotencyKey = UUID.randomUUID().toString()
                    val result = chainClient.close(idempotencyKey, tokenId)
                    if (result.success) {
                        strategy.clearTokenId()
                        call.respond(mapOf("success" to true, "txHashes" to result.txHashes))
                    } else {
                        call.respond(HttpStatusCode.UnprocessableEntity, mapOf("success" to false, "error" to (result.error ?: "Close failed")))
                    }
                } catch (e: Exception) {
                    call.respond(HttpStatusCode.InternalServerError, mapOf("success" to false, "error" to (e.message ?: "Unknown error")))
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
