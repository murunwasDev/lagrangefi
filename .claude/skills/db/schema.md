# lagrangefi Database Schema

## users
| Column | Type |
|--------|------|
| id | int |
| username | varchar |
| password_hash | varchar |
| created_at | timestamp |

## wallets
| Column | Type |
|--------|------|
| id | int |
| user_id | int (FK → users) |
| encrypted_phrase | varchar |
| created_at | timestamp |
| updated_at | timestamp |

## strategies
| Column | Type |
|--------|------|
| id | int |
| user_id | int (FK → users) |
| name | varchar |
| current_token_id | varchar |
| token0 | varchar |
| token1 | varchar |
| token0_decimals | int |
| token1_decimals | int |
| fee | int |
| range_percent | decimal |
| slippage_tolerance | decimal |
| poll_interval_seconds | int |
| status | varchar (active\|paused\|stopped) |
| initial_value_usd | decimal |
| open_eth_price_usd | decimal |
| initial_token0_amount | varchar |
| initial_token1_amount | varchar |
| pending_token0 | varchar |
| pending_token1 | varchar |
| end_value_usd | decimal |
| end_eth_price_usd | decimal |
| end_token0_amount | varchar |
| end_token1_amount | varchar |
| created_at | timestamp |
| stopped_at | timestamp |

## strategy_stats
| Column | Type |
|--------|------|
| strategy_id | int (PK/FK → strategies) |
| total_rebalances | int |
| fees_collected_token0 | varchar |
| fees_collected_token1 | varchar |
| fees_collected_usd | decimal(18,2) |
| gas_cost_wei | bigint |
| gas_cost_usd | decimal(18,2) |
| swap_cost_token0 | varchar |
| swap_cost_token1 | varchar |
| swap_cost_usd | decimal(18,2) |
| avg_price_drift_pct | decimal(8,4) |
| current_rebalancing_drag_usd | decimal(18,2) nullable |
| total_poll_ticks | int |
| in_range_ticks | int |
| time_in_range_pct | double |
| updated_at | timestamp |

## rebalance_events
| Column | Type |
|--------|------|
| id | int |
| strategy_id | int (FK → strategies) |
| status | varchar |
| idempotency_key | varchar |
| new_tick_lower | int |
| new_tick_upper | int |
| new_token_id | varchar |
| tx_hashes | json |
| error_message | varchar |
| triggered_at | timestamp |
| completed_at | timestamp |

## rebalance_details
| Column | Type |
|--------|------|
| strategy_event_id | int (PK/FK → rebalance_events) |
| fees_collected_token0 | varchar |
| fees_collected_token1 | varchar |
| position_token0_start | varchar |
| position_token1_start | varchar |
| position_token0_end | varchar |
| position_token1_end | varchar |
| gas_used_wei | bigint |
| eth_price_usd | decimal(18,8) |
| swap_cost_amount_in | varchar |
| swap_cost_amount_out | varchar |
| swap_cost_fair_amount_out | varchar |
| swap_cost_direction | varchar |
| swap_cost_usd | decimal(18,2) |
| price_at_decision | decimal(18,8) |
| price_at_end | decimal(18,8) |
| price_drift_pct | decimal(8,4) |
| price_drift_usd | decimal(18,2) |
| rebalancing_drag_usd | decimal(18,2) nullable |
| hodl_value_usd | decimal(18,2) nullable |
