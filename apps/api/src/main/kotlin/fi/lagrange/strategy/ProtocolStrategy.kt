package fi.lagrange.strategy

// Extension point for v2 (DeltaNeutralStrategy) and beyond.
// All strategies implement this interface — the scheduler calls execute() on a timer.
interface ProtocolStrategy {
    suspend fun execute()
    fun startScheduler()
    fun stopScheduler()
}
