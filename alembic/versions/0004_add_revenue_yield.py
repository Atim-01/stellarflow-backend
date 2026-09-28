"""Add flash_loan_revenue and protocol_yield_snapshot tables.

Revision ID: 0004
Revises:     0003
Create Date: 2026-08-27 12:40:00.000000 UTC

Creates the ``flash_loan_revenue`` table to persist parsed
``FlashLoanFeesDistributed`` contract events and the
``protocol_yield_snapshot`` table for periodic aggregate yield metrics.
"""

from __future__ import annotations

from datetime import date
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
try:
    from sqlalchemy.dialects.postgresql import JSONB
except ImportError:
    JSONB = sa.JSON

# ---------------------------------------------------------------------------
# Revision identifiers
# ---------------------------------------------------------------------------
revision: str = "0004"
down_revision: Union[str, Sequence[str], None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _table_exists(name: str) -> bool:
    """Return True when *name* already exists in the public schema."""
    bind = op.get_bind()
    if bind is None or getattr(bind, "dialect", None) is None:
        return False
    try:
        return sa.inspect(bind).has_table(name)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# upgrade
# ---------------------------------------------------------------------------

def upgrade() -> None:
    """Create ``flash_loan_revenue`` and ``protocol_yield_snapshot`` tables."""

    if _table_exists("flash_loan_revenue"):
        return

    op.create_table(
        "flash_loan_revenue",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("ledger_sequence", sa.Integer(), nullable=False, index=True),
        sa.Column("tx_hash", sa.String(128), nullable=False, index=True),
        sa.Column("event_index", sa.Integer(), nullable=False),
        sa.Column("amount", sa.Numeric(32, 7), nullable=True),
        sa.Column("treasury_account", sa.String(56), nullable=True, index=True),
        sa.Column("block_time", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("payload", JSONB, nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
            index=True,
        ),
    )

    op.create_index(
        "ix_flash_loan_revenue_treasury_created",
        "flash_loan_revenue",
        ["treasury_account", "created_at"],
    )

    if _table_exists("protocol_yield_snapshot"):
        return

    op.create_table(
        "protocol_yield_snapshot",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("granularity", sa.String(16), nullable=False, index=True),
        sa.Column("window_start", sa.TIMESTAMP(timezone=True), nullable=False, index=True),
        sa.Column("window_end", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("total_flash_loan_revenue", sa.Numeric(32, 7), nullable=True),
        sa.Column("total_treasury_balance", sa.Numeric(32, 7), nullable=True),
        sa.Column("yield_apy", sa.Numeric(10, 7), nullable=True),
        sa.Column("fee_volume", sa.Numeric(32, 7), nullable=True),
        sa.Column("event_count", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
            index=True,
        ),
    )

    op.create_index(
        "ix_protocol_yield_snapshot_granularity_window",
        "protocol_yield_snapshot",
        ["granularity", "window_start"],
    )


# ---------------------------------------------------------------------------
# downgrade
# ---------------------------------------------------------------------------

def downgrade() -> None:
    """Drop ``protocol_yield_snapshot`` and ``flash_loan_revenue`` tables."""

    op.drop_table("protocol_yield_snapshot")
    op.drop_table("flash_loan_revenue")
