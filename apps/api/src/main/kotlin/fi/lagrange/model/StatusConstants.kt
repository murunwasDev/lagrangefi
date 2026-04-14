package fi.lagrange.model

enum class StrategyStatus(val value: String) {
    ACTIVE("ACTIVE"),
    INITIATING("INITIATING"),
    STOPPED_MANUALLY("STOPPED_MANUALLY"),
    STOPPED_ON_ERROR("STOPPED_ON_ERROR");
    companion object {
        fun fromValue(s: String): StrategyStatus = entries.first { it.value == s }
    }
}

enum class EventStatus(val value: String) {
    PENDING("pending"),
    IN_PROGRESS("in_progress"),
    SUCCESS("success"),
    FAILED("failed");
    companion object {
        fun fromValue(s: String): EventStatus = entries.first { it.value == s }
    }
}
