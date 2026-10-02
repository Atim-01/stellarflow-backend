"""app/services/capital_rebalancer.py — Automated capital rebalancing execution.

Orchestrates capital movements across vault strategies to align with target
allocations computed by the portfolio optimizer.
"""

from __future__ import annotations

import hashlib
import os
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_async_db
from app.models.allocation import (
    CapitalAllocation,
    RebalancingHistory,
    VaultStrategy,
)
from app.services.nonce_manager import RelayerPool, managed_sequence
from app.services.portfolio_optimizer import PortfolioOptimizer
from app.services.vault_operation_lock import vault_operation_lock

log = structlog.get_logger(__name__)


class RebalancingError(RuntimeError):
    """Raised when capital rebalancing fails."""


class CapitalRebalancer:
    """Orchestrates automated capital rebalancing across vault strategies.

    Parameters
    ----------
    optimizer : PortfolioOptimizer
        Portfolio optimizer instance for computing target allocations.
    relayer_pool : RelayerPool
        Relayer pool for transaction execution.
    drift_threshold : Decimal
        Minimum drift magnitude to trigger rebalancing (default: 0.05 = 5%).
    treasury_account : str
        Treasury account address managing capital.
    """

    def __init__(
        self,
        optimizer: PortfolioOptimizer,
        relayer_pool: RelayerPool,
        drift_threshold: Decimal = Decimal("0.05"),
        treasury_account: Optional[str] = None,
    ) -> None:
        if not 0 < drift_threshold <= 1:
            raise ValueError("drift_threshold must be in (0, 1]")

        self.optimizer = optimizer
        self.relayer_pool = relayer_pool
        self.drift_threshold = drift_threshold
        self.treasury_account = treasury_account or os.getenv(
            "TREASURY_ACCOUNT", "GABC..."
        )

        log.info(
            "capital_rebalancer.initialized",
            component="CapitalRebalancer",
            drift_threshold=float(drift_threshold),
            treasury_account=self.treasury_account,
        )

    async def check_and_rebalance(
        self,
        db: AsyncSession,
    ) -> Optional[str]:
        """Check allocation drift and execute rebalancing if threshold exceeded.

        Parameters
        ----------
        db : AsyncSession
            Database session for ORM operations.

        Returns
        -------
        Optional[str]
            Rebalancing operation ID if executed, None if no rebalancing needed.

        Raises
        ------
        RebalancingError
            If rebalancing execution fails.
        """
        bound = log.bind(component="CapitalRebalancer", method="check_and_rebalance")

        # Fetch all strategies
        strategies = await self._fetch_strategies(db)
        if not strategies:
            bound.warning("no_strategies_found")
            return None

        # Compute total capital
        total_capital = await self._compute_total_capital(db)
        if total_capital <= 0:
            bound.warning("zero_total_capital")
            return None

        # Get current allocations
        current_allocations = await self._fetch_current_allocations(db)

        # Compute target allocations
        target_allocations, metrics = self.optimizer.compute_target_allocations(
            strategies, total_capital
        )

        # Check drift
        max_drift, drifts = self.optimizer.check_drift(
            current_allocations, target_allocations
        )

        bound.info(
            "drift_computed",
            max_drift=float(max_drift),
            threshold=float(self.drift_threshold),
            expected_apy=metrics.get("expected_apy"),
        )

        # Execute rebalancing if drift exceeds threshold
        if max_drift > self.drift_threshold:
            rebalancing_id = await self._execute_rebalancing(
                db=db,
                strategies=strategies,
                current_allocations=current_allocations,
                target_allocations=target_allocations,
                total_capital=total_capital,
                max_drift=max_drift,
                metrics=metrics,
            )
            bound.info("rebalancing_triggered", rebalancing_id=rebalancing_id)
            return rebalancing_id
        else:
            bound.info("no_rebalancing_needed", max_drift=float(max_drift))
            return None

    async def _fetch_strategies(self, db: AsyncSession) -> List[Dict[str, Any]]:
        """Fetch all enabled vault strategies."""
        stmt = select(VaultStrategy).where(VaultStrategy.enabled == True)
        result = await db.execute(stmt)
        strategies = result.scalars().all()

        return [
            {
                "id": s.id,
                "vault_address": s.vault_address,
                "current_apy": float(s.current_apy),
                "historical_apy_std": float(s.historical_apy_std or 0.01),
                "tvl": float(s.tvl),
                "capacity": float(s.capacity) if s.capacity else None,
                "risk_score": float(s.risk_score),
                "enabled": s.enabled,
            }
            for s in strategies
        ]

    async def _compute_total_capital(self, db: AsyncSession) -> Decimal:
        """Compute total capital under management."""
        stmt = select(CapitalAllocation)
        result = await db.execute(stmt)
        allocations = result.scalars().all()

        total = sum(a.allocated_amount for a in allocations)
        return Decimal(str(total))

    async def _fetch_current_allocations(
        self, db: AsyncSession
    ) -> Dict[str, Decimal]:
        """Fetch current allocation weights."""
        stmt = select(CapitalAllocation)
        result = await db.execute(stmt)
        allocations = result.scalars().all()

        return {a.strategy_id: Decimal(str(a.current_weight)) for a in allocations}

    async def _execute_rebalancing(
        self,
        db: AsyncSession,
        strategies: List[Dict[str, Any]],
        current_allocations: Dict[str, Decimal],
        target_allocations: Dict[str, Decimal],
        total_capital: Decimal,
        max_drift: Decimal,
        metrics: Dict[str, Any],
    ) -> str:
        """Execute capital rebalancing operation."""
        bound = log.bind(component="CapitalRebalancer", method="_execute_rebalancing")

        # Generate rebalancing ID
        rebalancing_id = self._generate_rebalancing_id()

        # Compute capital movements
        movements = self._compute_movements(
            current_allocations, target_allocations, total_capital
        )

        # Compute aggregate APY before rebalancing
        apy_before = self._compute_aggregate_apy(strategies, current_allocations)

        # Create rebalancing history record
        history = RebalancingHistory(
            id=rebalancing_id,
            triggered_at=datetime.now(timezone.utc),
            status="IN_PROGRESS",
            total_capital=total_capital,
            drift_magnitude=max_drift,
            target_allocations={k: float(v) for k, v in target_allocations.items()},
            previous_allocations={k: float(v) for k, v in current_allocations.items()},
            movements=movements,
            aggregate_apy_before=Decimal(str(apy_before)),
            metadata=metrics,
        )
        db.add(history)
        await db.commit()

        bound.info(
            "rebalancing_started",
            rebalancing_id=rebalancing_id,
            movements_count=len(movements),
        )

        # Execute on-chain transactions
        transaction_hashes = []
        execution_cost = Decimal("0")

        try:
            with vault_operation_lock(self.treasury_account):
                for movement in movements:
                    tx_hash, cost = await self._execute_movement(movement)
                    transaction_hashes.append(tx_hash)
                    execution_cost += cost
                    bound.debug("movement_executed", tx_hash=tx_hash, cost=float(cost))

            # Update capital allocations in database
            await self._update_allocations(db, target_allocations, total_capital)

            # Compute aggregate APY after rebalancing
            apy_after = self._compute_aggregate_apy(strategies, target_allocations)

            # Mark rebalancing as completed
            history.status = "COMPLETED"
            history.completed_at = datetime.now(timezone.utc)
            history.transaction_hashes = transaction_hashes
            history.execution_cost = execution_cost
            history.aggregate_apy_after = Decimal(str(apy_after))
            await db.commit()

            bound.info(
                "rebalancing_completed",
                rebalancing_id=rebalancing_id,
                tx_count=len(transaction_hashes),
                apy_improvement=float(apy_after - apy_before),
            )

            return rebalancing_id

        except Exception as exc:
            bound.exception("rebalancing_failed", error=str(exc))
            history.status = "FAILED"
            history.error_message = str(exc)
            await db.commit()
            raise RebalancingError(f"Rebalancing failed: {exc}") from exc

    def _generate_rebalancing_id(self) -> str:
        """Generate unique rebalancing operation ID."""
        timestamp = datetime.now(timezone.utc).isoformat()
        hash_input = f"rebalancing:{timestamp}:{os.urandom(8).hex()}"
        return hashlib.sha256(hash_input.encode()).hexdigest()

    def _compute_movements(
        self,
        current_allocations: Dict[str, Decimal],
        target_allocations: Dict[str, Decimal],
        total_capital: Decimal,
    ) -> List[Dict[str, Any]]:
        """Compute capital movements needed to reach target allocations."""
        movements = []

        all_strategies = set(current_allocations.keys()) | set(
            target_allocations.keys()
        )

        for strategy_id in all_strategies:
            current_weight = current_allocations.get(strategy_id, Decimal("0"))
            target_weight = target_allocations.get(strategy_id, Decimal("0"))
            delta_weight = target_weight - current_weight

            if abs(delta_weight) > Decimal("0.0001"):  # Ignore dust
                delta_amount = delta_weight * total_capital
                movements.append(
                    {
                        "strategy_id": strategy_id,
                        "delta_weight": float(delta_weight),
                        "delta_amount": float(delta_amount),
                        "direction": "INCREASE" if delta_amount > 0 else "DECREASE",
                    }
                )

        return movements

    async def _execute_movement(
        self, movement: Dict[str, Any]
    ) -> Tuple[str, Decimal]:
        """Execute a single capital movement on-chain.

        Parameters
        ----------
        movement : Dict[str, Any]
            Movement specification with strategy_id, delta_amount, direction.

        Returns
        -------
        Tuple[str, Decimal]
            (transaction_hash, execution_cost)
        """
        strategy_id = movement["strategy_id"]
        delta_amount = movement["delta_amount"]
        direction = movement["direction"]

        bound = log.bind(
            component="CapitalRebalancer",
            strategy_id=strategy_id,
            delta_amount=delta_amount,
            direction=direction,
        )

        # Acquire relayer account and sequence
        with managed_sequence(self.relayer_pool) as (account, sequence):
            # Build transaction (pseudo-code - actual implementation depends on Soroban contract)
            # tx = build_vault_deposit_or_withdraw_tx(
            #     vault_address=vault_address,
            #     amount=abs(delta_amount),
            #     operation=direction,
            #     source_account=account,
            #     sequence=sequence,
            # )
            # tx_hash = await submit_transaction(tx)

            # Mock transaction submission for now
            tx_hash = hashlib.sha256(
                f"{strategy_id}:{delta_amount}:{account}:{sequence}".encode()
            ).hexdigest()
            execution_cost = Decimal("0.01")  # Mock gas cost

            bound.info("movement_tx_submitted", tx_hash=tx_hash)

            return tx_hash, execution_cost

    async def _update_allocations(
        self,
        db: AsyncSession,
        target_allocations: Dict[str, Decimal],
        total_capital: Decimal,
    ) -> None:
        """Update capital_allocation table with new target weights and amounts."""
        for strategy_id, target_weight in target_allocations.items():
            allocated_amount = target_weight * total_capital

            # Upsert allocation record
            stmt = select(CapitalAllocation).where(
                CapitalAllocation.strategy_id == strategy_id
            )
            result = await db.execute(stmt)
            allocation = result.scalar_one_or_none()

            if allocation:
                allocation.target_weight = target_weight
                allocation.current_weight = target_weight
                allocation.allocated_amount = allocated_amount
                allocation.last_rebalance = datetime.now(timezone.utc)
            else:
                allocation = CapitalAllocation(
                    id=self._generate_allocation_id(strategy_id),
                    strategy_id=strategy_id,
                    allocated_amount=allocated_amount,
                    target_weight=target_weight,
                    current_weight=target_weight,
                    last_rebalance=datetime.now(timezone.utc),
                )
                db.add(allocation)

        await db.commit()

    def _generate_allocation_id(self, strategy_id: str) -> str:
        """Generate allocation record ID."""
        return hashlib.sha256(f"allocation:{strategy_id}".encode()).hexdigest()[:16]

    def _compute_aggregate_apy(
        self,
        strategies: List[Dict[str, Any]],
        allocations: Dict[str, Decimal],
    ) -> float:
        """Compute portfolio-weighted aggregate APY."""
        strategy_apy_map = {s["id"]: s["current_apy"] for s in strategies}

        weighted_apy = sum(
            float(allocations.get(strategy_id, Decimal("0")))
            * strategy_apy_map.get(strategy_id, 0.0)
            for strategy_id in allocations.keys()
        )

        return weighted_apy


async def create_capital_rebalancer(
    optimizer: PortfolioOptimizer,
    relayer_pool: RelayerPool,
) -> CapitalRebalancer:
    """Factory for creating CapitalRebalancer instance.

    Parameters
    ----------
    optimizer : PortfolioOptimizer
        Portfolio optimizer instance.
    relayer_pool : RelayerPool
        Relayer pool for transaction execution.

    Returns
    -------
    CapitalRebalancer
        Configured rebalancer instance.
    """
    drift_threshold = Decimal(os.getenv("REBALANCING_DRIFT_THRESHOLD", "0.05"))
    treasury_account = os.getenv("TREASURY_ACCOUNT")

    return CapitalRebalancer(
        optimizer=optimizer,
        relayer_pool=relayer_pool,
        drift_threshold=drift_threshold,
        treasury_account=treasury_account,
    )
