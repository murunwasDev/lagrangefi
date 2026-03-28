package fi.lagrange.plugins

import fi.lagrange.auth.authRoutes
import fi.lagrange.auth.getUserId
import fi.lagrange.services.ChainClient
import fi.lagrange.services.StrategyService
import fi.lagrange.services.TelegramNotifier
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
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

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

                    // Convert human-readable amounts to raw units and compute initial USD value
                    val ethPrice = poolState.price.toDoubleOrNull() ?: 0.0
                    val initialToken0 = runCatching {
                        java.math.BigDecimal(req.ethAmount)
                            .multiply(java.math.BigDecimal.TEN.pow(poolState.decimals0))
                            .toBigInteger().toString()
                    }.getOrNull()
                    val initialToken1 = runCatching {
                        java.math.BigDecimal(req.usdcAmount)
                            .multiply(java.math.BigDecimal.TEN.pow(poolState.decimals1))
                            .toBigInteger().toString()
                    }.getOrNull()
                    val initialValueUsd = (req.ethAmount.toDoubleOrNull() ?: 0.0) * ethPrice +
                            (req.usdcAmount.toDoubleOrNull() ?: 0.0)

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
                            initialGasWei = mintResult.gasUsedWei,
                            openEthPriceUsd = ethPrice,
                            openTxHashes = Json.encodeToString(mintResult.txHashes),
                        )
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
                    val ok = strategyService.stop(strategyId, userId)
                    if (!ok) return@delete call.respond(HttpStatusCode.NotFound, mapOf("error" to "Strategy not found"))
                    scheduler.stop(strategyId)
                    // Close LP position on-chain and unwrap WETH → ETH
                    var closeResult: fi.lagrange.services.CloseResponse? = null
                    try {
                        val walletPhrase = walletService.getDecryptedPhrase(userId)
                        if (walletPhrase != null) {
                            val idempotencyKey = "stop-$strategyId-${System.currentTimeMillis()}"
                            closeResult = chainClient.close(idempotencyKey, strategy.currentTokenId, walletPhrase)
                        }
                    } catch (_: Exception) { /* non-fatal: DB is already updated */ }
                    // Snapshot fees/gas, ETH price, and withdrawn amounts when strategy is stopped
                    try {
                        val poolState = chainClient.getPoolByPair(WETH, USDC, strategy.fee)
                        val closeEthPrice = poolState.price.toDoubleOrNull() ?: 0.0
                        val token0Amt = closeResult?.token0Amount
                        val token1Amt = closeResult?.token1Amount
                        val closeValueUsd = if (token0Amt != null && token1Amt != null) {
                            val t0 = token0Amt.toBigIntegerOrNull()?.toBigDecimal()
                                ?.divide(java.math.BigDecimal.TEN.pow(strategy.token0Decimals))?.toDouble() ?: 0.0
                            val t1 = token1Amt.toBigIntegerOrNull()?.toBigDecimal()
                                ?.divide(java.math.BigDecimal.TEN.pow(strategy.token1Decimals))?.toDouble() ?: 0.0
                            if (strategy.token0Decimals == 18) t0 * closeEthPrice + t1
                            else t1 * closeEthPrice + t0
                        } else null
                        val closeTxHashes = closeResult?.txHashes?.let { Json.encodeToString(it) }
                        strategyService.recordClose(
                            strategyId = strategyId,
                            closeEthPriceUsd = closeEthPrice,
                            closeToken0Amount = token0Amt,
                            closeToken1Amount = token1Amt,
                            closeValueUsd = closeValueUsd,
                            closeTxHashes = closeTxHashes,
                        )
                    } catch (_: Exception) { /* non-fatal */ }
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
