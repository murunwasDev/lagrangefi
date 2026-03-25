package fi.lagrange.services

import io.ktor.client.*
import io.ktor.client.call.*
import io.ktor.client.engine.cio.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import kotlinx.serialization.Serializable

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
)

@Serializable
data class RebalanceResponse(
    val success: Boolean,
    val txHashes: List<String>,
    val newTokenId: String? = null,
    val error: String? = null,
)

class ChainClient(private val baseUrl: String) {
    private val http = HttpClient(CIO) {
        install(ContentNegotiation) { json() }
    }

    suspend fun getPosition(tokenId: String): PositionResponse =
        http.get("$baseUrl/positions/$tokenId").body()

    suspend fun getPoolState(tokenId: String): PoolStateResponse =
        http.get("$baseUrl/positions/$tokenId/pool-state").body()

    suspend fun rebalance(
        idempotencyKey: String,
        tokenId: String,
        newTickLower: Int,
        newTickUpper: Int,
        slippageTolerance: Double,
    ): RebalanceResponse =
        http.post("$baseUrl/execute/rebalance") {
            contentType(ContentType.Application.Json)
            setBody(mapOf(
                "idempotencyKey" to idempotencyKey,
                "tokenId" to tokenId,
                "newTickLower" to newTickLower,
                "newTickUpper" to newTickUpper,
                "slippageTolerance" to slippageTolerance,
            ))
        }.body()
}
