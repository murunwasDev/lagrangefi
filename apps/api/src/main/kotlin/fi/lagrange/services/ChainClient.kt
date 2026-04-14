package fi.lagrange.services

import io.ktor.client.*
import io.ktor.client.call.*
import io.ktor.client.engine.cio.*
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Thrown when the chain service reports that a Uniswap NFT position no longer exists on-chain. */
class PositionNotFoundException(message: String) : Exception(message)

@Serializable
data class PositionResponse(
    val tokenId: String,
    val owner: String,
    val token0: String,
    val token1: String,
    val fee: Int,
    val tickLower: Int,
    val tickUpper: Int,
    val liquidity: String,
    val tokensOwed0: String? = null,
    val tokensOwed1: String? = null,
    val amount0: String? = null,
    val amount1: String? = null,
)

@Serializable
data class PoolStateResponse(
    val sqrtPriceX96: String,
    val tick: Int,
    val price: String,
    val decimals0: Int,
    val decimals1: Int,
)

@Serializable
data class FeesCollectedResponse(
    val amount0: String,
    val amount1: String,
)

@Serializable
data class SwapCostResponse(
    val amountIn:      String,
    val amountOut:     String,
    val fairAmountOut: String,
    val direction:     String,  // "zeroForOne" | "oneForZero"
)

@Serializable
data class TxRecord(
    val txHash: String,
    val action: String,
    val gasUsedWei: Long = 0L,
)

@Serializable
data class RebalanceResponse(
    val success: Boolean,
    val txHashes: List<String>,
    val txSteps: List<String>? = null,
    val txDetails: List<TxRecord>? = null,
    val newTokenId: String? = null,
    val error: String? = null,
    val feesCollected: FeesCollectedResponse? = null,
    val gasUsedWei: String? = null,
    val positionToken0Start: String? = null,
    val positionToken1Start: String? = null,
    val positionToken0End: String? = null,
    val positionToken1End: String? = null,
    val isRecovery: Boolean? = null,
    val leftoverToken0: String? = null,
    val leftoverToken1: String? = null,
    val swapCost:    SwapCostResponse? = null,
    val priceAtSwap: String? = null,
    val priceAtEnd:  String? = null,
    /** Present on failure when collect ran before the error — total principal+fees sent to wallet */
    val recoveredToken0: String? = null,
    val recoveredToken1: String? = null,
)

@Serializable
data class CloseResponse(
    val success: Boolean,
    val txHashes: List<String>,
    val txSteps: List<String>? = null,
    val txDetails: List<TxRecord>? = null,
    val token0Amount: String? = null,
    val token1Amount: String? = null,
    val feesCollected: FeesCollectedResponse? = null,
    val gasUsedWei: String? = null,
    val error: String? = null,
)

@Serializable
data class WalletBalancesResponse(
    val address: String,
    val eth: String,
    val usdc: String,
)

@Serializable
data class RebalanceRequest(
    val idempotencyKey: String,
    val tokenId: String,
    val newTickLower: Int,
    val newTickUpper: Int,
    val slippageTolerance: Double,
    val walletPrivateKey: String,
    val pendingToken0: String = "0",
    val pendingToken1: String = "0",
    /** Required when the position NFT may no longer exist (recovery mode). */
    val token0: String? = null,
    val token1: String? = null,
    val fee: Int? = null,
)

@Serializable
data class CloseRequest(
    val idempotencyKey: String,
    val tokenId: String,
    val walletPrivateKey: String,
    val pendingToken0: String = "0",
    val pendingToken1: String = "0",
)

@Serializable
data class MintRequest(
    val ethAmount: String,
    val usdcAmount: String,
    val feeTier: Int,
    val tickLower: Int,
    val tickUpper: Int,
    val slippageTolerance: Double,
    val walletPrivateKey: String? = null,
)

@Serializable
data class MintResponse(
    val success: Boolean,
    val tokenId: String? = null,
    val txHashes: List<String>,
    val txDetails: List<TxRecord>? = null,
    val error: String? = null,
    val gasUsedWei: String? = null,
    val amount0: String? = null,
    val amount1: String? = null,
    val leftoverToken0: String? = null,
    val leftoverToken1: String? = null,
)

class ChainClient(private val baseUrl: String) {
    private val http = HttpClient(CIO) {
        install(ContentNegotiation) {
            json(Json { ignoreUnknownKeys = true })
        }
    }

    // Rebalance and close involve multiple sequential on-chain transactions — use a long timeout.
    private val longHttp = HttpClient(CIO) {
        install(ContentNegotiation) {
            json(Json { ignoreUnknownKeys = true })
        }
        install(HttpTimeout) {
            requestTimeoutMillis = 5 * 60 * 1_000L  // 5 minutes
            socketTimeoutMillis  = 5 * 60 * 1_000L
        }
    }

    suspend fun getWalletBalances(walletPhrase: String): WalletBalancesResponse =
        http.post("$baseUrl/wallet/balances") {
            contentType(ContentType.Application.Json)
            setBody(mapOf("walletPrivateKey" to walletPhrase))
        }.body()

    suspend fun getPosition(tokenId: String): PositionResponse {
        val response = http.get("$baseUrl/positions/$tokenId")
        if (!response.status.isSuccess()) {
            val body = response.bodyAsText()
            if (body.contains("nonexistent token", ignoreCase = true) ||
                body.contains("Invalid token ID", ignoreCase = true)) {
                throw PositionNotFoundException("Position $tokenId no longer exists on-chain")
            }
            error("Chain service error ${response.status} for position $tokenId: $body")
        }
        return response.body()
    }

    suspend fun getPoolState(tokenId: String): PoolStateResponse {
        val response = http.get("$baseUrl/positions/$tokenId/pool-state")
        if (!response.status.isSuccess()) {
            val body = response.bodyAsText()
            if (body.contains("nonexistent token", ignoreCase = true) ||
                body.contains("Invalid token ID", ignoreCase = true)) {
                throw PositionNotFoundException("Position $tokenId no longer exists on-chain")
            }
            error("Chain service error ${response.status} for pool-state $tokenId: $body")
        }
        return response.body()
    }

    suspend fun getPoolByPair(token0: String, token1: String, fee: Int): PoolStateResponse =
        http.get("$baseUrl/pool") {
            parameter("token0", token0)
            parameter("token1", token1)
            parameter("fee", fee)
        }.body()

    suspend fun mint(req: MintRequest): MintResponse =
        http.post("$baseUrl/mint") {
            contentType(ContentType.Application.Json)
            setBody(req)
        }.body()

    suspend fun close(
        idempotencyKey: String,
        tokenId: String,
        walletPrivateKey: String,
        pendingToken0: String = "0",
        pendingToken1: String = "0",
    ): CloseResponse =
        longHttp.post("$baseUrl/execute/close") {
            contentType(ContentType.Application.Json)
            setBody(CloseRequest(
                idempotencyKey = idempotencyKey,
                tokenId = tokenId,
                walletPrivateKey = walletPrivateKey,
                pendingToken0 = pendingToken0,
                pendingToken1 = pendingToken1,
            ))
        }.body()

    suspend fun rebalance(
        idempotencyKey: String,
        tokenId: String,
        newTickLower: Int,
        newTickUpper: Int,
        slippageTolerance: Double,
        /** Wallet private key (0x...) or BIP39 mnemonic phrase — forwarded to chain service */
        walletPrivateKey: String,
        pendingToken0: String = "0",
        pendingToken1: String = "0",
        /** Token pair for recovery mode — passed when the position NFT may no longer exist. */
        token0: String? = null,
        token1: String? = null,
        fee: Int? = null,
    ): RebalanceResponse =
        longHttp.post("$baseUrl/execute/rebalance") {
            contentType(ContentType.Application.Json)
            setBody(RebalanceRequest(
                idempotencyKey = idempotencyKey,
                tokenId = tokenId,
                newTickLower = newTickLower,
                newTickUpper = newTickUpper,
                slippageTolerance = slippageTolerance,
                walletPrivateKey = walletPrivateKey,
                pendingToken0 = pendingToken0,
                pendingToken1 = pendingToken1,
                token0 = token0,
                token1 = token1,
                fee = fee,
            ))
        }.body()
}
