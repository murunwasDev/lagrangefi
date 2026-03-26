package fi.lagrange.strategy

import fi.lagrange.services.StrategyRecord

/**
 * Extension point for v2 (DeltaNeutralStrategy) and beyond.
 * Each strategy type implements execute() with its own logic.
 * Scheduling is handled centrally by StrategyScheduler.
 */
interface ProtocolStrategy {
    suspend fun execute(strategy: StrategyRecord, walletPhrase: String)
}
