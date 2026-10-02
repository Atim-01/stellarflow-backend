"""tests/test_proof_verification_engine.py

Issue #824 — Shielded Transaction Proof Verification Offloading Engine

Test suite for:
- app.models.proof (Pydantic validation)
- app.services.proof_verification_engine (structure validation, contract simulation guard,
  process pool offloading, two-tier caching)
"""

from __future__ import annotations

import asyncio
import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.models.proof import (
    ContractSimulationParams,
    ProofPayload,
    ProofValidationResult,
    ProofVerificationRequest,
    ProofVerificationResponse,
)
from app.services.proof_verification_engine import (
    PROOF_CACHE_TTL_SECONDS,
    PROOF_PROCESS_POOL_WORKERS,
    _compute_proof_hash,
    _validate_contract_simulation_params,
    _validate_proof_structure,
    get_process_pool,
    shutdown_process_pool,
    verify_proof_async,
    verify_proof_batch,
)
from app.services.executor_pool import HEAVY_POOL_WORKERS


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sample_proof_hex() -> str:
    return "a" * 192  # 96 bytes, valid hex


def _sample_public_inputs() -> list[str]:
    return ["0x1234", "0x5678"]


# ---------------------------------------------------------------------------
# Pydantic model tests
# ---------------------------------------------------------------------------

class TestProofPayload:
    def test_valid_groth16_payload(self):
        payload = ProofPayload(
            proof_hex=_sample_proof_hex(),
            public_inputs=_sample_public_inputs(),
            contract_params={"contract_id": "CABC", "function_name": "verify"},
            transaction_hash="b" * 64,
            proof_scheme="groth16",
        )
        assert payload.proof_scheme.value == "groth16"
        assert payload.transaction_hash == "b" * 64

    def test_rejects_non_hex_proof(self):
        with pytest.raises(ValueError, match="hexadecimal"):
            ProofPayload(
                proof_hex="zz" + _sample_proof_hex()[2:],
                public_inputs=_sample_public_inputs(),
                contract_params={},
                transaction_hash="b" * 64,
            )

    def test_rejects_odd_length_proof(self):
        with pytest.raises(ValueError, match="even"):
            ProofPayload(
                proof_hex="abc",
                public_inputs=_sample_public_inputs(),
                contract_params={},
                transaction_hash="b" * 64,
            )

    def test_rejects_invalid_transaction_hash(self):
        with pytest.raises(ValueError, match="hexadecimal"):
            ProofPayload(
                proof_hex=_sample_proof_hex(),
                public_inputs=_sample_public_inputs(),
                contract_params={},
                transaction_hash="g" * 64,
            )


class TestContractSimulationParams:
    def test_valid_params(self):
        params = ContractSimulationParams(
            contract_id="CABC",
            function_name="verify",
            source_account="GABC",
        )
        assert params.contract_id == "CABC"

    def test_rejects_empty_contract_id(self):
        with pytest.raises(ValueError):
            ContractSimulationParams(
                contract_id="",
                function_name="verify",
                source_account="GABC",
            )


# ---------------------------------------------------------------------------
# Structure validation tests
# ---------------------------------------------------------------------------

class TestValidateProofStructure:
    def test_accepts_valid_groth16(self):
        err = _validate_proof_structure(
            _sample_proof_hex(), _sample_public_inputs(), "groth16"
        )
        assert err is None

    def test_rejects_empty_proof(self):
        err = _validate_proof_structure("", _sample_public_inputs(), "groth16")
        assert "empty" in err.lower()

    def test_rejects_odd_length(self):
        err = _validate_proof_structure("abc", _sample_public_inputs(), "groth16")
        assert "odd" in err.lower()

    def test_rejects_oversized_proof(self):
        huge = "a" * (4096 * 2 + 10)
        err = _validate_proof_structure(huge, _sample_public_inputs(), "groth16")
        assert "exceeds maximum" in err

    def test_rejects_empty_public_inputs(self):
        err = _validate_proof_structure(_sample_proof_hex(), [], "groth16")
        assert "public_inputs" in err

    def test_rejects_too_many_public_inputs(self):
        inputs = ["0x" + str(i) for i in range(65)]
        err = _validate_proof_structure(_sample_proof_hex(), inputs, "groth16")
        assert "65 items" in err

    def test_rejects_unknown_scheme(self):
        err = _validate_proof_structure(
            _sample_proof_hex(), _sample_public_inputs(), "unknown"
        )
        assert "unsupported" in err

    def test_accepts_all_known_schemes(self):
        for scheme in ["groth16", "plonk", "marlin", "flonk"]:
            err = _validate_proof_structure(
                _sample_proof_hex(), _sample_public_inputs(), scheme
            )
            assert err is None, f"Scheme {scheme} should be accepted"


# ---------------------------------------------------------------------------
# Contract simulation guard tests
# ---------------------------------------------------------------------------

class TestValidateContractSimulationParams:
    def test_accepts_valid_params(self):
        params = {
            "contract_id": "CABC",
            "function_name": "verify",
            "source_account": "GABC",
            "args": [1, 2, 3],
        }
        assert _validate_contract_simulation_params(params) is None

    def test_rejects_empty_params(self):
        assert _validate_contract_simulation_params({}) is not None

    def test_rejects_missing_contract_id(self):
        params = {"function_name": "verify", "source_account": "GABC"}
        err = _validate_contract_simulation_params(params)
        assert "contract_id" in err

    def test_rejects_non_string_contract_id(self):
        params = {
            "contract_id": 123,
            "function_name": "verify",
            "source_account": "GABC",
        }
        err = _validate_contract_simulation_params(params)
        assert "contract_id" in err

    def test_rejects_non_list_args(self):
        params = {
            "contract_id": "CABC",
            "function_name": "verify",
            "source_account": "GABC",
            "args": "not-a-list",
        }
        err = _validate_contract_simulation_params(params)
        assert "args" in err


# ---------------------------------------------------------------------------
# Cache key tests
# ---------------------------------------------------------------------------

class TestComputeProofHash:
    def test_deterministic(self):
        h1 = _compute_proof_hash("a" * 192, ["0x1", "0x2"])
        h2 = _compute_proof_hash("a" * 192, ["0x1", "0x2"])
        assert h1 == h2

    def test_different_inputs_different_hashes(self):
        h1 = _compute_proof_hash("a" * 192, ["0x1"])
        h2 = _compute_proof_hash("b" * 192, ["0x1"])
        assert h1 != h2

    def test_output_is_hex_sha256(self):
        h = _compute_proof_hash("a" * 192, ["0x1"])
        assert len(h) == 64
        assert all(c in "0123456789abcdef" for c in h)


# ---------------------------------------------------------------------------
# Process pool tests
# ---------------------------------------------------------------------------

class TestProcessPool:
    def test_pool_creates_with_workers(self):
        pool = get_process_pool()
        assert pool is not None
        assert pool._max_workers == HEAVY_POOL_WORKERS

    def test_shutdown_clean(self):
        pool = get_process_pool()
        assert pool is not None
        shutdown_process_pool()
        # After shutdown a new pool is created on next get_process_pool() call


# ---------------------------------------------------------------------------
# Async verification tests
# ---------------------------------------------------------------------------

class TestVerifyProofAsync:
    @pytest.mark.asyncio
    async def test_valid_proof_returns_true(self):
        # Use a small proof to keep the test fast
        result = await verify_proof_async(
            proof_hex="a" * 64,
            public_inputs=["0x1"],
            proof_scheme="groth16",
        )
        assert result.valid is True
        assert result.cached is False
        assert result.proof_hash != ""
        assert result.public_inputs_count == 1

    @pytest.mark.asyncio
    async def test_invalid_proof_returns_false(self):
        result = await verify_proof_async(
            proof_hex="",
            public_inputs=["0x1"],
            proof_scheme="groth16",
        )
        assert result.valid is False
        assert "Structure validation failed" in result.error

    @pytest.mark.asyncio
    async def test_contract_simulation_ready_flag(self):
        result = await verify_proof_async(
            proof_hex="a" * 64,
            public_inputs=["0x1"],
            contract_params={
                "contract_id": "CABC",
                "function_name": "verify",
                "source_account": "GABC",
            },
            proof_scheme="groth16",
            simulate_contract=True,
        )
        assert result.contract_simulation_ready is True

    @pytest.mark.asyncio
    async def test_invalid_contract_params_returns_error(self):
        result = await verify_proof_async(
            proof_hex="a" * 64,
            public_inputs=["0x1"],
            contract_params={},
            proof_scheme="groth16",
            simulate_contract=True,
        )
        assert result.valid is False
        assert "Contract simulation validation failed" in result.error

    @pytest.mark.asyncio
    async def test_cache_hit_returns_cached_result(self):
        proof_hex = "a" * 64
        public_inputs = ["0x1"]

        # First call populates the cache
        result1 = await verify_proof_async(
            proof_hex=proof_hex,
            public_inputs=public_inputs,
            proof_scheme="groth16",
        )
        assert result1.cached is False

        # Second call should hit L1 cache
        result2 = await verify_proof_async(
            proof_hex=proof_hex,
            public_inputs=public_inputs,
            proof_scheme="groth16",
        )
        assert result2.cached is True
        assert result2.valid == result1.valid
        assert result2.proof_hash == result1.proof_hash


# ---------------------------------------------------------------------------
# Batch verification tests
# ---------------------------------------------------------------------------

class TestVerifyProofBatch:
    @pytest.mark.asyncio
    async def test_empty_list_returns_empty(self):
        results = await verify_proof_batch([])
        assert results == []

    @pytest.mark.asyncio
    async def test_validates_structure_before_pool(self):
        results = await verify_proof_batch([
            {
                "proof_hex": "",
                "public_inputs": ["0x1"],
                "proof_scheme": "groth16",
            }
        ])
        assert len(results) == 1
        assert results[0].valid is False
        assert results[0].cached is False

    @pytest.mark.asyncio
    async def test_processes_valid_payloads(self):
        results = await verify_proof_batch([
            {
                "proof_hex": "a" * 64,
                "public_inputs": ["0x1"],
                "proof_scheme": "groth16",
            },
            {
                "proof_hex": "b" * 64,
                "public_inputs": ["0x2"],
                "proof_scheme": "plonk",
            },
        ])
        assert len(results) == 2
        assert all(r.valid for r in results)
        assert results[0].proof_hash != results[1].proof_hash


# ---------------------------------------------------------------------------
# Configuration tests
# ---------------------------------------------------------------------------

class TestConfiguration:
    def test_default_workers_is_positive(self):
        assert PROOF_PROCESS_POOL_WORKERS > 0

    def test_cache_ttl_is_positive(self):
        assert PROOF_CACHE_TTL_SECONDS > 0
