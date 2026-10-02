"""Add range-partitioned ledger_events table (monthly partitions).

Revision ID: 0002
Revises:     0001
Create Date: 2026-08-25 00:00:00.000000 UTC

Creates the ``ledger_events`` parent table as a PostgreSQL declaratively
partitioned table using RANGE partitioning on the ``created_at`` column
(month/year boundaries).

Monthly child tables (e.g. ``ledger_events_2026_08``) are created for the
current and next calendar months.  Additional future partitions are managed
automatically by ``src/database/partition_manager.py``.

Downgrade drops all child partitions first, then the parent table.
"""

from __future__ import annotations

from datetime import date
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# ---------------------------------------------------------------------------
# Revision identifiers
# ---------------------------------------------------------------------------
revision: str = "0002"
down_revision: Union[str, Sequence[str], None] = "0001"
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


def _create_monthly_partition(
    parent_table: str,
    partition_name: str,
    lower_bound: str,
    upper_bound: str,
) -> None:
    """Execute CREATE TABLE IF NOT EXISTS for a single monthly partition.

    Parameters
    ----------
    parent_table:
        The partitioned parent table name (e.g. ``ledger_events``).
    partition_name:
        Child table name (e.g. ``ledger_events_2026_08``).
    lower_bound:
        ISO-8601 date string for the partition's inclusive lower bound.
    upper_bound:
        ISO-8601 date string for the partition's exclusive upper bound.
    """
    op.execute(sa.text(f"""
        CREATE TABLE IF NOT EXISTS "{partition_name}"
        PARTITION OF "{parent_table}"
        FOR VALUES FROM ('{lower_bound}') TO ('{upper_bound}')
    """))


def _month_bounds(year: int, month: int) -> tuple[str, str]:
    """Return (partition_name, lower_bound) for a given year/month."""
    name = f"ledger_events_{year}_{month:02d}"
    lower = f"{year}-{month:02d}-01"
    return name, lower


def _next_month(year: int, month: int) -> tuple[int, int]:
    """Return (next_year, next_month) after the given year/month."""
    if month == 12:
        return year + 1, 1
    return year, month + 1


# ---------------------------------------------------------------------------
# upgrade — create partitioned ledger_events table + initial partitions
# ---------------------------------------------------------------------------

def upgrade() -> None:
    """Create the ``ledger_events`` partitioned parent table and initial partitions."""

    if not _table_exists("ledger_events"):
        # Create the partitioned parent table using raw PostgreSQL DDL.
        # SQLAlchemy declarative models don't natively support PARTITION BY,
        # so we issue the DDL directly.  The column definitions match the
        # LedgerEvent ORM model in app/models/events.py exactly.
        op.execute(sa.text("""
            CREATE TABLE ledger_events (
                event_hash      VARCHAR(64)      NOT NULL,
                ledger_sequence INTEGER          NOT NULL,
                tx_hash         VARCHAR(128)     NOT NULL,
                event_type      VARCHAR(128)     NOT NULL DEFAULT 'unknown',
                payload         JSONB,
                created_at      TIMESTAMPTZ      NOT NULL DEFAULT now(),

                PRIMARY KEY (event_hash, created_at)
            ) PARTITION BY RANGE (created_at)
        """))

        # Indexes on the parent table — these are propagated to all
        # child partitions automatically by PostgreSQL.
        op.create_index(
            "ix_ledger_events_ledger_sequence",
            "ledger_events",
            ["ledger_sequence"],
        )
        op.create_index(
            "ix_ledger_events_tx_hash",
            "ledger_events",
            ["tx_hash"],
        )
        op.create_index(
            "ix_ledger_events_event_type",
            "ledger_events",
            ["event_type"],
        )
        op.create_index(
            "ix_ledger_events_created_at",
            "ledger_events",
            ["created_at"],
        )

    # ------------------------------------------------------------------
    # Create initial monthly partitions (current + next month)
    # ------------------------------------------------------------------
    today = date.today()
    cur_name, cur_lower = _month_bounds(today.year, today.month)
    nxt_year, nxt_month = _next_month(today.year, today.month)
    nxt_name, nxt_lower = _month_bounds(nxt_year, nxt_month)
    # The current month's exclusive upper bound is the next month's lower bound.
    cur_upper = nxt_lower
    # The next month's exclusive upper bound is the month after that.
    nxt_year2, nxt_month2 = _next_month(nxt_year, nxt_month)
    _, nxt_upper = _month_bounds(nxt_year2, nxt_month2)

    _create_monthly_partition(
        "ledger_events", cur_name, cur_lower, cur_upper,
    )
    _create_monthly_partition(
        "ledger_events", nxt_name, nxt_lower, nxt_upper,
    )


# ---------------------------------------------------------------------------
# downgrade — drop all partitions and the parent table
# ---------------------------------------------------------------------------

def downgrade() -> None:
    """Drop all ``ledger_events`` child partitions and the parent table."""

    # Find and drop all child partition tables (PostgreSQL / SQLite)
    bind = op.get_bind()
    if bind is not None and getattr(bind, "dialect", None) is not None:
        try:
            if getattr(bind.dialect, "name", "") == "postgresql":
                result = bind.execute(sa.text("""
                    SELECT inhrelid::regclass::text
                    FROM pg_inherits
                    WHERE inhparent = 'ledger_events'::regclass
                """))
                partitions = [row[0] for row in result]
                for part in partitions:
                    op.execute(sa.text(f'DROP TABLE IF EXISTS "{part}"'))
            else:
                insp = sa.inspect(bind)
                for tbl in insp.get_table_names():
                    if tbl.startswith("ledger_events_"):
                        op.execute(sa.text(f'DROP TABLE IF EXISTS "{tbl}"'))
        except Exception:
            pass

    # Drop indexes on the parent (must happen before DROP TABLE)
    for idx in [
        "ix_ledger_events_created_at",
        "ix_ledger_events_event_type",
        "ix_ledger_events_tx_hash",
        "ix_ledger_events_ledger_sequence",
    ]:
        try:
            op.execute(sa.text(f'DROP INDEX IF EXISTS "{idx}"'))
        except Exception:
            pass

    if _table_exists("ledger_events"):
        op.drop_table("ledger_events")
