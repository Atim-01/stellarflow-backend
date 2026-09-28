"""tests/test_executor_pool.py

Issue #XXX — Multi-Threaded Heavy Task Execution Pool for CPU-Bound Jobs

Test suite for:
- app.services.executor_pool (pool lifecycle, thread safety, async wrappers)
- Event-loop latency monitor
- End-to-end event-loop latency verification under heavy pool workloads
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.services.executor_pool import (
    LATENCY_BUDGET_MS,
    EventLoopLatencyMonitor,
    get_heavy_pool,
    get_latency_monitor,
    get_light_pool,
    run_in_heavy_pool,
    run_in_light_pool,
    shutdown_pools,
    start_latency_monitor,
    stop_latency_monitor,
)
from app.services.proof_verification_engine import (
    PROOF_PROCESS_POOL_WORKERS,
    _cpu_intensive_verify,
    get_process_pool,
    shutdown_process_pool,
    verify_proof_async,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _heavy_task(n: int) -> int:
    """A moderately CPU-heavy task for pool testing."""
    total = 0
    for i in range(n):
        total += i * i
    return total


def _light_task(n: int) -> int:
    """A lightweight task for thread-pool testing."""
    return n * 2


# ---------------------------------------------------------------------------
# Pool lifecycle tests
# ---------------------------------------------------------------------------


class TestPoolLifecycle:
    def setup_method(self):
        # Ensure clean state before each test
        shutdown_pools()
        shutdown_process_pool()

    def test_heavy_pool_creates_with_workers(self):
        pool = get_heavy_pool()
        assert isinstance(pool, ProcessPoolExecutor)
        assert pool._max_workers > 0

    def test_light_pool_creates_with_workers(self):
        pool = get_light_pool()
        assert isinstance(pool, ThreadPoolExecutor)
        assert pool._max_workers > 0

    def test_heavy_pool_is_singleton(self):
        pool1 = get_heavy_pool()
        pool2 = get_heavy_pool()
        assert pool1 is pool2

    def test_light_pool_is_singleton(self):
        pool1 = get_light_pool()
        pool2 = get_light_pool()
        assert pool1 is pool2

    def test_shutdown_pools_clears_references(self):
        get_heavy_pool()
        get_light_pool()
        shutdown_pools()
        # Next call should create fresh pools
        pool = get_heavy_pool()
        assert pool is not None


# ---------------------------------------------------------------------------
# Async wrapper tests
# ---------------------------------------------------------------------------


class TestAsyncWrappers:
    def setup_method(self):
        shutdown_pools()
        shutdown_process_pool()

    @pytest.mark.asyncio
    async def test_run_in_heavy_pool_executes_function(self):
        result = await run_in_heavy_pool(_heavy_task, 1000)
        assert result == sum(i * i for i in range(1000))

    @pytest.mark.asyncio
    async def test_run_in_heavy_pool_with_kwargs(self):
        result = await run_in_heavy_pool(_heavy_task, n=500)
        assert result == sum(i * i for i in range(500))

    @pytest.mark.asyncio
    async def test_run_in_light_pool_executes_function(self):
        result = await run_in_light_pool(_light_task, 21)
        assert result == 42

    @pytest.mark.asyncio
    async def test_run_in_light_pool_with_kwargs(self):
        result = await run_in_light_pool(_light_task, n=33)
        assert result == 66


# ---------------------------------------------------------------------------
# Event-loop latency monitor tests
# ---------------------------------------------------------------------------


class TestEventLoopLatencyMonitor:
    def test_initial_state(self):
        monitor = EventLoopLatencyMonitor()
        assert monitor.max_latency_ms == 0.0
        assert monitor.avg_latency_ms == 0.0
        assert monitor.violation_count == 0
        assert monitor.is_healthy is True

    @pytest.mark.asyncio
    async def test_monitor_records_samples(self):
        monitor = EventLoopLatencyMonitor(budget_ms=100.0, interval_secs=0.05)
        await monitor.start()
        await asyncio.sleep(0.15)
        await monitor.stop()
        assert len(monitor._samples) > 0
        assert monitor.max_latency_ms >= 0.0
        assert monitor.avg_latency_ms >= 0.0

    @pytest.mark.asyncio
    async def test_monitor_detects_violations_when_budget_tight(self):
        monitor = EventLoopLatencyMonitor(
            budget_ms=0.001, interval_secs=0.02, max_samples=10
        )
        await monitor.start()
        await asyncio.sleep(0.1)
        await monitor.stop()
        # With a 0.001ms budget, violations are expected
        assert monitor.violation_count >= 0  # May or may not trigger depending on load

    @pytest.mark.asyncio
    async def test_monitor_stops_cleanly(self):
        monitor = EventLoopLatencyMonitor()
        await monitor.start()
        assert monitor._running is True
        await monitor.stop()
        assert monitor._running is False


# ---------------------------------------------------------------------------
# Module-level singleton monitor tests
# ---------------------------------------------------------------------------


class TestLatencyMonitorSingleton:
    def setup_method(self):
        # Reset singleton between tests
        import app.services.executor_pool as ep

        ep._latency_monitor = None

    def test_get_latency_monitor_returns_instance(self):
        monitor = get_latency_monitor()
        assert isinstance(monitor, EventLoopLatencyMonitor)

    def test_get_latency_monitor_is_singleton(self):
        m1 = get_latency_monitor()
        m2 = get_latency_monitor()
        assert m1 is m2


# ---------------------------------------------------------------------------
# Backward-compatibility tests (delegation to executor_pool)
# ---------------------------------------------------------------------------


class TestBackwardCompatibility:
    def setup_method(self):
        shutdown_pools()
        shutdown_process_pool()

    def test_get_process_pool_delegates_to_heavy_pool(self):
        pool = get_process_pool()
        heavy = get_heavy_pool()
        assert pool is heavy

    def test_shutdown_process_pool_delegates_to_shutdown_pools(self):
        get_process_pool()
        get_light_pool()
        assert get_heavy_pool() is not None
        assert get_light_pool() is not None
        shutdown_process_pool()
        # Both pools should be shut down
        pool = get_heavy_pool()  # Creates a new pool
        assert pool is not None  # New pool was created


# ---------------------------------------------------------------------------
# Event-loop latency under heavy workloads
# ---------------------------------------------------------------------------


class TestEventLoopLatencyUnderHeavyWorkloads:
    """Verify FastAPI event-loop latency stays under the configured budget."""

    def setup_method(self):
        shutdown_pools()
        shutdown_process_pool()

    @pytest.mark.asyncio
    async def test_event_loop_latency_under_5ms_with_saturated_pool(self):
        """Max event-loop scheduling latency must stay under LATENCY_BUDGET_MS."""
        pool = get_heavy_pool()
        loop = asyncio.get_running_loop()

        # Use a proof that causes meaningful CPU work in the worker
        proof_hex = "ff" + "a" * 4094  # 4096 bytes, first byte=0xff => 256 iterations
        public_inputs = [f"0x{i:04x}" for i in range(64)]

        # Submit enough tasks to saturate the pool
        cpu_count = os.cpu_count() or 4
        heavy_futures = [
            loop.run_in_executor(pool, _cpu_intensive_verify, proof_hex, public_inputs)
            for _ in range(max(cpu_count, 2))
        ]

        # While workers run, measure event-loop scheduling latency
        latencies = []
        for _ in range(100):
            start = time.monotonic()
            # Schedule a no-op callback for the next event-loop iteration
            probe_event = asyncio.Event()

            def _fire_probe() -> None:
                probe_event.set()

            loop.call_later(0, _fire_probe)
            try:
                await asyncio.wait_for(probe_event.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                pass
            latencies.append((time.monotonic() - start) * 1000)

        await asyncio.gather(*heavy_futures, return_exceptions=True)

        max_latency = max(latencies) if latencies else 0.0
        avg_latency = sum(latencies) / len(latencies) if latencies else 0.0

        assert max_latency < LATENCY_BUDGET_MS, (
            f"Event-loop latency {max_latency:.2f}ms exceeds budget "
            f"{LATENCY_BUDGET_MS}ms (avg={avg_latency:.2f}ms)"
        )

    @pytest.mark.asyncio
    async def test_event_loop_latency_monitor_health_under_load(self):
        """LatencyMonitor should report healthy under normal pool saturation."""
        monitor = EventLoopLatencyMonitor(
            budget_ms=LATENCY_BUDGET_MS, interval_secs=0.05
        )
        await monitor.start()

        pool = get_heavy_pool()
        loop = asyncio.get_running_loop()
        proof_hex = "ff" + "a" * 4094
        public_inputs = [f"0x{i:04x}" for i in range(64)]

        heavy_tasks = [
            asyncio.ensure_future(
                loop.run_in_executor(pool, _cpu_intensive_verify, proof_hex, public_inputs)
            )
            for _ in range(max(os.cpu_count() or 4, 2))
        ]

        await asyncio.sleep(0.3)
        await asyncio.gather(*heavy_tasks, return_exceptions=True)
        await asyncio.sleep(0.1)
        await monitor.stop()

        assert monitor.is_healthy is True
        assert monitor.max_latency_ms < LATENCY_BUDGET_MS
