package fi.lagrange.model

import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.kotlin.datetime.timestamp

object Positions : Table("positions") {
    val id = integer("id").autoIncrement()
    val tokenId = varchar("token_id", 78).uniqueIndex()
    val token0 = varchar("token0", 42)
    val token1 = varchar("token1", 42)
    val fee = integer("fee")
    val tickLower = integer("tick_lower")
    val tickUpper = integer("tick_upper")
    val rangePercent = double("range_percent")
    val active = bool("active").default(true)
    val createdAt = timestamp("created_at")
    val updatedAt = timestamp("updated_at")
    override val primaryKey = PrimaryKey(id)
}

object StrategyState : Table("strategy_state") {
    val key = varchar("key", 64)
    val value = varchar("value", 256)
    override val primaryKey = PrimaryKey(key)
}

object RebalanceEvents : Table("rebalance_events") {
    val id = integer("id").autoIncrement()
    val tokenId = varchar("token_id", 78)
    val idempotencyKey = varchar("idempotency_key", 64).uniqueIndex()
    val status = varchar("status", 20) // pending | success | failed
    val newTickLower = integer("new_tick_lower").nullable()
    val newTickUpper = integer("new_tick_upper").nullable()
    val newTokenId = varchar("new_token_id", 78).nullable()
    val txHashes = text("tx_hashes").nullable() // JSON array
    val errorMessage = text("error_message").nullable()
    val triggeredAt = timestamp("triggered_at")
    val completedAt = timestamp("completed_at").nullable()
    override val primaryKey = PrimaryKey(id)
}
