package fi.lagrange.strategy

import fi.lagrange.services.TxRecord

/**
 * Canonical tick range calculation. Uses floorDiv+1 for tickUpper so the range is
 * correctly wider than the raw log result (prevents a freshly-minted position from
 * appearing out-of-range on the very first scheduler tick).
 */
fun calcTickRange(currentTick: Int, fee: Int, rangePercent: Double): Pair<Int, Int> {
    val spacing = feeToTickSpacing(fee)
    val log1_0001 = Math.log(1.0001)
    val rawLower = currentTick + (Math.log(1.0 - rangePercent) / log1_0001).toInt()
    val rawUpper = currentTick + Math.ceil(Math.log(1.0 + rangePercent) / log1_0001).toInt()
    val tickLower = Math.floorDiv(rawLower, spacing) * spacing
    val tickUpper = (Math.floorDiv(rawUpper, spacing) + 1) * spacing
    return Pair(tickLower, tickUpper)
}

fun feeToTickSpacing(fee: Int): Int = when (fee) {
    100 -> 1; 500 -> 10; 3000 -> 60; 10000 -> 200; else -> 60
}

/**
 * Build TxRecord list from chain response.
 * Prefers txDetails if chain service provides them; falls back to parallel txHashes + txSteps arrays.
 * When falling back, total gas is attributed to the last tx; all others get 0.
 */
fun buildTxRecords(
    txDetails: List<TxRecord>?,
    txHashes: List<String>,
    txSteps: List<String>?,
    totalGasWei: Long,
): List<TxRecord> {
    if (txDetails != null) return txDetails
    val steps = txSteps ?: txHashes.map { "UNKNOWN" }
    return txHashes.zip(steps).mapIndexed { idx, (hash, step) ->
        TxRecord(
            txHash = hash,
            action = stepToAction(step),
            gasUsedWei = if (idx == txHashes.lastIndex) totalGasWei else 0L,
        )
    }
}

fun stepToAction(step: String): String = when (step.lowercase()) {
    "collect_fees", "collectfees" -> "COLLECT_FEES"
    "burn" -> "BURN"
    "approve" -> "APPROVE"
    "swap" -> "SWAP"
    "mint" -> "MINT"
    "wrap" -> "WRAP"
    "withdraw", "withdraw_to_wallet" -> "WITHDRAW_TO_WALLET"
    else -> "UNKNOWN"
}
