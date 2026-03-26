package fi.lagrange.plugins

import fi.lagrange.auth.authRoutes
import fi.lagrange.auth.getUserId
import fi.lagrange.services.ChainClient
import fi.lagrange.services.StrategyService
import fi.lagrange.services.UserService
import fi.lagrange.services.WalletService
import fi.lagrange.strategy.StrategyScheduler
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.serialization.Serializable

@Serializable
data class CreateStrategyRequestDto(
    val name: String,
    val tokenId: String,
    val rangePercent: Double = 0.05,
    val slippageTolerance: Double = 0.005,
    val pollIntervalSeconds: Long = 60,
)

@Serializable
data class StartStrategyRequestDto(
    val name: String,
    val ethAmount: String,
    val usdcAmount: String,
    val feeTier: Int,
    val rangePercent: Double = 0.05,
    val slippageTolerance: Double = 0.005,
    val pollIntervalSeconds: Long = 60,
)

@Serializable
data class StartStrategyResponseDto(
    val tokenId: String,
    val txHashes: List<String>,
)

private val WETH = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"
private val USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831"

private fun calcTicks(currentTick: Int, rangePercent: Double, feeTier: Int): Pair<Int, Int> {
    val spacing = when (feeTier) { 100 -> 1; 500 -> 10; 3000 -> 60; else -> 200 }
    val log1_0001 = Math.log(1.0001)
    val rawLower = currentTick + (Math.log(1.0 - rangePercent) / log1_0001).toInt()
    val rawUpper = currentTick + Math.ceil(Math.log(1.0 + rangePercent) / log1_0001).toInt()
    val tickLower = Math.floorDiv(rawLower, spacing) * spacing
    val tickUpper = (Math.floorDiv(rawUpper, spacing) + 1) * spacing
    return Pair(tickLower, tickUpper)
}

fun Application.configureRouting(
    chainClient: ChainClient,
    userService: UserService,
    walletService: WalletService,
    strategyService: StrategyService,
    scheduler: StrategyScheduler,
) {
    routing {
        get("/health") {
            call.respond(mapOf("status" to "ok"))
        }

        // Auth routes (public + protected /me routes)
        authRoutes(userService, walletService, chainClient)

        authenticate("jwt") {
            route("/api/v1") {

                // --- Position / Pool (for active strategy of current user) ---

                get("/position") {
                    val userId = call.getUserId()
                    val strategy = strategyService.listForUser(userId)
                        .firstOrNull { it.status == "active" }
                        ?: return@get call.respond(HttpStatusCode.NotFound, mapOf("error" to "No active strategy"))
                    try {
                        val position = chainClient.getPosition(strategy.currentTokenId)
                        call.respond(position)
                    } catch (e: Exception) {
                        call.respond(HttpStatusCode.ServiceUnavailable, mapOf("error" to (e.message ?: "chain service unavailable")))
                    }
                }

                get("/pool-state") {
                    val userId = call.getUserId()
                    val strategy = strategyService.listForUser(userId)
                        .firstOrNull { it.status == "active" }
                        ?: return@get call.respond(HttpStatusCode.NotFound, mapOf("error" to "No active strategy"))
                    try {
                        val poolState = chainClient.getPoolState(strategy.currentTokenId)
                        call.respond(poolState)
                    } catch (e: Exception) {
                        call.respond(HttpStatusCode.ServiceUnavailable, mapOf("error" to (e.message ?: "chain service unavailable")))
                    }
                }

                // --- Strategies ---

                get("/strategies") {
                    val userId = call.getUserId()
                    call.respond(strategyService.listForUser(userId))
                }

                // Mint a new position from scratch, then register it as a strategy
                post("/strategies/start") {
                    val userId = call.getUserId()
                    val phrase = walletService.getDecryptedPhrase(userId)
                        ?: return@post call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Configure a wallet before creating a strategy"))
                    val req = call.receive<StartStrategyRequestDto>()

                    // Get current pool price to calculate tick range
                    val poolState = try {
                        chainClient.getPoolByPair(WETH, USDC, req.feeTier)
                    } catch (e: Exception) {
                        return@post call.respond(HttpStatusCode.ServiceUnavailable, mapOf("error" to "Could not fetch pool state: ${e.message}"))
                    }

                    val (tickLower, tickUpper) = calcTicks(poolState.tick, req.rangePercent, req.feeTier)

                    val mintResult = try {
                        chainClient.mint(fi.lagrange.services.MintRequest(
                            ethAmount = req.ethAmount,
                            usdcAmount = req.usdcAmount,
                            feeTier = req.feeTier,
                            tickLower = tickLower,
                            tickUpper = tickUpper,
                            slippageTolerance = req.slippageTolerance,
                            walletPrivateKey = phrase,
                        ))
                    } catch (e: Exception) {
                        return@post call.respond(HttpStatusCode.ServiceUnavailable, mapOf("error" to "Mint failed: ${e.message}"))
                    }

                    if (!mintResult.success || mintResult.tokenId == null) {
                        return@post call.respond(HttpStatusCode.InternalServerError, mapOf("error" to (mintResult.error ?: "Mint failed")))
                    }

                    // Resolve token0/token1/fee from the minted position
                    val position = try {
                        chainClient.getPosition(mintResult.tokenId)
                    } catch (e: Exception) {
                        return@post call.respond(HttpStatusCode.ServiceUnavailable, mapOf("error" to "Position minted but could not fetch details: ${e.message}"))
                    }

                    try {
                        val strategy = strategyService.create(
                            userId = userId,
                            name = req.name,
                            tokenId = mintResult.tokenId,
                            token0 = position.token0,
                            token1 = position.token1,
                            fee = position.fee,
                            rangePercent = req.rangePercent,
                            slippageTolerance = req.slippageTolerance,
                            pollIntervalSeconds = req.pollIntervalSeconds,
                        )
                        scheduler.start(strategy)
                        call.respond(HttpStatusCode.Created, StartStrategyResponseDto(
                            tokenId = mintResult.tokenId,
                            txHashes = mintResult.txHashes,
                        ))
                    } catch (e: IllegalArgumentException) {
                        call.respond(HttpStatusCode.Conflict, mapOf("error" to e.message))
                    }
                }

                post("/strategies") {
                    val userId = call.getUserId()
                    if (!walletService.hasWallet(userId)) {
                        return@post call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Configure a wallet before creating a strategy"))
                    }
                    val req = call.receive<CreateStrategyRequestDto>()

                    // Resolve token0/token1/fee from the chain service
                    val position = try {
                        chainClient.getPosition(req.tokenId)
                    } catch (e: Exception) {
                        return@post call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Could not fetch position from chain: ${e.message}"))
                    }

                    try {
                        val strategy = strategyService.create(
                            userId = userId,
                            name = req.name,
                            tokenId = req.tokenId,
                            token0 = position.token0,
                            token1 = position.token1,
                            fee = position.fee,
                            rangePercent = req.rangePercent,
                            slippageTolerance = req.slippageTolerance,
                            pollIntervalSeconds = req.pollIntervalSeconds,
                        )
                        scheduler.start(strategy)
                        call.respond(HttpStatusCode.Created, strategy)
                    } catch (e: IllegalArgumentException) {
                        call.respond(HttpStatusCode.Conflict, mapOf("error" to e.message))
                    }
                }

                get("/strategies/{id}") {
                    val userId = call.getUserId()
                    val strategyId = call.parameters["id"]?.toIntOrNull()
                        ?: return@get call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Invalid strategy id"))
                    val strategy = strategyService.findById(strategyId, userId)
                        ?: return@get call.respond(HttpStatusCode.NotFound, mapOf("error" to "Strategy not found"))
                    call.respond(strategy)
                }

                patch("/strategies/{id}/pause") {
                    val userId = call.getUserId()
                    val strategyId = call.parameters["id"]?.toIntOrNull()
                        ?: return@patch call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Invalid strategy id"))
                    val ok = strategyService.pause(strategyId, userId)
                    if (!ok) return@patch call.respond(HttpStatusCode.NotFound, mapOf("error" to "Strategy not found or not active"))
                    scheduler.stop(strategyId)
                    call.respond(mapOf("status" to "paused"))
                }

                patch("/strategies/{id}/resume") {
                    val userId = call.getUserId()
                    val strategyId = call.parameters["id"]?.toIntOrNull()
                        ?: return@patch call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Invalid strategy id"))
                    try {
                        val ok = strategyService.resume(strategyId, userId)
                        if (!ok) return@patch call.respond(HttpStatusCode.NotFound, mapOf("error" to "Strategy not found or not paused"))
                        val strategy = strategyService.findById(strategyId, userId)!!
                        scheduler.start(strategy)
                        call.respond(mapOf("status" to "active"))
                    } catch (e: IllegalArgumentException) {
                        call.respond(HttpStatusCode.Conflict, mapOf("error" to e.message))
                    }
                }

                delete("/strategies/{id}") {
                    val userId = call.getUserId()
                    val strategyId = call.parameters["id"]?.toIntOrNull()
                        ?: return@delete call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Invalid strategy id"))
                    val ok = strategyService.stop(strategyId, userId)
                    if (!ok) return@delete call.respond(HttpStatusCode.NotFound, mapOf("error" to "Strategy not found"))
                    scheduler.stop(strategyId)
                    call.respond(mapOf("status" to "stopped"))
                }

                // --- Strategy stats and history ---

                get("/strategies/{id}/stats") {
                    val userId = call.getUserId()
                    val strategyId = call.parameters["id"]?.toIntOrNull()
                        ?: return@get call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Invalid strategy id"))
                    val stats = strategyService.getStats(strategyId, userId)
                        ?: return@get call.respond(HttpStatusCode.NotFound, mapOf("error" to "Strategy not found"))
                    call.respond(stats)
                }

                get("/strategies/{id}/rebalances") {
                    val userId = call.getUserId()
                    val strategyId = call.parameters["id"]?.toIntOrNull()
                        ?: return@get call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Invalid strategy id"))
                    val events = strategyService.getRebalanceHistory(strategyId, userId)
                        ?: return@get call.respond(HttpStatusCode.NotFound, mapOf("error" to "Strategy not found"))
                    call.respond(events)
                }

                // Legacy: rebalances for the user's active strategy
                get("/rebalances") {
                    val userId = call.getUserId()
                    val strategy = strategyService.listForUser(userId).firstOrNull()
                        ?: return@get call.respond(emptyList<Unit>())
                    val events = strategyService.getRebalanceHistory(strategy.id, userId) ?: emptyList()
                    call.respond(events)
                }
            }
        }
    }
}
