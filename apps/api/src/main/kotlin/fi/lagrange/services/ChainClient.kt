package fi.lagrange.services

import io.ktor.client.*
import io.ktor.client.call.*
import io.ktor.client.engine.cio.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

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
data class RebalanceResponse(
    val success: Boolean,
    val txHashes: List<String>,
    val newTokenId: String? = null,
    val error: String? = null,
    val feesCollected: FeesCollectedResponse? = null,
    val gasUsedWei: String? = null,
    val positionToken0Start: String? = null,
    val positionToken1Start: String? = null,
    val positionToken0End: String? = null,
    val positionToken1End: String? = null,
)

@Serializable
data class CloseResponse(
    val success: Boolean,
    val txHashes: List<String>,
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
    val error: String? = null,
    val gasUsedWei: String? = null,
)

class ChainClient(private val baseUrl: String) {
    private val http = HttpClient(CIO) {
        install(ContentNegotiation) {
            json(Json { ignoreUnknownKeys = true })
        }
    }

    suspend fun getWalletBalances(walletPhrase: String): WalletBalancesResponse =
        http.post("$baseUrl/wallet/balances") {
            contentType(ContentType.Application.Json)
            setBody(mapOf("walletPrivateKey" to walletPhrase))
        }.body()

    suspend fun getPosition(tokenId: String): PositionResponse =
        http.get("$baseUrl/positions/$tokenId").body()

    suspend fun getPoolState(tokenId: String): PoolStateResponse =
        http.get("$baseUrl/positions/$tokenId/pool-state").body()

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

    suspend fun close(idempotencyKey: String, tokenId: String, walletPrivateKey: String): CloseResponse =
        http.post("$baseUrl/execute/close") {
            contentType(ContentType.Application.Json)
            setBody(mapOf(
                "idempotencyKey" to idempotencyKey,
                "tokenId" to tokenId,
                "walletPrivateKey" to walletPrivateKey,
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
    ): RebalanceResponse =
        http.post("$baseUrl/execute/rebalance") {
            contentType(ContentType.Application.Json)
            setBody(RebalanceRequest(
                idempotencyKey = idempotencyKey,
                tokenId = tokenId,
                newTickLower = newTickLower,
                newTickUpper = newTickUpper,
                slippageTolerance = slippageTolerance,
                walletPrivateKey = walletPrivateKey,
            ))
        }.body()
}
