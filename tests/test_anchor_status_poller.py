import pytest

from app.services.anchor_status_poller import (
    COMPLETED,
    PENDING_EXTERNAL,
    AnchorStatusPoller,
    extract_status,
    is_completed_status,
)


def test_extracts_nested_sep24_status():
    assert extract_status({"transaction": {"status": "COMPLETED"}}) == "completed"


def test_extracts_sep31_top_level_status():
    assert extract_status({"status": "settled"}) == "settled"
    assert is_completed_status("settled")
    assert not is_completed_status("pending")


@pytest.mark.asyncio
async def test_mark_completed_is_idempotent():
    calls = []

    class Connection:
        async def execute(self, query, completed, transaction_id, pending):
            calls.append((completed, transaction_id, pending))
            return "UPDATE 1"

    changed = await AnchorStatusPoller().mark_completed(Connection(), "tx-1")
    assert changed
    assert calls == [(COMPLETED, "tx-1", PENDING_EXTERNAL)]
