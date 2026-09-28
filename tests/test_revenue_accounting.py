"""Tests for flash-loan revenue accounting and protocol yield analytics."""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.tasks import (
    _event_id,
    _parse_flash_loan_event,
    _safe_numeric,
    _snapshot_id,
)


# ---------------------------------------------------------------------------
# Deterministic ID helpers
# ---------------------------------------------------------------------------


def test_event_id_deterministic():
    assert _event_id("tx123", 0) == hashlib.sha256("tx123:0".encode()).hexdigest()
    assert _event_id("tx123", 1) == hashlib.sha256("tx123:1".encode()).hexdigest()


def test_snapshot_id_deterministic():
    ts = datetime(2026, 8, 27, 12, 0, 0, tzinfo=timezone.utc)
    assert _snapshot_id("DAILY", ts) == hashlib.sha256("DAILY:2026-08-27T12:00:00+00:00".encode()).hexdigest()


# ---------------------------------------------------------------------------
# Safe numeric coercion
# ---------------------------------------------------------------------------


def test_safe_numeric_int():
    assert _safe_numeric(100) == 100.0


def test_safe_numeric_float():
    assert _safe_numeric(3.14) == 3.14


def test_safe_numeric_string():
    assert _safe_numeric("42.5") == 42.5


def test_safe_numeric_none():
    assert _safe_numeric(None) is None


def test_safe_numeric_invalid():
    assert _safe_numeric("not-a-number") is None


# ---------------------------------------------------------------------------
# Flash-loan event parser
# ---------------------------------------------------------------------------


def test_parse_flash_loan_event_valid():
    payload = {
        "topic": "FlashLoanFeesDistributed",
        "txHash": "0xabcdef",
        "index": 0,
        "ledger": 12345,
        "amount": "5000000",
        "treasury": "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGH",
        "blockTime": "2026-08-27T12:00:00Z",
    }
    result = _parse_flash_loan_event(payload)
    assert result is not None
    assert result["id"] == _event_id("0xabcdef", 0)
    assert result["ledger_sequence"] == 12345
    assert result["tx_hash"] == "0xabcdef"
    assert result["event_index"] == 0
    assert result["amount"] == "5000000"
    assert result["treasury_account"] == "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGH"
    assert result["block_time"] == datetime(2026, 8, 27, 12, 0, 0, tzinfo=timezone.utc)


def test_parse_flash_loan_event_missing_amount():
    payload = {
        "topic": "FlashLoanFeesDistributed",
        "txHash": "0xabcdef",
        "index": 0,
        "treasury": "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGH",
    }
    assert _parse_flash_loan_event(payload) is None


def test_parse_flash_loan_event_missing_treasury():
    payload = {
        "topic": "FlashLoanFeesDistributed",
        "txHash": "0xabcdef",
        "index": 0,
        "amount": "1000",
    }
    assert _parse_flash_loan_event(payload) is None


def test_parse_flash_loan_event_wrong_topic():
    payload = {
        "topic": "SomeOtherEvent",
        "txHash": "0xabcdef",
        "index": 0,
    }
    assert _parse_flash_loan_event(payload) is None


def test_parse_flash_loan_event_type_field():
    payload = {
        "type": "FlashLoanFeesDistributed",
        "txHash": "0xabcdef",
        "index": 0,
        "amount": "1000",
        "treasury": "GABC",
    }
    result = _parse_flash_loan_event(payload)
    assert result is not None


def test_parse_flash_loan_event_block_time_int():
    payload = {
        "topic": "FlashLoanFeesDistributed",
        "txHash": "0xabcdef",
        "index": 0,
        "amount": "1000",
        "treasury": "GABC",
        "blockTime": 1724784000,
    }
    result = _parse_flash_loan_event(payload)
    assert result is not None
    assert result["block_time"] == datetime(2024, 8, 27, 12, 0, 0, tzinfo=timezone.utc)


def test_parse_flash_loan_event_block_time_invalid():
    payload = {
        "topic": "FlashLoanFeesDistributed",
        "txHash": "0xabcdef",
        "index": 0,
        "amount": "1000",
        "treasury": "GABC",
        "blockTime": "not-a-date",
    }
    result = _parse_flash_loan_event(payload)
    assert result is not None
    assert result["block_time"] is None


# ---------------------------------------------------------------------------
# Celery task wrappers (mock DB)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ingest_flash_loan_events_inserts_new_rows():
    from app.tasks import _ingest_flash_loan_events as tasks_ingest

    mock_conn = AsyncMock()
    mock_conn.fetch.return_value = [
        {
            "event_hash": "hash1",
            "ledger_sequence": 100,
            "tx_hash": "0xabc",
            "event_type": "contract",
            "payload": {
                "topic": "FlashLoanFeesDistributed",
                "txHash": "0xabc",
                "index": 0,
                "amount": "1000",
                "treasury": "GTREASURY",
                "blockTime": "2026-08-27T12:00:00Z",
            },
            "created_at": datetime.now(timezone.utc),
        }
    ]

    mock_pool = AsyncMock()
    mock_pool.acquire.return_value.__aenter__.return_value = mock_conn
    mock_pool.acquire.return_value.__aexit__.return_value = None
    mock_pool.close = AsyncMock()

    with patch("app.tasks.asyncpg.create_pool", return_value=mock_pool):
        inserted = tasks_ingest(lookback_minutes=60)
        assert inserted == 1
        assert mock_conn.execute.called


@pytest.mark.asyncio
async def test_compute_yield_snapshots_daily():
    from app.tasks import _compute_yield_snapshots as tasks_snapshots

    mock_conn = AsyncMock()
    mock_conn.fetch.return_value = [
        {
            "window_start": datetime(2026, 8, 27, 0, 0, 0, tzinfo=timezone.utc),
            "event_count": 5,
            "total_revenue": 5000,
            "fee_volume": 5000,
        }
    ]
    mock_conn.execute.return_value = "INSERT 0 1"

    mock_pool = AsyncMock()
    mock_pool.acquire.return_value.__aenter__.return_value = mock_conn
    mock_pool.acquire.return_value.__aexit__.return_value = None
    mock_pool.close = AsyncMock()

    with patch("app.tasks.asyncpg.create_pool", return_value=mock_pool):
        inserted = tasks_snapshots(granularity="DAILY")
        assert inserted == 1
        assert mock_conn.execute.called
