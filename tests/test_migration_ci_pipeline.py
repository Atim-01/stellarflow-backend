"""tests/test_migration_ci_pipeline.py — CI Migration Forward/Backward Cleanliness Test.

Ensures database schema migrations can run forward and backward cleanly in CI
pipelines without data loss or unhandled SQL constraint errors.

Acceptance Criteria:
--------------------
1. Run Alembic `upgrade head` followed by `downgrade -1` on temporary test databases
2. Verify zero data loss or unhandled SQL constraint errors during migration cycles
3. Assert migration test completes under 30 seconds in GitHub Actions

Related: Database Migration Governance (#774)
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Generator

import pytest
import sqlalchemy as sa
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import DatabaseError, IntegrityError, OperationalError

# ---------------------------------------------------------------------------
# Path Setup
# ---------------------------------------------------------------------------

_ROOT = Path(__file__).resolve().parent.parent
_ALEMBIC_DIR = _ROOT / "alembic"
_ALEMBIC_INI = _ALEMBIC_DIR / "alembic.ini"

# ---------------------------------------------------------------------------
# Test Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def postgres_test_engine() -> Generator[sa.engine.Engine, None, None]:
    """
    Create a temporary PostgreSQL database for migration testing.
    
    Uses DATABASE_URL from environment or fallback to localhost.
    Creates a unique test database to avoid conflicts.
    """
    base_url = os.getenv(
        "DATABASE_URL", 
        "postgresql://user:pass@localhost:5432/postgres"
    )
    
    # Extract connection parameters
    base_engine = create_engine(base_url, isolation_level="AUTOCOMMIT")
    
    # Generate unique test database name
    test_db_name = f"migration_test_{int(time.time())}"
    
    try:
        # Create test database
        with base_engine.connect() as conn:
            conn.execute(text(f"CREATE DATABASE {test_db_name}"))
        
        # Create engine for test database
        test_url = base_url.rsplit("/", 1)[0] + f"/{test_db_name}"
        test_engine = create_engine(test_url)
        
        yield test_engine
        
        # Cleanup
        test_engine.dispose()
        
        # Drop test database
        with base_engine.connect() as conn:
            # Terminate all connections to the test database
            conn.execute(text(f"""
                SELECT pg_terminate_backend(pg_stat_activity.pid)
                FROM pg_stat_activity
                WHERE pg_stat_activity.datname = '{test_db_name}'
                AND pid <> pg_backend_pid()
            """))
            conn.execute(text(f"DROP DATABASE IF EXISTS {test_db_name}"))
    finally:
        base_engine.dispose()


@pytest.fixture
def alembic_config() -> Path:
    """Return path to alembic.ini configuration file."""
    assert _ALEMBIC_INI.exists(), f"Alembic config not found: {_ALEMBIC_INI}"
    return _ALEMBIC_INI


# ---------------------------------------------------------------------------
# Helper Functions
# ---------------------------------------------------------------------------


def run_alembic_command(
    config_path: Path,
    command: str,
    database_url: str,
    timeout: int = 30
) -> tuple[int, str, str]:
    """
    Execute an Alembic command and return exit code, stdout, stderr.
    
    Args:
        config_path: Path to alembic.ini
        command: Alembic command (e.g., "upgrade head", "downgrade -1")
        database_url: PostgreSQL connection string
        timeout: Maximum seconds to wait for command completion
        
    Returns:
        Tuple of (exit_code, stdout, stderr)
    """
    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    
    cmd = [
        sys.executable, "-m", "alembic",
        "-c", str(config_path),
        *command.split()
    ]
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
            cwd=str(_ROOT)
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired as e:
        return -1, "", f"Command timed out after {timeout}s"


def get_current_revision(engine: sa.engine.Engine) -> str | None:
    """Get the current Alembic revision from the database."""
    try:
        with engine.connect() as conn:
            result = conn.execute(
                text("SELECT version_num FROM alembic_version")
            )
            row = result.fetchone()
            return row[0] if row else None
    except OperationalError:
        # Table doesn't exist yet
        return None


def get_table_names(engine: sa.engine.Engine) -> list[str]:
    """Return list of table names in the database."""
    with engine.connect() as conn:
        inspector = inspect(conn)
        return inspector.get_table_names()


def get_table_row_count(engine: sa.engine.Engine, table_name: str) -> int:
    """Get the number of rows in a table."""
    with engine.connect() as conn:
        result = conn.execute(text(f"SELECT COUNT(*) FROM {table_name}"))
        return result.scalar()


def insert_test_data(engine: sa.engine.Engine) -> dict[str, int]:
    """
    Insert test data into migrated tables to verify data preservation.
    
    Returns:
        Dictionary mapping table names to row counts inserted
    """
    inserted_counts = {}
    
    with engine.connect() as conn:
        # Check which tables exist and insert appropriate test data
        tables = get_table_names(engine)
        
        # Insert test data into Currency table if it exists
        if "Currency" in tables:
            conn.execute(text("""
                INSERT INTO "Currency" (symbol, name, type, issuer, decimals)
                VALUES 
                    ('XLM', 'Stellar Lumens', 'native', '', 7),
                    ('USDC', 'USD Coin', 'credit_alphanum4', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 7)
                ON CONFLICT (symbol, issuer) DO NOTHING
            """))
            conn.commit()
            inserted_counts["Currency"] = 2
        
        # Insert test data into ledger_events if it exists
        if "ledger_events" in tables:
            conn.execute(text("""
                INSERT INTO ledger_events (event_hash, created_at, event_type, payload)
                VALUES 
                    ('test_hash_001', NOW(), 'payment', '{"amount": "100.00"}'::jsonb),
                    ('test_hash_002', NOW(), 'trade', '{"price": "0.50"}'::jsonb)
                ON CONFLICT (event_hash, created_at) DO NOTHING
            """))
            conn.commit()
            inserted_counts["ledger_events"] = 2
            
        # Insert test data into payment_route if it exists
        if "payment_route" in tables:
            conn.execute(text("""
                INSERT INTO payment_route (route_id, source_asset, dest_asset, path_assets, estimated_cost)
                VALUES 
                    ('route_001', 'XLM', 'USDC', ARRAY[]::TEXT[], 0.01),
                    ('route_002', 'USDC', 'XLM', ARRAY[]::TEXT[], 0.01)
                ON CONFLICT (route_id) DO NOTHING
            """))
            conn.commit()
            inserted_counts["payment_route"] = 2
    
    return inserted_counts


def verify_data_integrity(
    engine: sa.engine.Engine,
    expected_counts: dict[str, int]
) -> tuple[bool, list[str]]:
    """
    Verify that data persists correctly after migrations.
    
    Args:
        engine: SQLAlchemy engine
        expected_counts: Dictionary of table names to expected row counts
        
    Returns:
        Tuple of (success: bool, errors: list[str])
    """
    errors = []
    
    for table_name, expected_count in expected_counts.items():
        try:
            tables = get_table_names(engine)
            if table_name not in tables:
                errors.append(f"Table '{table_name}' missing after migration")
                continue
                
            actual_count = get_table_row_count(engine, table_name)
            if actual_count != expected_count:
                errors.append(
                    f"Data loss in '{table_name}': expected {expected_count} rows, "
                    f"found {actual_count}"
                )
        except Exception as e:
            errors.append(f"Error verifying '{table_name}': {str(e)}")
    
    return len(errors) == 0, errors


# ---------------------------------------------------------------------------
# Test Cases
# ---------------------------------------------------------------------------


class TestMigrationCIPipeline:
    """
    Test suite for CI migration forward/backward cleanliness.
    """
    
    def test_upgrade_head_completes_successfully(
        self,
        postgres_test_engine: sa.engine.Engine,
        alembic_config: Path
    ) -> None:
        """
        Test that 'alembic upgrade head' completes without errors.
        
        Acceptance Criteria:
        - Command exits with code 0
        - No SQL errors in output
        - alembic_version table created
        """
        database_url = str(postgres_test_engine.url)
        
        start_time = time.time()
        exit_code, stdout, stderr = run_alembic_command(
            alembic_config,
            "upgrade head",
            database_url,
            timeout=30
        )
        duration = time.time() - start_time
        
        # Verify command succeeded
        assert exit_code == 0, (
            f"Alembic upgrade failed with exit code {exit_code}\n"
            f"STDOUT: {stdout}\n"
            f"STDERR: {stderr}"
        )
        
        # Verify no SQL errors
        error_keywords = [
            "ERROR", "FAILED", "IntegrityError", "OperationalError",
            "ProgrammingError", "DataError"
        ]
        combined_output = stdout + stderr
        for keyword in error_keywords:
            assert keyword not in combined_output, (
                f"Found error keyword '{keyword}' in output:\n{combined_output}"
            )
        
        # Verify alembic_version table exists
        tables = get_table_names(postgres_test_engine)
        assert "alembic_version" in tables, "alembic_version table not created"
        
        # Verify current revision is set
        revision = get_current_revision(postgres_test_engine)
        assert revision is not None, "No revision recorded in alembic_version"
        
        print(f"✓ Upgrade to head completed in {duration:.2f}s")
    
    def test_downgrade_one_step_completes_successfully(
        self,
        postgres_test_engine: sa.engine.Engine,
        alembic_config: Path
    ) -> None:
        """
        Test that 'alembic downgrade -1' completes without errors.
        
        Acceptance Criteria:
        - Command exits with code 0
        - No SQL errors in output
        - Revision number decremented correctly
        """
        database_url = str(postgres_test_engine.url)
        
        # First upgrade to head
        run_alembic_command(alembic_config, "upgrade head", database_url)
        revision_before = get_current_revision(postgres_test_engine)
        
        # Then downgrade one step
        start_time = time.time()
        exit_code, stdout, stderr = run_alembic_command(
            alembic_config,
            "downgrade -1",
            database_url,
            timeout=30
        )
        duration = time.time() - start_time
        
        # Verify command succeeded
        assert exit_code == 0, (
            f"Alembic downgrade failed with exit code {exit_code}\n"
            f"STDOUT: {stdout}\n"
            f"STDERR: {stderr}"
        )
        
        # Verify no SQL errors
        error_keywords = [
            "ERROR", "FAILED", "IntegrityError", "OperationalError"
        ]
        combined_output = stdout + stderr
        for keyword in error_keywords:
            assert keyword not in combined_output, (
                f"Found error keyword '{keyword}' in output:\n{combined_output}"
            )
        
        # Verify revision changed
        revision_after = get_current_revision(postgres_test_engine)
        assert revision_after != revision_before, (
            "Revision unchanged after downgrade"
        )
        
        print(f"✓ Downgrade -1 completed in {duration:.2f}s")
    
    def test_full_migration_cycle_with_data_integrity(
        self,
        postgres_test_engine: sa.engine.Engine,
        alembic_config: Path
    ) -> None:
        """
        Test full migration cycle: upgrade → insert data → downgrade → verify no data loss.
        
        Acceptance Criteria:
        - Data persists correctly through upgrade
        - Data is properly handled during downgrade
        - No constraint violations or data corruption
        """
        database_url = str(postgres_test_engine.url)
        
        # 1. Upgrade to head
        exit_code, _, _ = run_alembic_command(
            alembic_config,
            "upgrade head",
            database_url
        )
        assert exit_code == 0, "Initial upgrade failed"
        
        # 2. Insert test data
        inserted_counts = insert_test_data(postgres_test_engine)
        assert len(inserted_counts) > 0, "No test data inserted"
        
        # 3. Verify data exists
        success, errors = verify_data_integrity(
            postgres_test_engine,
            inserted_counts
        )
        assert success, f"Data integrity check failed: {errors}"
        
        # 4. Downgrade one step
        exit_code, _, _ = run_alembic_command(
            alembic_config,
            "downgrade -1",
            database_url
        )
        assert exit_code == 0, "Downgrade failed"
        
        # 5. Verify data still exists in remaining tables
        tables_after_downgrade = get_table_names(postgres_test_engine)
        remaining_data = {
            table: count
            for table, count in inserted_counts.items()
            if table in tables_after_downgrade
        }
        
        if remaining_data:
            success, errors = verify_data_integrity(
                postgres_test_engine,
                remaining_data
            )
            assert success, f"Data loss detected after downgrade: {errors}"
        
        print("✓ Full migration cycle completed with data integrity preserved")
    
    def test_migration_performance_under_30_seconds(
        self,
        postgres_test_engine: sa.engine.Engine,
        alembic_config: Path
    ) -> None:
        """
        Test that full upgrade + downgrade cycle completes under 30 seconds.
        
        Acceptance Criteria:
        - Total time for upgrade head + downgrade -1 < 30 seconds
        - Meets GitHub Actions CI performance requirements
        """
        database_url = str(postgres_test_engine.url)
        
        start_time = time.time()
        
        # Upgrade to head
        exit_code_up, _, _ = run_alembic_command(
            alembic_config,
            "upgrade head",
            database_url,
            timeout=30
        )
        assert exit_code_up == 0, "Upgrade failed"
        
        # Downgrade one step
        exit_code_down, _, _ = run_alembic_command(
            alembic_config,
            "downgrade -1",
            database_url,
            timeout=30
        )
        assert exit_code_down == 0, "Downgrade failed"
        
        total_duration = time.time() - start_time
        
        assert total_duration < 30.0, (
            f"Migration cycle took {total_duration:.2f}s, "
            f"exceeds 30s limit for GitHub Actions CI"
        )
        
        print(f"✓ Migration cycle completed in {total_duration:.2f}s (< 30s requirement)")
    
    def test_no_sql_constraint_errors_during_migrations(
        self,
        postgres_test_engine: sa.engine.Engine,
        alembic_config: Path
    ) -> None:
        """
        Test that no SQL constraint errors occur during migration cycles.
        
        Acceptance Criteria:
        - No IntegrityError, ForeignKeyViolation, CheckViolation
        - No "constraint" errors in output
        - Clean migration execution
        """
        database_url = str(postgres_test_engine.url)
        
        # Upgrade to head
        exit_code_up, stdout_up, stderr_up = run_alembic_command(
            alembic_config,
            "upgrade head",
            database_url
        )
        
        # Check for constraint-related errors
        constraint_keywords = [
            "constraint", "IntegrityError", "ForeignKeyViolation",
            "CheckViolation", "UniqueViolation", "NotNullViolation"
        ]
        
        output_up = (stdout_up + stderr_up).lower()
        for keyword in constraint_keywords:
            assert keyword.lower() not in output_up, (
                f"Found constraint error '{keyword}' during upgrade:\n"
                f"{stdout_up}\n{stderr_up}"
            )
        
        # Downgrade one step
        exit_code_down, stdout_down, stderr_down = run_alembic_command(
            alembic_config,
            "downgrade -1",
            database_url
        )
        
        output_down = (stdout_down + stderr_down).lower()
        for keyword in constraint_keywords:
            assert keyword.lower() not in output_down, (
                f"Found constraint error '{keyword}' during downgrade:\n"
                f"{stdout_down}\n{stderr_down}"
            )
        
        assert exit_code_up == 0 and exit_code_down == 0, "Migration commands failed"
        
        print("✓ No SQL constraint errors detected during migration cycle")
    
    def test_idempotent_upgrade_head(
        self,
        postgres_test_engine: sa.engine.Engine,
        alembic_config: Path
    ) -> None:
        """
        Test that running 'upgrade head' twice is idempotent (no errors).
        
        Acceptance Criteria:
        - Second upgrade head completes successfully
        - No "already exists" or duplicate errors
        - Safe for multiple replica startup scenarios
        """
        database_url = str(postgres_test_engine.url)
        
        # First upgrade
        exit_code_1, _, _ = run_alembic_command(
            alembic_config,
            "upgrade head",
            database_url
        )
        assert exit_code_1 == 0, "First upgrade failed"
        
        revision_1 = get_current_revision(postgres_test_engine)
        
        # Second upgrade (should be no-op)
        exit_code_2, stdout_2, stderr_2 = run_alembic_command(
            alembic_config,
            "upgrade head",
            database_url
        )
        assert exit_code_2 == 0, (
            f"Second upgrade failed:\nSTDOUT: {stdout_2}\nSTDERR: {stderr_2}"
        )
        
        revision_2 = get_current_revision(postgres_test_engine)
        assert revision_1 == revision_2, "Revision changed on idempotent upgrade"
        
        print("✓ Idempotent upgrade head verified")


# ---------------------------------------------------------------------------
# CI Performance Benchmark
# ---------------------------------------------------------------------------


def test_ci_migration_benchmark(
    postgres_test_engine: sa.engine.Engine,
    alembic_config: Path
) -> None:
    """
    Benchmark test to ensure migrations meet CI performance requirements.
    
    This test measures and reports detailed timing for CI optimization.
    """
    database_url = str(postgres_test_engine.url)
    
    timings = {}
    
    # Measure upgrade head
    start = time.time()
    exit_code, _, _ = run_alembic_command(
        alembic_config,
        "upgrade head",
        database_url,
        timeout=30
    )
    timings["upgrade_head"] = time.time() - start
    assert exit_code == 0, "Upgrade failed"
    
    # Measure downgrade -1
    start = time.time()
    exit_code, _, _ = run_alembic_command(
        alembic_config,
        "downgrade -1",
        database_url,
        timeout=30
    )
    timings["downgrade_minus_1"] = time.time() - start
    assert exit_code == 0, "Downgrade failed"
    
    # Measure upgrade head again (idempotent)
    start = time.time()
    exit_code, _, _ = run_alembic_command(
        alembic_config,
        "upgrade head",
        database_url,
        timeout=30
    )
    timings["upgrade_head_idempotent"] = time.time() - start
    assert exit_code == 0, "Idempotent upgrade failed"
    
    # Report timings
    total_time = sum(timings.values())
    
    print("\n" + "="*60)
    print("CI MIGRATION PERFORMANCE BENCHMARK")
    print("="*60)
    for operation, duration in timings.items():
        print(f"  {operation:30s}: {duration:6.2f}s")
    print("-"*60)
    print(f"  {'TOTAL':30s}: {total_time:6.2f}s")
    print("="*60)
    
    assert total_time < 30.0, (
        f"Total migration cycle time {total_time:.2f}s exceeds 30s CI requirement"
    )
    
    print("\n✓ All CI performance benchmarks passed")
