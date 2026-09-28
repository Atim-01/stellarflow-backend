"""alembic/governance.py — Re-exports app.db.governance for backward compatibility."""

from app.db.governance import *
from app.db.governance import (
    DEFAULT_LOCK_TIMEOUT_MS,
    DEFAULT_STATEMENT_TIMEOUT_MS,
    MigrationGovernanceError,
    UncommittedSchemaChangeError,
    assert_no_uncommitted_schema_changes,
    configure_non_blocking_session,
    detect_uncommitted_schema_changes,
    validate_all_migrations,
    validate_linear_history,
    validate_migration_script,
)
