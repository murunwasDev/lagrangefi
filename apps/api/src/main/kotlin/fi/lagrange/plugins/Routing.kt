package fi.lagrange.plugins

import fi.lagrange.auth.authRoutes
import fi.lagrange.auth.getUserId
import fi.lagrange.model.StrategyStatus
import fi.lagrange.services.ChainClient
import fi.lagrange.services.StrategyService
import fi.lagrange.services.TelegramNotifier
import fi.lagrange.services.UserService
import fi.lagrange.services.WalletService
import fi.lagrange.strategy.StrategyScheduler
import fi.lagrange.strategy.calcTickRange
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

@Serializable
data class StopStrategyRequestDto(
    val reason: String? = null,
)

private const val WETH = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"
private const val USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831"

fun Application.configureRouting(
    chainClient: ChainClient,
    userService: UserService,
    walletService: WalletService,
    strategyService: StrategyService,
    scheduler: StrategyScheduler,
    telegram: TelegramNotifier,
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
                        .firstOrNull { it.status == StrategyStatus.ACTIVE.value }
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
                        .firstOrNull { it.status == StrategyStatus.ACTIVE.value }
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

                    val (tickLower, tickUpper) = calcTickRange(poolState.tick, req.feeTier, req.rangePercent)

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

                    // Use actual deposited amounts from IncreaseLiquidity event if available,
                    // falling back to the user's intent. This prevents day-0 IL from appearing
                    // due to Uniswap returning dust that didn't fit the tick ratio.
                    val HALF_UP = java.math.RoundingMode.HALF_UP
                    val ethPriceBD = poolState.price.toBigDecimalOrNull() ?: java.math.BigDecimal.ZERO
                    val initialToken0 = mintResult.amount0 ?: runCatching {
                        java.math.BigDecimal(req.ethAmount)
                            .multiply(java.math.BigDecimal.TEN.pow(poolState.decimals0))
                            .toBigInteger().toString()
                    }.getOrNull()
                    val initialToken1 = mintResult.amount1 ?: runCatching {
                        java.math.BigDecimal(req.usdcAmount)
                            .multiply(java.math.BigDecimal.TEN.pow(poolState.decimals1))
                            .toBigInteger().toString()
                    }.getOrNull()
                    val initialValueUsd: java.math.BigDecimal? = if (mintResult.amount0 != null && mintResult.amount1 != null) {
                        val t0 = (mintResult.amount0.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO).toBigDecimal()
                            .divide(java.math.BigDecimal.TEN.pow(poolState.decimals0), poolState.decimals0, HALF_UP)
                        val t1 = (mintResult.amount1.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO).toBigDecimal()
                            .divide(java.math.BigDecimal.TEN.pow(poolState.decimals1), poolState.decimals1, HALF_UP)
                        // Include leftover tokens that didn't fit into the LP — they are part of
                        // the user's true initial contribution and must be in the baseline.
                        val pending0 = ((mintResult.leftoverToken0 ?: "0").toBigIntegerOrNull() ?: java.math.BigInteger.ZERO).toBigDecimal()
                            .divide(java.math.BigDecimal.TEN.pow(poolState.decimals0), poolState.decimals0, HALF_UP)
                        val pending1 = ((mintResult.leftoverToken1 ?: "0").toBigIntegerOrNull() ?: java.math.BigInteger.ZERO).toBigDecimal()
                            .divide(java.math.BigDecimal.TEN.pow(poolState.decimals1), poolState.decimals1, HALF_UP)
                        t0.add(pending0).multiply(ethPriceBD).add(t1.add(pending1)).setScale(2, HALF_UP)
                    } else {
                        java.math.BigDecimal(req.ethAmount).multiply(ethPriceBD)
                            .add(java.math.BigDecimal(req.usdcAmount)).setScale(2, HALF_UP)
                    }

                    try {
                        val strategy = strategyService.create(
                            userId = userId,
                            name = req.name,
                            tokenId = mintResult.tokenId,
                            token0 = position.token0,
                            token1 = position.token1,
                            fee = position.fee,
                            token0Decimals = poolState.decimals0,
                            token1Decimals = poolState.decimals1,
                            rangePercent = req.rangePercent,
                            slippageTolerance = req.slippageTolerance,
                            pollIntervalSeconds = req.pollIntervalSeconds,
                            initialToken0Amount = initialToken0,
                            initialToken1Amount = initialToken1,
                            initialValueUsd = initialValueUsd,
                            openEthPriceUsd = ethPriceBD,
                            pendingToken0 = mintResult.leftoverToken0 ?: "0",
                            pendingToken1 = mintResult.leftoverToken1 ?: "0",
                        )

                        strategyService.recordStartStrategy(strategy.id, mintResult, ethPriceBD.setScale(8, HALF_UP))

                        scheduler.start(strategy)
                        telegram.sendAlert("Strategy <b>${strategy.name}</b> started! Position #${mintResult.tokenId} minted.")
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

                    // Resolve token0/token1/fee and decimals from the chain service
                    val position = try {
                        chainClient.getPosition(req.tokenId)
                    } catch (e: Exception) {
                        return@post call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Could not fetch position from chain: ${e.message}"))
                    }
                    val poolState = try {
                        chainClient.getPoolState(req.tokenId)
                    } catch (e: Exception) {
                        null // non-fatal: decimals fall back to defaults
                    }

                    try {
                        val strategy = strategyService.create(
                            userId = userId,
                            name = req.name,
                            tokenId = req.tokenId,
                            token0 = position.token0,
                            token1 = position.token1,
                            fee = position.fee,
                            token0Decimals = poolState?.decimals0 ?: 18,
                            token1Decimals = poolState?.decimals1 ?: 6,
                            rangePercent = req.rangePercent,
                            slippageTolerance = req.slippageTolerance,
                            pollIntervalSeconds = req.pollIntervalSeconds,
                        )
                        scheduler.start(strategy)
                        telegram.sendAlert("Strategy <b>${strategy.name}</b> started! Managing position #${req.tokenId}.")
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

                delete("/strategies/{id}") {
                    val userId = call.getUserId()
                    val strategyId = call.parameters["id"]?.toIntOrNull()
                        ?: return@delete call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Invalid strategy id"))
                    val strategy = strategyService.findById(strategyId, userId)
                        ?: return@delete call.respond(HttpStatusCode.NotFound, mapOf("error" to "Strategy not found"))
                    val body = runCatching { call.receive<StopStrategyRequestDto>() }.getOrNull()
                    val ok = strategyService.stop(strategyId, userId, stopReason = body?.reason, isError = false)
                    if (!ok) return@delete call.respond(HttpStatusCode.NotFound, mapOf("error" to "Strategy not found"))
                    scheduler.stop(strategyId)

                    // Generate idempotency key and insert pending close event before chain call
                    var closeResult: fi.lagrange.services.CloseResponse? = null
                    val closeIdempotencyKey = java.util.UUID.randomUUID().toString()
                    val closeEventId = strategyService.insertPendingCloseEvent(strategyId, closeIdempotencyKey)
                    try {
                        val walletPhrase = walletService.getDecryptedPhrase(userId)
                        if (walletPhrase != null) {
                            closeResult = chainClient.close(
                                idempotencyKey = closeIdempotencyKey,
                                tokenId = strategy.currentTokenId,
                                walletPrivateKey = walletPhrase,
                                pendingToken0 = strategy.pendingToken0,
                                pendingToken1 = strategy.pendingToken1,
                            )
                        }
                    } catch (e: Exception) {
                        strategyService.markCloseEventFailed(closeEventId, e.message)
                        telegram.sendAlert("Strategy <b>${strategy.name}</b> close FAILED: ${e.message}. Position may still be open on-chain.")
                    }
                    // Snapshot ETH price, finalize close event and accumulate stats (non-fatal)
                    try {
                        val poolState = chainClient.getPoolByPair(WETH, USDC, strategy.fee)
                        val closeEthPriceBD = java.math.BigDecimal(poolState.price).setScale(8, java.math.RoundingMode.HALF_UP)
                        strategyService.finalizeCloseEvent(
                            strategyId = strategyId,
                            eventId = closeEventId,
                            strategy = strategy,
                            closeResult = closeResult,
                            closeEthPriceBD = closeEthPriceBD,
                        )
                    } catch (e: Exception) {
                        application.log.error("finalizeCloseEvent failed for strategy $strategyId (non-fatal): ${e.message}", e)
                    }
                    telegram.sendAlert("Strategy <b>${strategy.name}</b> stopped.")
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
                    val events = strategyService.getEventHistory(strategyId, userId)
                        ?: return@get call.respond(HttpStatusCode.NotFound, mapOf("error" to "Strategy not found"))
                    call.respond(events)
                }

                // Legacy: events for the user's latest strategy
                get("/rebalances") {
                    val userId = call.getUserId()
                    val strategy = strategyService.listForUser(userId).firstOrNull()
                        ?: return@get call.respond(emptyList<Unit>())
                    val events = strategyService.getEventHistory(strategy.id, userId) ?: emptyList()
                    call.respond(events)
                }
            }
        }
    }
}
