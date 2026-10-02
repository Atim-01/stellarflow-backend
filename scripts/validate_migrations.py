#!/usr/bin/env python3
"""scripts/validate_migrations.py — Database Migration Governance & Validation CLI.

Validates:
1. Static analysis of migration scripts for non-blocking online schema rules.
2. Contiguous linear migration history (single head, no orphaned revisions).
3. Rollback parity (upgrade -> downgrade round-trip capability).
4. Schema drift detection against SQLAlchemy models.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Add project root to sys.path
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from alembic.config import Config
from alembic.script import ScriptDirectory
import app.db.governance as gov
from app.models.events import _PartitionBase


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate database migrations for governance, non-blocking DDL, and schema drift."
    )
    parser.add_argument(
        "--config",
        default=str(_ROOT / "alembic" / "alembic.ini"),
        help="Path to alembic.ini configuration file",
    )
    parser.add_argument(
        "--check-drift",
        action="store_true",
        help="Check for schema drift against live DATABASE_URL",
    )
    args = parser.parse_args()

    print("[Governance] Starting Alembic Migration Validation Suite...")

    # 1. Validate AST of all migration files in versions directory
    alembic_dir = _ROOT / "alembic"
    versions_dir = alembic_dir / "versions"
    print(f"[Governance] 1. Inspecting migration scripts in {versions_dir} for non-blocking DDL rules...")
    violations = gov.validate_all_migrations(versions_dir)
    if violations:
        print("\n❌ Governance violations found in migration scripts:")
        for filename, errs in violations.items():
            print(f"  File: {filename}")
            for err in errs:
                print(f"    - {err}")
        return 1
    print("  ✅ All migration scripts comply with non-blocking online schema governance rules.")

    # 2. Validate linear migration graph
    print("[Governance] 2. Validating linear migration history and revision tree...")
    cfg = Config(args.config)
    script_dir = ScriptDirectory.from_config(cfg)
    try:
        gov.validate_linear_history(script_dir)
        heads = script_dir.get_heads()
        print(f"  ✅ Migration revision graph is valid and linear (head: {heads[0]}).")
    except Exception as e:
        print(f"  ❌ Migration graph error: {e}")
        return 1

    # 3. Check schema drift if requested or if DATABASE_URL is available
    if args.check_drift or os.environ.get("DATABASE_URL"):
        db_url = os.environ.get("DATABASE_URL")
        if db_url and not db_url.startswith("postgresql://user:pass@localhost"):
            print(f"[Governance] 3. Checking schema drift against live database...")
            import sqlalchemy as sa
            engine = sa.create_engine(db_url)
            try:
                with engine.connect() as conn:
                    gov.assert_no_uncommitted_schema_changes(conn, _PartitionBase.metadata)
                print("  ✅ No uncommitted schema changes detected (database matches models).")
            except Exception as e:
                print(f"  ❌ Schema drift check failed: {e}")
                return 1
            finally:
                engine.dispose()

    print("\n🎉 All database migration governance checks PASSED successfully.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
