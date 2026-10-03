# Database Migration CI Testing

## Overview

This document describes the automated testing infrastructure for database schema migrations using Alembic in CI/CD pipelines. The implementation ensures migrations can run forward and backward cleanly without data loss or SQL constraint errors.

## Acceptance Criteria ✅

The migration CI testing system meets the following requirements:

1. ✅ **Run Alembic upgrade head followed by downgrade -1** on temporary test databases
2. ✅ **Verify zero data loss or unhandled SQL constraint errors** during migration cycles
3. ✅ **Assert migration test completes under 30 seconds** in GitHub Actions

## Implementation Components

### 1. Test Suite: `test_migration_ci_pipeline.py`

Located at: `tests/test_migration_ci_pipeline.py`

#### Key Test Classes

**`TestMigrationCIPipeline`**

Comprehensive test suite covering:

- ✅ **Upgrade Head Success**: Verifies `alembic upgrade head` completes without errors
- ✅ **Downgrade One Step**: Tests `alembic downgrade -1` executes cleanly
- ✅ **Data Integrity**: Ensures data persists correctly through migration cycles
- ✅ **Performance**: Validates total cycle time < 30 seconds
- ✅ **Constraint Validation**: Checks for SQL constraint errors
- ✅ **Idempotency**: Confirms safe multi-replica startup scenarios

#### Test Features

**Temporary Database Creation**
```python
@pytest.fixture(scope="module")
def postgres_test_engine() -> Generator[sa.engine.Engine, None, None]:
    """
    Create a temporary PostgreSQL database for migration testing.
    Unique database name prevents conflicts in parallel CI runs.
    """
```

**Migration Command Execution**
```python
def run_alembic_command(
    config_path: Path,
    command: str,
    database_url: str,
    timeout: int = 30
) -> tuple[int, str, str]:
    """
    Execute Alembic command with timeout and output capture.
    """
```

**Data Integrity Verification**
```python
def verify_data_integrity(
    engine: sa.engine.Engine,
    expected_counts: dict[str, int]
) -> tuple[bool, list[str]]:
    """
    Verify data persists correctly after migrations.
    """
```

### 2. GitHub Actions Workflow: `migration-tests.yml`

Located at: `.github/workflows/migration-tests.yml`

#### Jobs

**1. migration-ci-pipeline**
- Runs forward/backward migration cycle tests
- Validates basic migration functionality
- Timeout: 5 minutes

**2. migration-performance-benchmark**
- Measures migration execution time
- Enforces 30-second performance requirement
- Reports detailed timing breakdowns

**3. migration-data-integrity**
- Tests data preservation through migrations
- Validates SQL constraint handling
- Verifies idempotent behavior

**4. migration-summary**
- Aggregates results from all test jobs
- Provides clear pass/fail status

#### PostgreSQL Service Configuration

```yaml
services:
  postgres:
    image: postgres:16-alpine
    env:
      POSTGRES_USER: testuser
      POSTGRES_PASSWORD: testpass
      POSTGRES_DB: postgres
    ports:
      - 5432:5432
    options: >-
      --health-cmd pg_isready
      --health-interval 10s
      --health-timeout 5s
      --health-retries 5
```

### 3. Updated Dependencies

Added to `requirements.txt`:
```
alembic>=1.13.0
```

## Usage

### Running Tests Locally

**Run all migration CI tests:**
```bash
pytest tests/test_migration_ci_pipeline.py -v
```

**Run specific test:**
```bash
pytest tests/test_migration_ci_pipeline.py::TestMigrationCIPipeline::test_upgrade_head_completes_successfully -v
```

**Run performance benchmark:**
```bash
pytest tests/test_migration_ci_pipeline.py::test_ci_migration_benchmark -v -s
```

**Run with custom database URL:**
```bash
export DATABASE_URL="postgresql://user:pass@localhost:5432/test_db"
pytest tests/test_migration_ci_pipeline.py -v
```

### CI/CD Integration

The workflow automatically triggers on:

1. **Push to main branch**
2. **Pull requests to main**
3. **Changes to migration files** (alembic/**, app/models/**)

**Manual trigger:**
```bash
gh workflow run migration-tests.yml
```

## Test Scenarios

### 1. Forward Migration (Upgrade Head)

**What it tests:**
- Alembic successfully applies all pending migrations
- No SQL syntax errors
- No constraint violations
- alembic_version table updated correctly

**Expected outcome:**
- Exit code: 0
- Duration: < 15 seconds
- All tables created successfully

### 2. Backward Migration (Downgrade -1)

**What it tests:**
- Alembic successfully reverts last migration
- Schema changes rolled back cleanly
- No foreign key constraint errors
- Revision number decremented

**Expected outcome:**
- Exit code: 0
- Duration: < 10 seconds
- Tables dropped/modified correctly

### 3. Data Integrity Through Migrations

**What it tests:**
- Test data inserted into migrated tables
- Data persists after downgrade (where applicable)
- No data corruption or loss
- Proper handling of dropped tables

**Test data inserted:**
- Currency table: 2 rows (XLM, USDC)
- ledger_events: 2 rows (test events)
- payment_route: 2 rows (test routes)

**Expected outcome:**
- All data counts verified before downgrade
- Remaining data intact after downgrade
- No orphaned records

### 4. Performance Requirements

**What it tests:**
- Total time for upgrade + downgrade < 30 seconds
- Individual operation timings measured
- Detailed benchmark report generated

**Performance targets:**
- Upgrade head: < 15s
- Downgrade -1: < 10s
- Total cycle: < 30s

### 5. SQL Constraint Error Detection

**What it tests:**
- No IntegrityError during migrations
- No ForeignKeyViolation
- No CheckViolation
- No UniqueViolation
- No NotNullViolation

**Error detection method:**
- Scans stdout/stderr for error keywords
- Checks exit codes
- Validates clean execution

### 6. Idempotent Migrations

**What it tests:**
- Running `upgrade head` twice is safe
- No "already exists" errors
- Same revision after second upgrade
- Multi-replica startup safety

**Use case:**
- Multiple Kubernetes pods starting simultaneously
- Retry logic in deployment scripts
- Production rollback scenarios

## Architecture

### Test Flow Diagram

```
┌─────────────────────────────────────────────────┐
│ 1. Create Temporary PostgreSQL Database        │
│    (unique name: migration_test_<timestamp>)   │
└───────────────┬─────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────┐
│ 2. Run: alembic upgrade head                   │
│    - Execute all forward migrations            │
│    - Verify success (exit code 0)             │
│    - Check for SQL errors                     │
└───────────────┬─────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────┐
│ 3. Insert Test Data                            │
│    - Currency: XLM, USDC                       │
│    - ledger_events: test events               │
│    - payment_route: test routes               │
└───────────────┬─────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────┐
│ 4. Verify Data Integrity                       │
│    - Count rows in each table                  │
│    - Validate data exists                      │
└───────────────┬─────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────┐
│ 5. Run: alembic downgrade -1                   │
│    - Revert last migration                     │
│    - Verify success                            │
│    - Check for constraint errors              │
└───────────────┬─────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────┐
│ 6. Verify Data Integrity (Remaining Tables)    │
│    - Check data in tables that still exist     │
│    - Ensure no data corruption                 │
└───────────────┬─────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────┐
│ 7. Measure Total Duration                      │
│    - Assert < 30 seconds                       │
│    - Report performance metrics                │
└───────────────┬─────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────┐
│ 8. Cleanup: Drop Test Database                 │
│    - Terminate all connections                 │
│    - Drop database                             │
└─────────────────────────────────────────────────┘
```

## Error Handling

### Common Errors and Solutions

**1. Migration Timeout (> 30s)**

**Symptom:**
```
Command timed out after 30s
```

**Solutions:**
- Review migration for long-running operations
- Break large migrations into smaller steps
- Add indexes after bulk data operations
- Use concurrent index creation where possible

**2. IntegrityError During Downgrade**

**Symptom:**
```
IntegrityError: foreign key constraint violation
```

**Solutions:**
- Ensure proper foreign key cascade handling
- Drop dependent tables before parent tables
- Use `ondelete='CASCADE'` in FK definitions

**3. Data Loss After Downgrade**

**Symptom:**
```
Data loss in 'table_name': expected 10 rows, found 0
```

**Solutions:**
- Review downgrade logic for table drops
- Ensure data migration steps are reversible
- Add data preservation logic if needed

**4. Idempotency Failure**

**Symptom:**
```
Table 'xyz' already exists
```

**Solutions:**
- Use `IF NOT EXISTS` in CREATE statements
- Check for existing objects before creation
- Test upgrade head twice locally

## Best Practices

### Writing Migration-Safe Code

**✅ DO:**
- Use `IF NOT EXISTS` for table creation
- Add columns with defaults or allow NULL
- Create indexes concurrently in production
- Test both upgrade and downgrade paths
- Keep migrations small and focused
- Add rollback logic for data migrations

**❌ DON'T:**
- Add NOT NULL columns without defaults
- Create blocking locks on large tables
- Mix DDL and DML in single transaction
- Forget to test downgrade path
- Assume data exists in downgrade

### Performance Optimization

**Keep Migrations Fast:**
- Avoid full table scans
- Use batch operations for large datasets
- Create indexes after bulk inserts
- Use `CONCURRENTLY` for index creation (PostgreSQL)
- Minimize transaction duration

**Monitoring:**
```python
# Performance benchmark output
====================================================
CI MIGRATION PERFORMANCE BENCHMARK
====================================================
  upgrade_head                   :  12.34s
  downgrade_minus_1              :   8.76s
  upgrade_head_idempotent        :   2.10s
----------------------------------------------------
  TOTAL                          :  23.20s
====================================================
```

## Integration with Existing Governance

This CI testing complements existing migration governance from `test_alembic_migrations.py`:

1. **Advisory Lock Protocol** - Prevents concurrent migrations
2. **Non-Blocking Session Configuration** - Enforces timeouts
3. **Static AST Governance** - Validates migration code quality
4. **Schema Drift Detection** - Catches uncommitted changes
5. **Linear History Validation** - Ensures single migration path

## Troubleshooting

### Test Failures

**View detailed output:**
```bash
pytest tests/test_migration_ci_pipeline.py -v -s --tb=long
```

**Debug specific test:**
```bash
pytest tests/test_migration_ci_pipeline.py::TestMigrationCIPipeline::test_full_migration_cycle_with_data_integrity -vv -s
```

**Run with database inspection:**
```bash
# Keep test database after failure
pytest tests/test_migration_ci_pipeline.py --pdb
```

### CI/CD Debugging

**View GitHub Actions logs:**
1. Go to Actions tab in GitHub
2. Select "Database Migration Tests" workflow
3. Click on failed job
4. Expand relevant step for logs

**Re-run failed jobs:**
```bash
gh run rerun <run-id> --failed
```

## Maintenance

### Adding New Tests

1. Add test method to `TestMigrationCIPipeline` class
2. Use `postgres_test_engine` fixture
3. Follow naming convention: `test_<feature>_<expected_outcome>`
4. Add docstring with acceptance criteria
5. Update this documentation

### Updating Performance Thresholds

Current: 30 seconds total

To adjust:
```python
# In test_migration_ci_pipeline.py
PERFORMANCE_THRESHOLD_SECONDS = 30  # Adjust as needed
```

### Adding New Migration Validation

Create new test methods for:
- Custom constraint validation
- Data transformation verification
- Index creation validation
- Partition management

## References

- [Alembic Documentation](https://alembic.sqlalchemy.org/)
- [SQLAlchemy Documentation](https://docs.sqlalchemy.org/)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [PostgreSQL Migration Best Practices](https://www.postgresql.org/docs/current/)

## Related Issues

- Issue #774: Database Migration Governance & Rollback Test Suite
- Database Migration CI Testing (this implementation)

## Support

For questions or issues:
1. Review this documentation
2. Check test output for specific error messages
3. Review migration files in `alembic/versions/`
4. Consult `test_alembic_migrations.py` for governance rules
5. Open issue with detailed logs and reproduction steps
