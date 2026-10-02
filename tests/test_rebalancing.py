"""Integration tests for capital rebalancing system.

Run with: pytest tests/test_rebalancing.py -v
"""

from decimal import Decimal
from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.allocation import (
    VaultStrategy,
    CapitalAllocation,
    RebalancingHistory,
)
from app.services.portfolio_optimizer import PortfolioOptimizer
from app.services.capital_rebalancer import CapitalRebalancer


class MockRelayerPool:
    """Mock relayer pool for testing."""

    def __init__(self):
        self.accounts = ["GABC...", "GDEF..."]

    def acquire_account(self, seed_map=None):
        return ("GABC...", 12345)

    def release_account(self, account, sequence, success=True):
        pass


@pytest.fixture
def optimizer():
    """Create portfolio optimizer instance."""
    return PortfolioOptimizer(
        risk_aversion=0.5,
        max_single_allocation=0.5,
        min_allocation=0.01,
    )


@pytest.fixture
def sample_strategies():
    """Sample vault strategies for testing."""
    return [
        {
            "id": "aave_usdc",
            "current_apy": 0.05,
            "historical_apy_std": 0.01,
            "tvl": 1000000.0,
            "capacity": 5000000.0,
            "risk_score": 0.3,
            "enabled": True,
        },
        {
            "id": "compound_eth",
            "current_apy": 0.08,
            "historical_apy_std": 0.02,
            "tvl": 800000.0,
            "capacity": 3000000.0,
            "risk_score": 0.5,
            "enabled": True,
        },
        {
            "id": "anchor_ust",
            "current_apy": 0.12,
            "historical_apy_std": 0.05,
            "tvl": 500000.0,
            "capacity": 1000000.0,
            "risk_score": 0.8,
            "enabled": True,
        },
    ]


class TestPortfolioOptimizer:
    """Test suite for PortfolioOptimizer."""

    def test_compute_target_allocations(self, optimizer, sample_strategies):
        """Test target allocation computation."""
        total_capital = Decimal("1000000.0")
        allocations, metrics = optimizer.compute_target_allocations(
            sample_strategies, total_capital
        )

        # Verify weights sum to 1
        total_weight = sum(allocations.values())
        assert abs(total_weight - Decimal("1.0")) < Decimal("0.001")

        # Verify all allocations are positive
        for weight in allocations.values():
            assert weight > 0

        # Verify diversification constraint
        for weight in allocations.values():
            assert weight <= Decimal("0.5")  # max_single_allocation

        # Verify metrics are computed
        assert "expected_apy" in metrics
        assert metrics["expected_apy"] > 0

    def test_compute_target_allocations_with_capacity_constraint(
        self, optimizer, sample_strategies
    ):
        """Test allocation respects vault capacity limits."""
        total_capital = Decimal("10000000.0")  # Large capital
        allocations, metrics = optimizer.compute_target_allocations(
            sample_strategies, total_capital
        )

        # Verify capacity constraints are respected
        for strategy in sample_strategies:
            strategy_id = strategy["id"]
            allocated_amount = allocations[strategy_id] * total_capital
            capacity = strategy["capacity"]

            if capacity is not None:
                assert float(allocated_amount) <= capacity

    def test_check_drift(self, optimizer):
        """Test drift calculation."""
        current_allocations = {
            "aave_usdc": Decimal("0.3"),
            "compound_eth": Decimal("0.5"),
            "anchor_ust": Decimal("0.2"),
        }

        target_allocations = {
            "aave_usdc": Decimal("0.4"),
            "compound_eth": Decimal("0.45"),
            "anchor_ust": Decimal("0.15"),
        }

        max_drift, drifts = optimizer.check_drift(
            current_allocations, target_allocations
        )

        # aave_usdc has largest drift: |0.4 - 0.3| = 0.1
        assert max_drift == Decimal("0.1")
        assert drifts["aave_usdc"] == Decimal("0.1")
        assert drifts["compound_eth"] == Decimal("0.05")
        assert drifts["anchor_ust"] == Decimal("0.05")

    def test_high_risk_aversion_prefers_low_volatility(self):
        """Test that high risk aversion allocates more to low-volatility strategies."""
        conservative_optimizer = PortfolioOptimizer(
            risk_aversion=5.0,  # Very risk-averse
            max_single_allocation=1.0,
            min_allocation=0.0,
        )

        strategies = [
            {
                "id": "low_risk",
                "current_apy": 0.03,
                "historical_apy_std": 0.005,  # Low volatility
                "tvl": 1000000.0,
                "capacity": None,
                "risk_score": 0.1,
                "enabled": True,
            },
            {
                "id": "high_risk",
                "current_apy": 0.10,
                "historical_apy_std": 0.08,  # High volatility
                "tvl": 1000000.0,
                "capacity": None,
                "risk_score": 0.9,
                "enabled": True,
            },
        ]

        allocations, _ = conservative_optimizer.compute_target_allocations(
            strategies, Decimal("1000000.0")
        )

        # Conservative optimizer should prefer low_risk despite lower APY
        assert allocations["low_risk"] > allocations["high_risk"]


class TestCapitalRebalancer:
    """Test suite for CapitalRebalancer (unit tests with mocks)."""

    def test_generate_rebalancing_id(self):
        """Test rebalancing ID generation."""
        optimizer = PortfolioOptimizer()
        relayer_pool = MockRelayerPool()
        rebalancer = CapitalRebalancer(
            optimizer=optimizer,
            relayer_pool=relayer_pool,
            drift_threshold=Decimal("0.05"),
        )

        id1 = rebalancer._generate_rebalancing_id()
        id2 = rebalancer._generate_rebalancing_id()

        # IDs should be unique
        assert id1 != id2
        # Should be valid SHA-256 hex
        assert len(id1) == 64
        assert all(c in "0123456789abcdef" for c in id1)

    def test_compute_movements(self):
        """Test capital movement computation."""
        optimizer = PortfolioOptimizer()
        relayer_pool = MockRelayerPool()
        rebalancer = CapitalRebalancer(
            optimizer=optimizer,
            relayer_pool=relayer_pool,
            drift_threshold=Decimal("0.05"),
        )

        current_allocations = {
            "aave_usdc": Decimal("0.3"),
            "compound_eth": Decimal("0.7"),
        }

        target_allocations = {
            "aave_usdc": Decimal("0.5"),
            "compound_eth": Decimal("0.5"),
        }

        total_capital = Decimal("1000000.0")

        movements = rebalancer._compute_movements(
            current_allocations, target_allocations, total_capital
        )

        # Should have 2 movements
        assert len(movements) == 2

        # Find movements by strategy
        aave_movement = next(m for m in movements if m["strategy_id"] == "aave_usdc")
        compound_movement = next(
            m for m in movements if m["strategy_id"] == "compound_eth"
        )

        # aave should INCREASE by 0.2 * 1M = 200k
        assert aave_movement["direction"] == "INCREASE"
        assert abs(aave_movement["delta_amount"] - 200000.0) < 1.0

        # compound should DECREASE by 0.2 * 1M = 200k
        assert compound_movement["direction"] == "DECREASE"
        assert abs(compound_movement["delta_amount"] - -200000.0) < 1.0

    def test_compute_aggregate_apy(self):
        """Test portfolio-weighted APY calculation."""
        optimizer = PortfolioOptimizer()
        relayer_pool = MockRelayerPool()
        rebalancer = CapitalRebalancer(
            optimizer=optimizer,
            relayer_pool=relayer_pool,
            drift_threshold=Decimal("0.05"),
        )

        strategies = [
            {"id": "strategy_a", "current_apy": 0.05},
            {"id": "strategy_b", "current_apy": 0.10},
        ]

        allocations = {
            "strategy_a": Decimal("0.6"),
            "strategy_b": Decimal("0.4"),
        }

        apy = rebalancer._compute_aggregate_apy(strategies, allocations)

        # Expected: 0.05 * 0.6 + 0.10 * 0.4 = 0.03 + 0.04 = 0.07
        assert abs(apy - 0.07) < 0.001


@pytest.mark.asyncio
class TestRebalancingIntegration:
    """Integration tests requiring database (marked with @pytest.mark.asyncio)."""

    async def test_create_vault_strategy(self, async_db_session: AsyncSession):
        """Test creating a vault strategy in the database."""
        strategy = VaultStrategy(
            id="test_strategy",
            vault_address="GABC...",
            strategy_type="LENDING",
            asset="USDC",
            current_apy=Decimal("0.05"),
            historical_apy_std=Decimal("0.01"),
            tvl=Decimal("1000000.0"),
            risk_score=Decimal("0.3"),
            enabled=True,
        )

        async_db_session.add(strategy)
        await async_db_session.commit()
        await async_db_session.refresh(strategy)

        assert strategy.id == "test_strategy"
        assert strategy.enabled is True
        assert strategy.last_apy_update is not None

    async def test_create_capital_allocation(self, async_db_session: AsyncSession):
        """Test creating a capital allocation record."""
        allocation = CapitalAllocation(
            id="test_alloc_001",
            strategy_id="test_strategy",
            allocated_amount=Decimal("500000.0"),
            target_weight=Decimal("0.5"),
            current_weight=Decimal("0.5"),
        )

        async_db_session.add(allocation)
        await async_db_session.commit()
        await async_db_session.refresh(allocation)

        assert allocation.strategy_id == "test_strategy"
        assert allocation.allocated_amount == Decimal("500000.0")

    async def test_create_rebalancing_history(self, async_db_session: AsyncSession):
        """Test creating a rebalancing history record."""
        history = RebalancingHistory(
            id="rebalance_001",
            triggered_at=datetime.now(timezone.utc),
            status="COMPLETED",
            total_capital=Decimal("1000000.0"),
            drift_magnitude=Decimal("0.08"),
            target_allocations={"strategy_a": 0.6, "strategy_b": 0.4},
            previous_allocations={"strategy_a": 0.5, "strategy_b": 0.5},
            movements=[
                {"strategy_id": "strategy_a", "delta_amount": 100000.0, "direction": "INCREASE"}
            ],
            transaction_hashes=["tx_hash_1", "tx_hash_2"],
            aggregate_apy_before=Decimal("0.06"),
            aggregate_apy_after=Decimal("0.065"),
            execution_cost=Decimal("0.5"),
        )

        async_db_session.add(history)
        await async_db_session.commit()
        await async_db_session.refresh(history)

        assert history.status == "COMPLETED"
        assert len(history.transaction_hashes) == 2


def test_fallback_proportional_allocation(sample_strategies):
    """Test fallback allocation when CVXPY unavailable."""
    optimizer = PortfolioOptimizer()

    # Force fallback by using _fallback method directly
    allocations, metrics = optimizer._fallback_proportional_allocation(
        sample_strategies, 1000000.0
    )

    # Verify weights sum to 1
    total_weight = sum(allocations.values())
    assert abs(total_weight - 1.0) < 0.001

    # Higher APY strategies should get more allocation
    assert allocations["anchor_ust"] > allocations["compound_eth"]
    assert allocations["compound_eth"] > allocations["aave_usdc"]

    # Verify metrics
    assert metrics["optimization_status"] == "fallback_proportional"
    assert metrics["expected_apy"] > 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
