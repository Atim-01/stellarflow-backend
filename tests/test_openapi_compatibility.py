from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "check_openapi.py"
SPEC = importlib.util.spec_from_file_location("check_openapi_module", SCRIPT_PATH)
openapi_module = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
SPEC.loader.exec_module(openapi_module)


def _spec_with_legacy_property(legacy_present: bool) -> dict:
    properties = {"id": {"type": "string"}}
    if legacy_present:
        properties["legacy"] = {"type": "string"}
    return {
        "openapi": "3.0.0",
        "paths": {
            "/v1/example": {
                "get": {
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": properties,
                                        "required": ["id"] + (["legacy"] if legacy_present else []),
                                    }
                                }
                            },
                        }
                    }
                }
            }
        },
    }


def test_main_flags_breaking_change_against_baseline(monkeypatch, tmp_path):
    baseline_path = tmp_path / "baseline-openapi.json"
    baseline_path.write_text(json.dumps(_spec_with_legacy_property(True)), encoding="utf-8")

    monkeypatch.setattr(openapi_module, "generated_spec", lambda: _spec_with_legacy_property(False))
    monkeypatch.setattr(openapi_module, "validate_spec", lambda spec: None)
    monkeypatch.setattr(sys, "argv", ["check_openapi.py", "--check", "--baseline", str(baseline_path)])

    assert openapi_module.main() == 1


def test_main_allows_explicit_approval_override(monkeypatch, tmp_path):
    baseline_path = tmp_path / "baseline-openapi.json"
    baseline_path.write_text(json.dumps(_spec_with_legacy_property(True)), encoding="utf-8")

    monkeypatch.setenv("OPENAPI_BREAKING_CHANGE_APPROVAL", "true")
    monkeypatch.setattr(openapi_module, "generated_spec", lambda: _spec_with_legacy_property(False))
    monkeypatch.setattr(openapi_module, "validate_spec", lambda spec: None)
    monkeypatch.setattr(sys, "argv", ["check_openapi.py", "--check", "--baseline", str(baseline_path)])

    assert openapi_module.main() == 0
