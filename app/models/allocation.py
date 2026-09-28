"""app/models/allocation.py — ORM models for vault capital allocation and rebalancing.

Tables:
  vault_strategy         — yield strategy configuration and APY tracking
  capital_allocation     — current capital allocation across vaults
  rebalancing_history    — audit trail of rebalancing operations
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import (
    DateTime,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class VaultStrategy(Base):
    """Yield strategy configuration for a vault.

    Attributes
    ----------
    id : str
        Unique strategy identifier (e.g., "aave_usdc_lending", "compound_eth").
    vault_address : str
        On-chain vault contract address.
    strategy_type : str
        Strategy category (LENDING, STAKING, LP_FARMING).
    asset : str
        Primary asset ticker (e.g., "USDC", "XLM").
    current_apy : Decimal
        Current annual percentage yield (fractional, e.g., 0.0523 = 5.23%).
    historical_apy_mean : Decimal
        Mean APY over historical window.
    historical_apy_std : Decimal
        Standard deviation of APY (risk measure).
    tvl : Decimal
        Total value locked in the vault.
    capacity : Decimal
        Maximum vault capacity (None = unlimited).
    risk_score : Decimal
        Risk rating 0.0-1.0 (0 = lowest risk, 1 = highest risk).
    enabled : bool
        Whether strategy is enabled for allocation.
    metadata : dict
        Additional strategy configuration.
    last_apy_update : datetime
        Timestamp of last APY update.
    created_at : datetime
        Strategy registration timestamp.
    """

    __tablename__ = "vault_strategy"

    id: Mapped[str] = mapped_column(
        String(128),
        primary_key=True,
        comment="Unique strategy identifier",
    )

    vault_address: Mapped[str] = mapped_column(
        String(56),
        nullable=False,
        index=True,
        comment="On-chain vault contract address",
    )

    strategy_type: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        index=True,
        comment="Strategy category (LENDING, STAKING, LP_FARMING)",
    )

    asset: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        index=True,
        comment="Primary asset ticker",
    )

    current_apy: Mapped[Any] = mapped_column(
        Numeric(10, 7),
        nullable=False,
        comment="Current APY (fractional)",
    )

    historical_apy_mean: Mapped[Optional[Any]] = mapped_column(
        Numeric(10, 7),
        nullable=True,
        comment="Mean historical APY",
    )

    historical_apy_std: Mapped[Optional[Any]] = mapped_column(
        Numeric(10, 7),
        nullable=True,
        comment="APY standard deviation (risk)",
    )

    tvl: Mapped[Any] = mapped_column(
        Numeric(32, 7),
        nullable=False,
        comment="Total value locked",
    )

    capacity: Mapped[Optional[Any]] = mapped_column(
        Numeric(32, 7),
        nullable=True,
        comment="Maximum vault capacity (null = unlimited)",
    )

    risk_score: Mapped[Any] = mapped_column(
        Numeric(3, 2),
        nullable=False,
        comment="Risk rating 0.0-1.0",
    )

    enabled: Mapped[bool] = mapped_column(
        nullable=False,
        server_default=text("true"),
        index=True,
        comment="Strategy enabled for allocation",
    )

    metadata: Mapped[Optional[Dict[str, Any]]] = mapped_column(
        JSONB,
        nullable=True,
        comment="Additional strategy configuration",
    )

    last_apy_update: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
        index=True,
        comment="Last APY update timestamp",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
        comment="Strategy registration timestamp",
    )

    def __repr__(self) -> str:
        return (
            f"<VaultStrategy id={self.id} apy={self.current_apy} "
            f"tvl={self.tvl} risk={self.risk_score}>"
        )


class CapitalAllocation(Base):
    """Current capital allocation across vault strategies.

    Attributes
    ----------
    id : str
        Unique allocation record ID.
    strategy_id : str
        Reference to vault_strategy.id.
    allocated_amount : Decimal
        Capital allocated to this strategy.
    target_weight : Decimal
        Target portfolio weight (fractional, sums to 1.0).
    current_weight : Decimal
        Current portfolio weight.
    last_rebalance : datetime
        Timestamp of last rebalancing operation.
    updated_at : datetime
        Last update timestamp.
    """

    __tablename__ = "capital_allocation"

    id: Mapped[str] = mapped_column(
        String(64),
        primary_key=True,
        comment="Allocation record ID",
    )

    strategy_id: Mapped[str] = mapped_column(
        String(128),
        nullable=False,
        index=True,
        comment="Reference to vault_strategy.id",
    )

    allocated_amount: Mapped[Any] = mapped_column(
        Numeric(32, 7),
        nullable=False,
        comment="Capital allocated to strategy",
    )

    target_weight: Mapped[Any] = mapped_column(
        Numeric(5, 4),
        nullable=False,
        comment="Target portfolio weight (fractional)",
    )

    current_weight: Mapped[Any] = mapped_column(
        Numeric(5, 4),
        nullable=False,
        comment="Current portfolio weight",
    )

    last_rebalance: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        index=True,
        comment="Last rebalancing timestamp",
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
        onupdate=text("now()"),
        comment="Last update timestamp",
    )

    __table_args__ = (
        UniqueConstraint("strategy_id", name="uq_allocation_strategy"),
        Index("ix_allocation_updated", "updated_at"),
    )

    def __repr__(self) -> str:
        return (
            f"<CapitalAllocation strategy={self.strategy_id} "
            f"amount={self.allocated_amount} weight={self.current_weight}>"
        )


class RebalancingHistory(Base):
    """Audit trail of capital rebalancing operations.

    Attributes
    ----------
    id : str
        Unique rebalancing operation ID.
    triggered_at : datetime
        When rebalancing was triggered.
    completed_at : datetime
        When rebalancing completed (null if in progress).
    status : str
        Operation status (PENDING, IN_PROGRESS, COMPLETED, FAILED).
    total_capital : Decimal
        Total capital under management at rebalancing time.
    drift_magnitude : Decimal
        Max allocation drift that triggered rebalancing.
    target_allocations : dict
        Computed target allocation vector W_target.
    previous_allocations : dict
        Allocation state before rebalancing.
    movements : dict
        Capital movements executed (from_strategy -> to_strategy).
    transaction_hashes : list
        On-chain transaction hashes for audit trail.
    aggregate_apy_before : Decimal
        Portfolio-weighted APY before rebalancing.
    aggregate_apy_after : Decimal
        Portfolio-weighted APY after rebalancing.
    execution_cost : Decimal
        Gas costs and fees for rebalancing transactions.
    error_message : str
        Error details if status=FAILED.
    metadata : dict
        Additional execution context.
    created_at : datetime
        Record creation timestamp.
    """

    __tablename__ = "rebalancing_history"

    id: Mapped[str] = mapped_column(
        String(64),
        primary_key=True,
        comment="Rebalancing operation ID",
    )

    triggered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        index=True,
        comment="Rebalancing trigger timestamp",
    )

    completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        comment="Completion timestamp",
    )

    status: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        index=True,
        comment="Operation status (PENDING, IN_PROGRESS, COMPLETED, FAILED)",
    )

    total_capital: Mapped[Any] = mapped_column(
        Numeric(32, 7),
        nullable=False,
        comment="Total capital under management",
    )

    drift_magnitude: Mapped[Any] = mapped_column(
        Numeric(5, 4),
        nullable=False,
        comment="Max allocation drift magnitude",
    )

    target_allocations: Mapped[Dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        comment="Computed target allocation vector W_target",
    )

    previous_allocations: Mapped[Dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        comment="Previous allocation state",
    )

    movements: Mapped[Optional[Dict[str, Any]]] = mapped_column(
        JSONB,
        nullable=True,
        comment="Capital movements (from -> to)",
    )

    transaction_hashes: Mapped[Optional[list]] = mapped_column(
        JSONB,
        nullable=True,
        comment="On-chain transaction hashes",
    )

    aggregate_apy_before: Mapped[Optional[Any]] = mapped_column(
        Numeric(10, 7),
        nullable=True,
        comment="Portfolio APY before rebalancing",
    )

    aggregate_apy_after: Mapped[Optional[Any]] = mapped_column(
        Numeric(10, 7),
        nullable=True,
        comment="Portfolio APY after rebalancing",
    )

    execution_cost: Mapped[Optional[Any]] = mapped_column(
        Numeric(18, 7),
        nullable=True,
        comment="Gas costs and fees",
    )

    error_message: Mapped[Optional[str]] = mapped_column(
        Text,
        nullable=True,
        comment="Error details if failed",
    )

    metadata: Mapped[Optional[Dict[str, Any]]] = mapped_column(
        JSONB,
        nullable=True,
        comment="Additional execution context",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
        index=True,
        comment="Record creation timestamp",
    )

    __table_args__ = (
        Index("ix_rebalancing_status_time", "status", "triggered_at"),
    )

    def __repr__(self) -> str:
        return (
            f"<RebalancingHistory id={self.id[:12]}... status={self.status} "
            f"drift={self.drift_magnitude} capital={self.total_capital}>"
        )
