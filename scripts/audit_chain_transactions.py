#!/usr/bin/env python3
"""
Audit chain_transactions against the Arbitrum blockchain.

Checks per transaction type:
  ALL      — gas_cost_wei  == gasUsed * effectiveGasPrice (on-chain receipt)
  ALL      — tx status     == 0x1 (not reverted), cross-checked with event status in DB
  SWAP     — swap_cost_amount_in / swap_cost_amount_out vs Uniswap Swap event log
  MINT     — new_tick_lower / new_tick_upper vs Uniswap Pool Mint event log topics

Usage:
    python3 scripts/audit_chain_transactions.py [--strategy-id <id>]

Requirements:
    - SSH access to root@187.124.224.48
    - kubectl access to the test k3s cluster on that host
    - curl available on the remote host

Environment variables:
    DB_USER       Postgres username      (default: lagrangefi)
    DB_PASSWORD   Postgres password
    DB_NAME       Postgres database name (default: lagrangefi)
"""

import subprocess
import json
import sys
import os
import argparse
import urllib.request

SSH_HOST    = "root@187.124.224.48"
K8S_NS      = "test"
POSTGRES_POD = "postgres-0"
ARBITRUM_RPC = "https://arb1.arbitrum.io/rpc"

DB_USER     = os.environ.get("DB_USER", "lagrangefi")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "")
DB_NAME     = os.environ.get("DB_NAME", "lagrangefi")

# Uniswap V3 event topic signatures
TOPIC_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
TOPIC_MINT = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde"


# ── Helpers ──────────────────────────────────────────────────────────────────

def rpc(method: str, params: list) -> dict:
    payload = json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": 1})
    # Route through SSH — the server has outbound access to the Arbitrum RPC
    result = subprocess.run(
        ["ssh", SSH_HOST,
         f"curl -s -X POST '{ARBITRUM_RPC}' -H 'Content-Type: application/json' -d '{payload}'"],
        capture_output=True, text=True
    )
    return json.loads(result.stdout)["result"]


def query_db(sql: str) -> list[list[str]]:
    # Collapse to single line, escape single quotes, wrap in bash -c on the pod
    sql_oneline = " ".join(sql.split()).replace("'", "'\\''")
    cmd = f"PGPASSWORD='{DB_PASSWORD}' psql -U {DB_USER} -d {DB_NAME} -t -A -F'|' -c '{sql_oneline}'"
    result = subprocess.run(
        ["ssh", SSH_HOST, f"kubectl -n {K8S_NS} exec {POSTGRES_POD} -- bash -c \"{cmd}\""],
        capture_output=True, text=True, shell=False
    )
    if result.returncode != 0:
        print("DB error:", result.stderr, file=sys.stderr)
        sys.exit(1)
    return [r.split("|") for r in result.stdout.strip().splitlines() if r]


def to_signed(hex_val: str, bits: int = 256) -> int:
    """Decode a hex string as a signed integer of `bits` width."""
    v = int(hex_val, 16)
    if v >= 2 ** (bits - 1):
        v -= 2 ** bits
    return v


def find_log(logs: list, topic0: str) -> dict | None:
    for log in logs:
        if log["topics"][0] == topic0:
            return log
    return None


def decode_swap_amounts(log: dict) -> tuple[int, int]:
    """
    Swap(address indexed sender, address indexed recipient,
         int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
    Non-indexed data layout (each field 32 bytes):
      [0:32]  amount0  int256
      [32:64] amount1  int256
    """
    data = log["data"][2:]  # strip 0x
    amount0 = to_signed(data[0:64])
    amount1 = to_signed(data[64:128])
    return amount0, amount1


def decode_mint_ticks(log: dict) -> tuple[int, int]:
    """
    Mint(address sender, address indexed owner,
         int24 indexed tickLower, int24 indexed tickUpper, ...)
    topics[2] = tickLower, topics[3] = tickUpper (sign-extended to 256 bits)
    """
    tick_lower = to_signed(log["topics"][2])
    tick_upper = to_signed(log["topics"][3])
    return tick_lower, tick_upper


# ── Checks ───────────────────────────────────────────────────────────────────

class Issue:
    def __init__(self, tx_hash, action, event_id, strategy_id, field, stored, onchain):
        self.tx_hash     = tx_hash
        self.action      = action
        self.event_id    = event_id
        self.strategy_id = strategy_id
        self.field       = field
        self.stored      = stored
        self.onchain     = onchain

    def __str__(self):
        return (f"  strategy={self.strategy_id} event={self.event_id} "
                f"{self.action} {self.tx_hash[:20]}...\n"
                f"    field={self.field} stored={self.stored} onchain={self.onchain} "
                f"diff={self.stored - self.onchain if isinstance(self.stored, int) and isinstance(self.onchain, int) else 'N/A'}")


def check_tx(tx_hash, action, event_id, strategy_id, stored_gas, swap_row, mint_row):
    """
    Fetch on-chain receipt and run all applicable checks.
    Returns (issues, status_str, onchain_gas).
    """
    receipt = rpc("eth_getTransactionReceipt", [tx_hash])
    issues = []

    # ── Gas check (all txs) ──────────────────────────────────────────────────
    gas_used    = int(receipt["gasUsed"], 16)
    eff_price   = int(receipt["effectiveGasPrice"], 16)
    onchain_gas = gas_used * eff_price

    # ── Status check (all txs) ───────────────────────────────────────────────
    onchain_ok = receipt["status"] == "0x1"

    logs = receipt["logs"]

    # ── Swap-specific checks ─────────────────────────────────────────────────
    if action == "SWAP" and swap_row:
        stored_amount_in, stored_amount_out, stored_direction = swap_row
        stored_amount_in  = int(stored_amount_in)  if stored_amount_in  else None
        stored_amount_out = int(stored_amount_out) if stored_amount_out else None

        swap_log = find_log(logs, TOPIC_SWAP)
        if swap_log:
            amount0, amount1 = decode_swap_amounts(swap_log)
            # zeroForOne: amount0 < 0 (wallet sends token0), amount1 > 0 (wallet receives token1)
            # oneForZero: amount1 < 0 (wallet sends token1), amount0 > 0 (wallet receives token0)
            if stored_direction == "zeroForOne":
                chain_amount_in  = abs(amount0)
                chain_amount_out = abs(amount1)
            else:
                chain_amount_in  = abs(amount1)
                chain_amount_out = abs(amount0)

            if stored_amount_in is not None and stored_amount_in != chain_amount_in:
                issues.append(Issue(tx_hash, action, event_id, strategy_id,
                                    "swap_amount_in", stored_amount_in, chain_amount_in))
            if stored_amount_out is not None and stored_amount_out != chain_amount_out:
                issues.append(Issue(tx_hash, action, event_id, strategy_id,
                                    "swap_amount_out", stored_amount_out, chain_amount_out))
        else:
            issues.append(Issue(tx_hash, action, event_id, strategy_id,
                                "swap_event", "present", "NOT FOUND in logs"))

    # ── Mint-specific checks ─────────────────────────────────────────────────
    if action == "MINT" and mint_row:
        stored_tick_lower, stored_tick_upper = int(mint_row[0]), int(mint_row[1])

        mint_log = find_log(logs, TOPIC_MINT)
        if mint_log:
            chain_tick_lower, chain_tick_upper = decode_mint_ticks(mint_log)

            if stored_tick_lower != chain_tick_lower:
                issues.append(Issue(tx_hash, action, event_id, strategy_id,
                                    "tick_lower", stored_tick_lower, chain_tick_lower))
            if stored_tick_upper != chain_tick_upper:
                issues.append(Issue(tx_hash, action, event_id, strategy_id,
                                    "tick_upper", stored_tick_upper, chain_tick_upper))
        else:
            issues.append(Issue(tx_hash, action, event_id, strategy_id,
                                "mint_event", "present", "NOT FOUND in logs"))

    return issues, "ok" if onchain_ok else "FAIL", onchain_gas


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Audit chain transactions against Arbitrum")
    parser.add_argument("--strategy-id", type=int, help="Audit only this strategy (default: all)")
    args = parser.parse_args()

    where = f"se.strategy_id = {args.strategy_id}" if args.strategy_id else "1=1"

    # Fetch all chain transactions with their rebalance context
    rows = query_db(f"""
        SELECT
            ct.tx_hash,
            ct.gas_cost_wei,
            ct.action,
            se.id            AS event_id,
            se.strategy_id,
            rd.swap_cost_amount_in,
            rd.swap_cost_amount_out,
            rd.swap_cost_direction,
            rd.new_tick_lower,
            rd.new_tick_upper
        FROM chain_transactions ct
        JOIN strategy_events se ON se.id = ct.strategy_event_id
        LEFT JOIN rebalance_details rd ON rd.strategy_event_id = se.id
        WHERE {where}
        ORDER BY ct.id;
    """)

    if not rows:
        print("No transactions found.")
        return

    all_issues  = []
    total_fail  = 0
    total_gas_mismatch = 0

    print("{:<20} {:>8} {:>4} {:>16} {:>16} {:>10} {}".format(
        "Action", "Strategy", "Evt", "Stored Gas", "Chain Gas", "Gas", "Status"
    ))
    print("-" * 90)

    for row in rows:
        (tx_hash, stored_gas, action, event_id, strategy_id,
         swap_in, swap_out, swap_dir, tick_lower, tick_upper) = row

        stored_gas = int(stored_gas)

        swap_row = (swap_in, swap_out, swap_dir) if action == "SWAP" else None
        mint_row = (tick_lower, tick_upper) if action == "MINT" and tick_lower and tick_upper else None

        issues, status, onchain_gas = check_tx(
            tx_hash, action, event_id, strategy_id, stored_gas, swap_row, mint_row
        )

        gas_diff    = stored_gas - onchain_gas
        gas_str     = "OK" if gas_diff == 0 else f"{gas_diff:+}"
        if gas_diff != 0:
            total_gas_mismatch += 1
            all_issues.append(Issue(tx_hash, action, event_id, strategy_id,
                                    "gas_cost_wei", stored_gas, onchain_gas))
        if status != "ok":
            total_fail += 1

        all_issues.extend(issues)

        print("{:<20} {:>8} {:>4} {:>16} {:>16} {:>10} {}{}".format(
            action, strategy_id, event_id,
            stored_gas, onchain_gas, gas_str, status,
            f"  [{len(issues)} issue(s)]" if issues else ""
        ))

    # ── Summary ──────────────────────────────────────────────────────────────
    print()
    print(f"Total txs : {len(rows)}")
    print(f"Gas mismatches  : {total_gas_mismatch}")
    print(f"Reverted on-chain : {total_fail}")
    print(f"Logic issues (swap/tick) : {len(all_issues) - total_gas_mismatch - total_fail}")

    if all_issues:
        print("\nAll issues:")
        for issue in all_issues:
            print(issue)
    else:
        print("\nAll checks passed. Data integrity OK.")


if __name__ == "__main__":
    main()
