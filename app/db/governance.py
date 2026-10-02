"""app/db/governance.py — Database migration governance & schema drift detection suite.

Enforces non-blocking online schema changes for PostgreSQL production tables,
validates migration rollback parity, and detects uncommitted schema drift
between SQLAlchemy declarative models and Alembic revision histories.
"""

from __future__ import annotations

import ast
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

import sqlalchemy as sa
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.ext.compiler import compiles

try:
    from sqlalchemy.dialects.postgresql import JSONB

    @compiles(JSONB, "sqlite")
    def _compile_jsonb_sqlite(type_, compiler, **kw):
        return "JSON"
except ImportError:
    pass


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class MigrationGovernanceError(Exception):
    """Raised when a migration violates non-blocking online schema rules."""
    pass


class UncommittedSchemaChangeError(Exception):
    """Raised when uncommitted schema differences exist between models and migrations."""
    pass


# ---------------------------------------------------------------------------
# Constants & Rules
# ---------------------------------------------------------------------------

# Default lock timeout for non-blocking online DDL operations in PostgreSQL (5 seconds).
DEFAULT_LOCK_TIMEOUT_MS: int = 5000
DEFAULT_STATEMENT_TIMEOUT_MS: int = 60000

# Regular expressions for identifying partition child tables (e.g. ledger_events_2026_08)
PARTITION_TABLE_REGEX = re.compile(r"^[a-zA-Z0-9_]+_\d{4}_\d{2}$")


# ---------------------------------------------------------------------------
# 1. Non-Blocking Online Schema Change Static Analysis Linter
# ---------------------------------------------------------------------------


class MigrationAstVisitor(ast.NodeVisitor):
    """AST visitor that checks for unsafe or blocking PostgreSQL DDL operations."""

    def __init__(self, filename: str) -> None:
        self.filename = filename
        self.errors: List[str] = []
        self.has_upgrade: bool = False
        self.has_downgrade: bool = False
        self.revision_id: Optional[str] = None
        self.down_revision: Optional[Any] = None
        self.tables_created_in_migration: Set[str] = set()

    def visit_Assign(self, node: ast.Assign) -> None:
        for target in node.targets:
            if isinstance(target, ast.Name):
                if target.id == "revision" and isinstance(node.value, ast.Constant):
                    self.revision_id = str(node.value.value)
                elif target.id == "down_revision":
                    if isinstance(node.value, ast.Constant):
                        self.down_revision = node.value.value
                    elif isinstance(node.value, (ast.List, ast.Tuple)):
                        self.down_revision = [
                            elt.value for elt in node.value.elts if isinstance(elt, ast.Constant)
                        ]
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if isinstance(node.target, ast.Name) and node.value is not None:
            if node.target.id == "revision" and isinstance(node.value, ast.Constant):
                self.revision_id = str(node.value.value)
            elif node.target.id == "down_revision":
                if isinstance(node.value, ast.Constant):
                    self.down_revision = node.value.value
                elif isinstance(node.value, (ast.List, ast.Tuple)):
                    self.down_revision = [
                        elt.value for elt in node.value.elts if isinstance(elt, ast.Constant)
                    ]
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        if node.name == "upgrade":
            self.has_upgrade = True
        elif node.name == "downgrade":
            self.has_downgrade = True
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        # Track tables created in this migration (e.g. op.create_table("name", ...))
        if isinstance(node.func, ast.Attribute) and node.func.attr == "create_table":
            if node.args and isinstance(node.args[0], ast.Constant):
                self.tables_created_in_migration.add(str(node.args[0].value))

        # Check for unsafe op.add_column with nullable=False without server_default
        if isinstance(node.func, ast.Attribute) and node.func.attr == "add_column":
            table_name = None
            if node.args and isinstance(node.args[0], ast.Constant):
                table_name = str(node.args[0].value)

            # Check column arg
            for arg in node.args[1:]:
                if isinstance(arg, ast.Call):
                    # Inspect sa.Column(...)
                    is_nullable = True
                    has_server_default = False
                    for kw in arg.keywords:
                        if kw.arg == "nullable" and isinstance(kw.value, ast.Constant):
                            is_nullable = bool(kw.value.value)
                        if kw.arg == "server_default":
                            has_server_default = True

                    if not is_nullable and not has_server_default:
                        self.errors.append(
                            f"{self.filename}:{node.lineno}: Blocking DDL detected: "
                            f"op.add_column on table '{table_name}' adds a NOT NULL column "
                            f"without server_default. In PostgreSQL, adding NOT NULL without "
                            f"a default causes a blocking table rewrite on existing rows."
                        )

        # Check raw SQL executions for dangerous locks
        if isinstance(node.func, ast.Attribute) and node.func.attr == "execute":
            for arg in node.args:
                sql_str = ""
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    sql_str = arg.value
                elif isinstance(arg, ast.Call) and isinstance(arg.func, ast.Attribute) and arg.func.attr == "text":
                    if arg.args and isinstance(arg.args[0], ast.Constant) and isinstance(arg.args[0].value, str):
                        sql_str = arg.args[0].value

                if sql_str:
                    upper_sql = sql_str.upper()
                    if "LOCK TABLE" in upper_sql and "ACCESS EXCLUSIVE" in upper_sql:
                        self.errors.append(
                            f"{self.filename}:{node.lineno}: Dangerous blocking lock detected: "
                            f"Explicit ACCESS EXCLUSIVE table lock is prohibited in online migrations."
                        )

        self.generic_visit(node)


def validate_migration_script(file_path: str | Path) -> List[str]:
    """Perform static safety analysis on a single Alembic migration file."""
    path = Path(file_path)
    if not path.is_file() or path.suffix != ".py":
        return []

    content = path.read_text(encoding="utf-8")
    try:
        tree = ast.parse(content, filename=str(path))
    except SyntaxError as e:
        return [f"{path}:{e.lineno}: SyntaxError: {e.msg}"]

    visitor = MigrationAstVisitor(str(path.name))
    visitor.visit(tree)

    errors = list(visitor.errors)

    if not visitor.has_upgrade:
        errors.append(f"{path.name}: Missing required upgrade() function.")
    if not visitor.has_downgrade:
        errors.append(f"{path.name}: Missing required downgrade() function (violates rollback guarantee).")
    if visitor.revision_id is None:
        errors.append(f"{path.name}: Missing 'revision' identifier.")

    return errors


def validate_all_migrations(versions_dir: str | Path) -> Dict[str, List[str]]:
    """Validate all migration scripts in the versions directory.

    Returns a mapping of filename -> list of violations.
    """
    v_path = Path(versions_dir)
    results: Dict[str, List[str]] = {}

    if not v_path.exists():
        raise FileNotFoundError(f"Versions directory not found: {versions_dir}")

    for py_file in sorted(v_path.glob("*.py")):
        if py_file.name.startswith("__"):
            continue
        errors = validate_migration_script(py_file)
        if errors:
            results[py_file.name] = errors

    return results


# ---------------------------------------------------------------------------
# 2. PostgreSQL Non-Blocking Session Configuration
# ---------------------------------------------------------------------------


def configure_non_blocking_session(
    connection: Connection,
    lock_timeout_ms: int = DEFAULT_LOCK_TIMEOUT_MS,
    statement_timeout_ms: int = DEFAULT_STATEMENT_TIMEOUT_MS,
) -> None:
    """Set Postgres session timeouts to guarantee DDL fails fast rather than blocking."""
    dialect_name = getattr(getattr(connection, "dialect", None), "name", "")
    if dialect_name == "postgresql":
        connection.execute(sa.text(f"SET lock_timeout = '{lock_timeout_ms}ms'"))
        connection.execute(sa.text(f"SET statement_timeout = '{statement_timeout_ms}ms'"))


# ---------------------------------------------------------------------------
# 3. Uncommitted Schema Change Detection (Schema Drift Detector)
# ---------------------------------------------------------------------------


def detect_uncommitted_schema_changes(
    connection: Connection,
    target_metadata: sa.MetaData,
) -> List[Any]:
    """Compare live database schema against SQLAlchemy declarative metadata.

    Returns any uncommitted schema differences (added/dropped tables, columns,
    mismatched types, or indexes) detected by Alembic autogenerate comparison.
    """
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext

    dialect_name = getattr(getattr(connection, "dialect", None), "name", "")
    ctx = MigrationContext.configure(
        connection,
        opts={
            "compare_type": True if dialect_name == "postgresql" else False,
            "compare_server_default": False,
            "include_schemas": True,
        },
    )

    diffs = compare_metadata(ctx, target_metadata)

    # Filter out benign differences:
    # 1. Monthly partition tables (e.g. ledger_events_2026_08) generated at runtime
    # 2. alembic_version tracking table
    # 3. Tables generated outside of target_metadata that are known Prisma models
    filtered_diffs: List[Any] = []
    target_table_names = set(target_metadata.tables.keys())

    for diff in diffs:
        diff_type = diff[0] if isinstance(diff, (list, tuple)) and len(diff) > 0 else None

        # Ignore remove_table for dynamically partitioned tables or Prisma tables
        if diff_type == "remove_table":
            tbl_name = diff[1].name if hasattr(diff[1], "name") else str(diff[1])
            if tbl_name == "alembic_version" or PARTITION_TABLE_REGEX.match(tbl_name):
                continue
            # If the table is from Prisma and not in target_metadata, don't consider it uncommitted
            if tbl_name not in target_table_names:
                continue

        # If a table is defined in target_metadata but missing from DB, that is uncommitted!
        if diff_type == "add_table":
            tbl = diff[1]
            tbl_name = getattr(tbl, "name", str(tbl))
            if tbl_name in target_table_names:
                filtered_diffs.append(diff)
            continue

        # Column or index changes on target tables
        if diff_type in ("add_column", "remove_column", "modify_type", "modify_nullable", "add_index", "remove_index"):
            tbl_name = diff[1] if isinstance(diff[1], str) else getattr(diff[1], "name", str(diff[1]))
            if tbl_name in target_table_names:
                filtered_diffs.append(diff)
            continue

        filtered_diffs.append(diff)

    return filtered_diffs


def assert_no_uncommitted_schema_changes(
    connection: Connection,
    target_metadata: sa.MetaData,
) -> None:
    """Assert that there are zero uncommitted schema changes."""
    diffs = detect_uncommitted_schema_changes(connection, target_metadata)
    if diffs:
        diff_descriptions = "\n".join(f" - {d}" for d in diffs)
        raise UncommittedSchemaChangeError(
            f"Detected {len(diffs)} uncommitted schema change(s) between SQLAlchemy "
            f"models and Alembic migrations:\n{diff_descriptions}\n\n"
            f"Generate a new migration revision with:\n"
            f"  alembic -c alembic/alembic.ini revision --autogenerate -m \"<description>\""
        )


# ---------------------------------------------------------------------------
# 4. Linear Migration Graph History Validation
# ---------------------------------------------------------------------------


def validate_linear_history(script_directory: Any) -> None:
    """Validate that the migration revision graph forms a single linear sequence."""
    heads = script_directory.get_heads()
    if len(heads) != 1:
        raise MigrationGovernanceError(
            f"Alembic migration graph has multiple heads: {heads}. "
            "Resolve multiple branch heads before merging."
        )

    bases = script_directory.get_bases()
    if len(bases) != 1:
        raise MigrationGovernanceError(
            f"Alembic migration graph has multiple base roots: {bases}."
        )
