#!/usr/bin/env python3
"""Example script demonstrating capital rebalancing system usage.

This script shows how to:
1. Register vault strategies
2. Set initial allocations
3. Update APYs
4. Check drift and trigger rebalancing
5. Monitor rebalancing history

Usage:
    python scripts/example_rebalancing_usage.py
"""

import asyncio
import os
from decimal import Decimal
from datetime import datetime, timezone

import httpx


# Configuration
API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost:8000")
API_PREFIX = "/api/v1"


async def register_strategies(client: httpx.AsyncClient):
    """Register sample vault strategies."""
    print("\n=== Registering Vault Strategies ===")

    strategies = [
        {
            "id": "aave_usdc_lending",
            "vault_address": "GABC1234567890",
            "strategy_type": "LENDING",
            "asset": "USDC",
            "current_apy": 0.0523,
            "historical_apy_mean": 0.0500,
            "historical_apy_std": 0.0080,
            "tvl": 1000000.0,
            "capacity": 5000000.0,
            "risk_score": 0.25,
            "enabled": True,
        },
        {
            "id": "compound_eth_lending",
            "vault_address": "GDEF0987654321",
            "strategy_type": "LENDING",
            "asset": "ETH",
            "current_apy": 0.0812,
            "historical_apy_mean": 0.0750,
            "historical_apy_std": 0.0150,
            "tvl": 800000.0,
            "capacity": 3000000.0,
            "risk_score": 0.45,
            "enabled": True,
        },
        {
            "id": "anchor_ust_staking",
            "vault_address": "GHIJ5555555555",
            "strategy_type": "STAKING",
            "asset": "UST",
            "current_apy": 0.1950,
            "historical_apy_mean": 0.1900,
            "historical_apy_std": 0.0400,
            "tvl": 500000.0,
            "capacity": 1000000.0,
            "risk_score": 0.75,
            "enabled": True,
        },
        {
            "id": "curve_3pool_farming",
            "vault_address": "GKLM9999999999",
            "strategy_type": "LP_FARMING",
            "asset": "3CRV",
            "current_apy": 0.0650,
            "historical_apy_mean": 0.0600,
            "historical_apy_std": 0.0120,
            "tvl": 1200000.0,
            "capacity": 8000000.0,
            "risk_score": 0.35,
            "enabled": True,
        },
    ]

    for strategy in strategies:
        response = await client.post(
            f"{API_PREFIX}/rebalancing/strategies",
            json=strategy,
        )

        if response.status_code == 201:
            print(f"✓ Registered: {strategy['id']} (APY: {strategy['current_apy']*100:.2f}%)")
        elif response.status_code == 409:
            print(f"○ Already exists: {strategy['id']}")
        else:
            print(f"✗ Failed to register {strategy['id']}: {response.text}")


async def list_strategies(client: httpx.AsyncClient):
    """List all registered strategies."""
    print("\n=== Current Vault Strategies ===")

    response = await client.get(f"{API_PREFIX}/rebalancing/strategies")

    if response.status_code == 200:
        data = response.json()
        for strategy in data:
            print(
                f"• {strategy['id']}: "
                f"{strategy['current_apy']*100:.2f}% APY, "
                f"TVL: ${strategy['tvl']:,.0f}, "
                f"Risk: {strategy['risk_score']:.2f}"
            )
    else:
        print(f"✗ Failed to list strategies: {response.text}")


async def simulate_apy_changes(client: httpx.AsyncClient):
    """Simulate APY changes to create drift."""
    print("\n=== Simulating APY Changes ===")

    apy_updates = [
        {"strategy_id": "aave_usdc_lending", "current_apy": 0.0480},  # Decreased
        {"strategy_id": "compound_eth_lending", "current_apy": 0.0950},  # Increased
        {"strategy_id": "anchor_ust_staking", "current_apy": 0.2100},  # Increased
    ]

    for update in apy_updates:
        response = await client.post(
            f"{API_PREFIX}/rebalancing/strategies/update-apy",
            json=update,
        )

        if response.status_code == 200:
            print(
                f"✓ Updated {update['strategy_id']}: "
                f"{update['current_apy']*100:.2f}% APY"
            )
        else:
            print(f"✗ Failed to update {update['strategy_id']}: {response.text}")


async def check_drift(client: httpx.AsyncClient):
    """Check current allocation drift."""
    print("\n=== Checking Allocation Drift ===")

    response = await client.get(f"{API_PREFIX}/rebalancing/drift")

    if response.status_code == 200:
        data = response.json()

        print(f"Max Drift: {data['max_drift']*100:.2f}%")
        print(f"Threshold: {data['drift_threshold']*100:.2f}%")
        print(f"Rebalancing Needed: {'YES' if data['rebalancing_needed'] else 'NO'}")

        print("\nCurrent vs Target Allocations:")
        for strategy_id in data['current_allocations'].keys():
            current = data['current_allocations'][strategy_id]
            target = data['target_allocations'][strategy_id]
            drift = data['drift_per_strategy'][strategy_id]

            print(
                f"  {strategy_id}:"
                f"\n    Current: {current*100:.2f}%"
                f"\n    Target:  {target*100:.2f}%"
                f"\n    Drift:   {drift*100:.2f}%"
            )

        return data['rebalancing_needed']
    else:
        print(f"✗ Failed to check drift: {response.text}")
        return False


async def trigger_rebalancing(client: httpx.AsyncClient):
    """Trigger capital rebalancing."""
    print("\n=== Triggering Rebalancing ===")

    response = await client.post(
        f"{API_PREFIX}/rebalancing/trigger",
        json={"force": False},
    )

    if response.status_code == 200:
        data = response.json()

        if data['success'] and data['rebalancing_id']:
            print(f"✓ Rebalancing initiated")
            print(f"  Operation ID: {data['rebalancing_id']}")
            return data['rebalancing_id']
        else:
            print(f"○ {data['message']}")
            return None
    else:
        print(f"✗ Failed to trigger rebalancing: {response.text}")
        return None


async def monitor_rebalancing(client: httpx.AsyncClient, rebalancing_id: str):
    """Monitor rebalancing operation status."""
    print("\n=== Monitoring Rebalancing ===")

    response = await client.get(
        f"{API_PREFIX}/rebalancing/history/{rebalancing_id}"
    )

    if response.status_code == 200:
        data = response.json()

        print(f"Status: {data['status']}")
        print(f"Triggered: {data['triggered_at']}")

        if data['completed_at']:
            print(f"Completed: {data['completed_at']}")

        print(f"Total Capital: ${data['total_capital']:,.2f}")
        print(f"Drift Magnitude: {data['drift_magnitude']*100:.2f}%")

        if data['aggregate_apy_before'] and data['aggregate_apy_after']:
            improvement = (
                data['aggregate_apy_after'] - data['aggregate_apy_before']
            ) * 100
            print(
                f"APY Improvement: {improvement:+.2f} basis points "
                f"({data['aggregate_apy_before']*100:.2f}% → "
                f"{data['aggregate_apy_after']*100:.2f}%)"
            )

        if data['movements']:
            print("\nCapital Movements:")
            for movement in data['movements']:
                print(
                    f"  • {movement['strategy_id']}: "
                    f"{movement['direction']} ${abs(movement['delta_amount']):,.2f}"
                )

        if data['transaction_hashes']:
            print(f"\nTransactions: {len(data['transaction_hashes'])} submitted")

        if data['execution_cost']:
            print(f"Execution Cost: ${data['execution_cost']:.2f}")

    else:
        print(f"✗ Failed to fetch rebalancing details: {response.text}")


async def list_rebalancing_history(client: httpx.AsyncClient):
    """List recent rebalancing operations."""
    print("\n=== Recent Rebalancing History ===")

    response = await client.get(
        f"{API_PREFIX}/rebalancing/history?limit=5&status=COMPLETED"
    )

    if response.status_code == 200:
        history = response.json()

        if not history:
            print("No completed rebalancing operations found.")
            return

        for record in history:
            triggered = record['triggered_at']
            apy_change = (
                (record['aggregate_apy_after'] - record['aggregate_apy_before']) * 100
                if record['aggregate_apy_after'] and record['aggregate_apy_before']
                else 0
            )

            print(
                f"• {record['id'][:16]}... @ {triggered}"
                f"\n  Drift: {record['drift_magnitude']*100:.2f}%, "
                f"APY Δ: {apy_change:+.2f}bp"
            )
    else:
        print(f"✗ Failed to fetch history: {response.text}")


async def main():
    """Main execution flow."""
    print("╔═══════════════════════════════════════════════════════════╗")
    print("║   Capital Rebalancing System - Usage Example             ║")
    print("╚═══════════════════════════════════════════════════════════╝")

    async with httpx.AsyncClient(base_url=API_BASE_URL, timeout=30.0) as client:
        # Step 1: Register strategies
        await register_strategies(client)

        # Step 2: List strategies
        await list_strategies(client)

        # Step 3: Simulate APY changes
        await simulate_apy_changes(client)

        # Step 4: Check drift
        rebalancing_needed = await check_drift(client)

        # Step 5: Trigger rebalancing if needed
        if rebalancing_needed:
            rebalancing_id = await trigger_rebalancing(client)

            if rebalancing_id:
                # Wait a bit for processing
                print("\nWaiting for rebalancing to complete...")
                await asyncio.sleep(3)

                # Step 6: Monitor the operation
                await monitor_rebalancing(client, rebalancing_id)

        # Step 7: View history
        await list_rebalancing_history(client)

    print("\n✓ Example completed successfully!")


if __name__ == "__main__":
    asyncio.run(main())
