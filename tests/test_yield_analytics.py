"""Tests for protocol yield analytics endpoints and models."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.revenue import FlashLoanRevenue, ProtocolYieldSnapshot


# ---------------------------------------------------------------------------
# Model instantiation
# ---------------------------------------------------------------------------


def test_flash_loan_revenue_instantiation():
    event = FlashLoanRevenue(
        id="abc123",
        ledger_sequence=100,
        tx_hash="0xabc",
        event_index=0,
        amount=1000,
        treasury_account="GTREASURY",
        block_time=datetime(2026, 8, 27, 12, 0, 0, tzinfo=timezone.utc),
        payload={"topic": "FlashLoanFeesDistributed"},
    )
    assert event.id == "abc123"
    assert event.amount == 1000
    assert event.treasury_account == "GTREASURY"


def test_protocol_yield_snapshot_instantiation():
    snapshot = ProtocolYieldSnapshot(
        id="snap123",
        granularity="DAILY",
        window_start=datetime(2026, 8, 27, 0, 0, 0, tzinfo=timezone.utc),
        window_end=datetime(2026, 8, 28, 0, 0, 0, tzinfo=timezone.utc),
        total_flash_loan_revenue=5000,
        fee_volume=5000,
        event_count=5,
    )
    assert snapshot.granularity == "DAILY"
    assert snapshot.total_flash_loan_revenue == 5000
    assert snapshot.event_count == 5


# ---------------------------------------------------------------------------
# Router endpoint tests (mock DB)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_flash_loan_revenue_endpoint():
    from app.routers import revenue as revenue_router

    mock_conn = AsyncMock()
    mock_conn.fetch.return_value = [
        {
            "id": "ev1",
            "ledger_sequence": 100,
            "tx_hash": "0xabc",
            "event_index": 0,
            "amount": 1000,
            "treasury_account": "GTREASURY",
            "block_time": datetime(2026, 8, 27, 12, 0, 0, tzinfo=timezone.utc),
            "created_at": datetime(2026, 8, 27, 12, 0, 0, tzinfo=timezone.utc),
        }
    ]

    mock_pool = AsyncMock()
    mock_pool.acquire.return_value.__aenter__.return_value = mock_conn
    mock_pool.acquire.return_value.__aexit__.return_value = None
    mock_pool.close = AsyncMock()

    with patch.dict(os.environ, {"DATABASE_URL": "postgresql://localhost/db"}):
        with patch("app.routers.revenue.asyncpg.create_pool", return_value=mock_pool):
            results = await revenue_router.get_flash_loan_revenue()
            assert len(results) == 1
            assert results[0].id == "ev1"
            assert results[0].amount == 1000.0


@pytest.mark.asyncio
async def test_get_yield_snapshots_endpoint():
    from app.routers import revenue as revenue_router

    mock_conn = AsyncMock()
    mock_conn.fetch.return_value = [
        {
            "id": "snap1",
            "granularity": "DAILY",
            "window_start": datetime(2026, 8, 27, 0, 0, 0, tzinfo=timezone.utc),
            "window_end": datetime(2026, 8, 28, 0, 0, 0, tzinfo=timezone.utc),
            "total_flash_loan_revenue": 5000,
            "total_treasury_balance": None,
            "yield_apy": None,
            "fee_volume": 5000,
            "event_count": 5,
            "created_at": datetime(2026, 8, 27, 12, 0, 0, tzinfo=timezone.utc),
        }
    ]

    mock_pool = AsyncMock()
    mock_pool.acquire.return_value.__aenter__.return_value = mock_conn
    mock_pool.acquire.return_value.__aexit__.return_value = None
    mock_pool.close = AsyncMock()

    with patch.dict(os.environ, {"DATABASE_URL": "postgresql://localhost/db"}):
        with patch("app.routers.revenue.asyncpg.create_pool", return_value=mock_pool):
            results = await revenue_router.get_yield_snapshots()
            assert len(results) == 1
            assert results[0].granularity == "DAILY"
            assert results[0].total_flash_loan_revenue == 5000.0


@pytest.mark.asyncio
async def test_get_cumulative_revenue_endpoint():
    from app.routers import revenue as revenue_router

    mock_conn = AsyncMock()
    mock_conn.fetchrow.return_value = {
        "total_revenue": 15000,
        "total_events": 30,
        "treasury_accounts": ["GTREASURY1", "GTREASURY2"],
        "first_event_at": datetime(2026, 8, 1, 0, 0, 0, tzinfo=timezone.utc),
        "last_event_at": datetime(2026, 8, 27, 12, 0, 0, tzinfo=timezone.utc),
    }

    mock_pool = AsyncMock()
    mock_pool.acquire.return_value.__aenter__.return_value = mock_conn
    mock_pool.acquire.return_value.__aexit__.return_value = None
    mock_pool.close = AsyncMock()

    with patch.dict(os.environ, {"DATABASE_URL": "postgresql://localhost/db"}):
        with patch("app.routers.revenue.asyncpg.create_pool", return_value=mock_pool):
            result = await revenue_router.get_cumulative_flash_loan_revenue()
            assert result.total_revenue == 15000.0
            assert result.total_events == 30
            assert len(result.treasury_accounts) == 2


@pytest.mark.asyncio
async def test_trigger_ingest_endpoint():
    from app.routers import revenue as revenue_router

    mock_result = MagicMock()
    mock_result.id = "task-123"

    with patch("app.routers.revenue.ingest_flash_loan_revenue.delay", return_value=mock_result):
        result = await revenue_router.trigger_ingest_flash_loan_revenue()
        assert result.success is True
        assert result.task_id == "task-123"


@pytest.mark.asyncio
async def test_trigger_yield_compute_endpoint():
    from app.routers import revenue as revenue_router

    mock_result = MagicMock()
    mock_result.id = "task-456"

    with patch("app.routers.revenue.compute_yield_snapshots.delay", return_value=mock_result):
        result = await revenue_router.trigger_compute_yield_snapshots(granularity="HOURLY")
        assert result.success is True
        assert result.task_id == "task-456"
