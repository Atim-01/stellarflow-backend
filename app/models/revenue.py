"""app/models/revenue.py — ORM models for flash-loan revenue and protocol yield analytics.

Tables:
  flash_loan_revenue     — accumulated flash-loan execution fees per distribution event
  protocol_yield_snapshot — periodic aggregate yield metrics for the protocol
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
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.models.events import _PartitionBase


class FlashLoanRevenue(_PartitionBase):
    """Flash-loan revenue record — one row per ``FlashLoanFeesDistributed`` event.

    Attributes
    ----------
    id : str
        Deterministic dedup key (SHA-256 of tx_hash + event_index).
    ledger_sequence : int
        Stellar ledger sequence when the event occurred.
    tx_hash : str
        Transaction hash that emitted the event.
    event_index : int
        Index of the event within the transaction.
    amount : Decimal
        Flash-loan fee amount in the protocol's base asset (stroops).
    treasury_account : str
        Destination DAO treasury account public key.
    block_time : datetime
        Ledger close time (UTC) from the event payload.
    payload : dict
        Full raw event payload from the Soroban stream.
    created_at : datetime
        Wall-clock timestamp of ingestion.
    """

    __tablename__ = "flash_loan_revenue"

    id: Mapped[str] = mapped_column(
        String(64),
        primary_key=True,
        comment="SHA-256(tx_hash:event_index)",
    )

    ledger_sequence: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        index=True,
        comment="Stellar ledger sequence number",
    )

    tx_hash: Mapped[str] = mapped_column(
        String(128),
        nullable=False,
        index=True,
        comment="Transaction hash",
    )

    event_index: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        comment="Event index within the transaction",
    )

    amount: Mapped[Optional[Any]] = mapped_column(
        Numeric(32, 7),
        nullable=True,
        comment="Flash-loan fee amount (base asset, stroops)",
    )

    treasury_account: Mapped[Optional[str]] = mapped_column(
        String(56),
        nullable=True,
        index=True,
        comment="Destination DAO treasury account",
    )

    block_time: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        comment="Ledger close time (UTC)",
    )

    payload: Mapped[Optional[Dict[str, Any]]] = mapped_column(
        JSONB,
        nullable=True,
        comment="Full Soroban event payload",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
        index=True,
        comment="Ingestion timestamp",
    )

    __table_args__ = (
        Index(
            "ix_flash_loan_revenue_treasury_created",
            "treasury_account",
            "created_at",
        ),
        {
            "comment": "Flash-loan fee distribution events — range-partitioned by created_at (monthly)",
        },
    )

    def __repr__(self) -> str:
        return (
            f"<FlashLoanRevenue id={self.id[:12]}... "
            f"seq={self.ledger_sequence} amount={self.amount}>"
        )


class ProtocolYieldSnapshot(_PartitionBase):
    """Periodic aggregate yield analytics for the protocol.

    Attributes
    ----------
    id : str
        Deterministic dedup key (SHA-256 of granularity + window_start).
    granularity : str
        Snapshot granularity (e.g. ``HOURLY``, ``DAILY``).
    window_start : datetime
        Start of the aggregation window (UTC).
    window_end : datetime
        End of the aggregation window (UTC).
    total_flash_loan_revenue : Decimal
        Cumulative flash-loan fees collected during the window.
    total_treasury_balance : Decimal
        Recorded treasury balance at window close.
    yield_apy : Decimal
        Implied protocol yield APY (fractional, e.g. 0.0523 = 5.23%).
    fee_volume : Decimal
        Total flash-loan notional volume during the window.
    event_count : int
        Number of flash-loan events in the window.
    created_at : datetime
        Wall-clock timestamp of snapshot creation.
    """

    __tablename__ = "protocol_yield_snapshot"

    id: Mapped[str] = mapped_column(
        String(64),
        primary_key=True,
        comment="SHA-256(granularity:window_start)",
    )

    granularity: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        index=True,
        comment="Snapshot granularity (HOURLY, DAILY)",
    )

    window_start: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        index=True,
        comment="Aggregation window start (UTC)",
    )

    window_end: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        comment="Aggregation window end (UTC)",
    )

    total_flash_loan_revenue: Mapped[Optional[Any]] = mapped_column(
        Numeric(32, 7),
        nullable=True,
        comment="Cumulative flash-loan fees in window",
    )

    total_treasury_balance: Mapped[Optional[Any]] = mapped_column(
        Numeric(32, 7),
        nullable=True,
        comment="Treasury balance at window close",
    )

    yield_apy: Mapped[Optional[Any]] = mapped_column(
        Numeric(10, 7),
        nullable=True,
        comment="Implied protocol yield APY (fractional)",
    )

    fee_volume: Mapped[Optional[Any]] = mapped_column(
        Numeric(32, 7),
        nullable=True,
        comment="Flash-loan notional volume in window",
    )

    event_count: Mapped[Optional[int]] = mapped_column(
        Integer,
        nullable=True,
        comment="Number of flash-loan events in window",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
        index=True,
        comment="Snapshot creation timestamp",
    )

    __table_args__ = (
        Index(
            "ix_protocol_yield_snapshot_granularity_window",
            "granularity",
            "window_start",
        ),
        {
            "comment": "Protocol yield analytics snapshots — range-partitioned by created_at (monthly)",
        },
    )

    def __repr__(self) -> str:
        return (
            f"<ProtocolYieldSnapshot id={self.id[:12]}... "
            f"granularity={self.granularity} window={self.window_start} "
            f"revenue={self.total_flash_loan_revenue}>"
        )
