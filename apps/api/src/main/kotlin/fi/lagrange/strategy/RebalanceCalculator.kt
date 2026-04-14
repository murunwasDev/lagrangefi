package fi.lagrange.strategy

import fi.lagrange.services.SwapCostResponse
import java.math.BigDecimal
import java.math.BigInteger
import java.math.RoundingMode

data class RebalanceMetrics(
    val gasEth: BigDecimal,
    val feesUsd: BigDecimal,
    val swapCostTokenOutRaw: BigInteger,
    val swapCostUsd: BigDecimal,
    val driftPct: BigDecimal,
    val driftUsd: BigDecimal,
    val dragUsd: BigDecimal?,
    val hodlValueUsd: BigDecimal?,
)

fun weiToEth(wei: Long): BigDecimal =
    BigDecimal(wei).divide(BigDecimal("1000000000000000000"), 18, RoundingMode.HALF_UP)

fun toUsd(rawAmount: String, decimals: Int, ethPrice: BigDecimal, isEthSide: Boolean): BigDecimal {
    val human = (rawAmount.toBigIntegerOrNull() ?: BigInteger.ZERO)
        .toBigDecimal()
        .divide(BigDecimal.TEN.pow(decimals), decimals, RoundingMode.HALF_UP)
    return if (isEthSide) human.multiply(ethPrice) else human
}

fun computeRebalanceMetrics(
    fees0: String,
    fees1: String,
    totalGasWei: Long,
    ethPriceUsd: BigDecimal,
    dec0: Int,
    dec1: Int,
    ethSideIsToken0: Boolean,
    swapCost: SwapCostResponse?,
    positionToken0Start: String,
    positionToken1Start: String,
    priceAtDecision: BigDecimal,
    priceAtEnd: BigDecimal?,
    initialToken0Amount: String?,
    initialToken1Amount: String?,
): RebalanceMetrics {
    val HALF_UP = RoundingMode.HALF_UP

    val gasEth = weiToEth(totalGasWei)

    val feesUsd = (toUsd(fees0, dec0, ethPriceUsd, ethSideIsToken0) +
                   toUsd(fees1, dec1, ethPriceUsd, !ethSideIsToken0)).setScale(2, HALF_UP)

    val swapCostTokenOutRaw: BigInteger = swapCost?.let {
        ((it.fairAmountOut.toBigIntegerOrNull() ?: BigInteger.ZERO) -
         (it.amountOut.toBigIntegerOrNull() ?: BigInteger.ZERO))
            .coerceAtLeast(BigInteger.ZERO)
    } ?: BigInteger.ZERO

    val swapCostUsd: BigDecimal = swapCost?.let {
        val outIsToken0 = it.direction == "oneForZero"
        val (costDec, costIsEth) = if (outIsToken0) dec0 to ethSideIsToken0 else dec1 to !ethSideIsToken0
        toUsd(swapCostTokenOutRaw.toString(), costDec, ethPriceUsd, costIsEth).setScale(2, HALF_UP)
    } ?: BigDecimal.ZERO

    // Price drift on ETH-side principal only
    val principalStart = if (ethSideIsToken0) positionToken0Start else positionToken1Start
    val feesSide = if (ethSideIsToken0) fees0 else fees1
    val principalRaw = ((principalStart.toBigIntegerOrNull() ?: BigInteger.ZERO) -
                        (feesSide.toBigIntegerOrNull() ?: BigInteger.ZERO))
        .coerceAtLeast(BigInteger.ZERO)
    val principalEthHuman = principalRaw.toBigDecimal().divide(BigDecimal.TEN.pow(18), 18, HALF_UP)

    val (driftPct, driftUsd) = if (priceAtEnd != null && priceAtDecision > BigDecimal.ZERO) {
        val pct = (priceAtEnd - priceAtDecision)
            .divide(priceAtDecision, 6, HALF_UP)
            .multiply(BigDecimal("100"))
            .setScale(4, HALF_UP)
        val usd = principalEthHuman.multiply(priceAtEnd - priceAtDecision).setScale(2, HALF_UP)
        pct to usd
    } else {
        BigDecimal.ZERO to BigDecimal.ZERO
    }

    val (dragUsd, hodlValueUsd) = if (
        initialToken0Amount != null && initialToken1Amount != null && priceAtDecision > BigDecimal.ZERO
    ) {
        val hodl = toUsd(initialToken0Amount, dec0, priceAtDecision, ethSideIsToken0) +
                   toUsd(initialToken1Amount, dec1, priceAtDecision, !ethSideIsToken0)
        val lp   = toUsd(positionToken0Start, dec0, priceAtDecision, ethSideIsToken0) +
                   toUsd(positionToken1Start, dec1, priceAtDecision, !ethSideIsToken0)
        (hodl - lp).setScale(2, HALF_UP) to hodl.setScale(2, HALF_UP)
    } else {
        null to null
    }

    return RebalanceMetrics(
        gasEth = gasEth,
        feesUsd = feesUsd,
        swapCostTokenOutRaw = swapCostTokenOutRaw,
        swapCostUsd = swapCostUsd,
        driftPct = driftPct,
        driftUsd = driftUsd,
        dragUsd = dragUsd,
        hodlValueUsd = hodlValueUsd,
    )
}
