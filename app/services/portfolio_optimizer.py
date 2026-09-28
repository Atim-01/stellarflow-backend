"""app/services/portfolio_optimizer.py — Convex optimization for multi-vault yield strategies.

Implements mean-variance optimization using CVXPY to compute target allocation
vectors W_target that maximize aggregate APY subject to risk constraints.
"""

from __future__ import annotations

import os
from decimal import Decimal
from typing import Dict, List, Optional, Tuple

import numpy as np
import structlog

log = structlog.get_logger(__name__)

# Optional dependency: install with `pip install cvxpy`
try:
    import cvxpy as cp

    CVXPY_AVAILABLE = True
except ImportError:
    CVXPY_AVAILABLE = False
    log.warning(
        "portfolio_optimizer.cvxpy_unavailable",
        component="PortfolioOptimizer",
        message="cvxpy not installed; optimization will use fallback proportional allocation",
    )


class OptimizationError(RuntimeError):
    """Raised when portfolio optimization fails."""


class PortfolioOptimizer:
    """Convex optimizer for multi-vault yield strategies.

    Computes optimal capital allocation vectors W_target that maximize
    aggregate APY while respecting risk constraints and capacity limits.

    Parameters
    ----------
    risk_aversion : float
        Risk aversion parameter λ for mean-variance optimization.
        Higher values prefer lower volatility over higher returns.
    max_single_allocation : float
        Maximum weight for any single strategy (e.g., 0.4 = 40%).
    min_allocation : float
        Minimum allocation weight to avoid dust positions.
    """

    def __init__(
        self,
        risk_aversion: float = 0.5,
        max_single_allocation: float = 0.40,
        min_allocation: float = 0.01,
    ) -> None:
        if not 0 <= risk_aversion <= 10:
            raise ValueError("risk_aversion must be in [0, 10]")
        if not 0 < max_single_allocation <= 1:
            raise ValueError("max_single_allocation must be in (0, 1]")
        if not 0 <= min_allocation < max_single_allocation:
            raise ValueError("min_allocation must be < max_single_allocation")

        self.risk_aversion = risk_aversion
        self.max_single_allocation = max_single_allocation
        self.min_allocation = min_allocation
        log.info(
            "portfolio_optimizer.initialized",
            component="PortfolioOptimizer",
            risk_aversion=risk_aversion,
            max_single_allocation=max_single_allocation,
        )

    def compute_target_allocations(
        self,
        strategies: List[Dict],
        total_capital: Decimal,
    ) -> Tuple[Dict[str, Decimal], Dict[str, any]]:
        """Compute optimal target allocation vector W_target.

        Parameters
        ----------
        strategies : List[Dict]
            List of strategy dictionaries with keys:
            - id: strategy identifier
            - current_apy: current APY (fractional)
            - historical_apy_std: APY standard deviation
            - tvl: total value locked
            - capacity: maximum capacity (None = unlimited)
            - risk_score: risk rating 0.0-1.0
            - enabled: whether strategy is active
        total_capital : Decimal
            Total capital to allocate across strategies.

        Returns
        -------
        Tuple[Dict[str, Decimal], Dict[str, any]]
            (allocations, metrics) where allocations maps strategy_id -> weight,
            and metrics contains optimization diagnostics.

        Raises
        ------
        OptimizationError
            If optimization problem is infeasible or fails to solve.
        """
        # Filter enabled strategies
        enabled_strategies = [s for s in strategies if s.get("enabled", True)]
        if not enabled_strategies:
            raise OptimizationError("No enabled strategies available for allocation")

        n = len(enabled_strategies)
        strategy_ids = [s["id"] for s in enabled_strategies]

        log.debug(
            "portfolio_optimizer.computing_allocations",
            component="PortfolioOptimizer",
            strategy_count=n,
            total_capital=float(total_capital),
        )

        # Use CVXPY if available, otherwise fallback to proportional
        if CVXPY_AVAILABLE:
            allocations, metrics = self._optimize_with_cvxpy(
                enabled_strategies, float(total_capital)
            )
        else:
            allocations, metrics = self._fallback_proportional_allocation(
                enabled_strategies, float(total_capital)
            )

        # Convert to Decimal for precision
        decimal_allocations = {
            strategy_id: Decimal(str(weight))
            for strategy_id, weight in allocations.items()
        }

        log.info(
            "portfolio_optimizer.allocations_computed",
            component="PortfolioOptimizer",
            strategy_count=n,
            expected_apy=metrics.get("expected_apy"),
            portfolio_risk=metrics.get("portfolio_risk"),
        )

        return decimal_allocations, metrics

    def _optimize_with_cvxpy(
        self,
        strategies: List[Dict],
        total_capital: float,
    ) -> Tuple[Dict[str, float], Dict[str, any]]:
        """Solve mean-variance optimization using CVXPY."""
        n = len(strategies)
        strategy_ids = [s["id"] for s in strategies]

        # Extract expected returns (APY) and risk (std dev)
        expected_returns = np.array([float(s["current_apy"]) for s in strategies])
        risk_scores = np.array(
            [float(s.get("historical_apy_std", 0.01)) for s in strategies]
        )

        # Build covariance matrix (simplified: diagonal with risk_score variance)
        # For production, use historical correlation matrix
        covariance_matrix = np.diag(risk_scores**2)

        # Decision variable: portfolio weights
        w = cp.Variable(n)

        # Objective: maximize return - λ * risk (mean-variance optimization)
        portfolio_return = expected_returns @ w
        portfolio_risk = cp.quad_form(w, covariance_matrix)
        objective = cp.Maximize(portfolio_return - self.risk_aversion * portfolio_risk)

        # Constraints
        constraints = [
            cp.sum(w) == 1,  # weights sum to 1
            w >= self.min_allocation,  # minimum allocation
            w <= self.max_single_allocation,  # maximum single allocation
        ]

        # Capacity constraints: w_i * total_capital <= capacity_i
        for i, strategy in enumerate(strategies):
            capacity = strategy.get("capacity")
            if capacity is not None:
                capacity_fraction = float(capacity) / total_capital
                constraints.append(w[i] <= capacity_fraction)

        # Solve optimization problem
        problem = cp.Problem(objective, constraints)
        try:
            problem.solve(solver=cp.ECOS, verbose=False)
        except Exception as exc:
            log.exception(
                "portfolio_optimizer.cvxpy_solve_error",
                component="PortfolioOptimizer",
                error=str(exc),
            )
            raise OptimizationError(f"CVXPY optimization failed: {exc}") from exc

        if problem.status not in ["optimal", "optimal_inaccurate"]:
            raise OptimizationError(
                f"Optimization problem is {problem.status}; cannot compute allocations"
            )

        # Extract solution
        weights = w.value
        allocations = {strategy_ids[i]: float(weights[i]) for i in range(n)}

        # Compute metrics
        expected_apy = float(expected_returns @ weights)
        portfolio_variance = float(weights.T @ covariance_matrix @ weights)
        portfolio_std = np.sqrt(portfolio_variance)

        metrics = {
            "expected_apy": expected_apy,
            "portfolio_risk": portfolio_std,
            "sharpe_ratio": (
                expected_apy / portfolio_std if portfolio_std > 0 else 0.0
            ),
            "optimization_status": problem.status,
            "solver": "CVXPY/ECOS",
        }

        return allocations, metrics

    def _fallback_proportional_allocation(
        self,
        strategies: List[Dict],
        total_capital: float,
    ) -> Tuple[Dict[str, float], Dict[str, any]]:
        """Fallback allocation proportional to APY when CVXPY unavailable."""
        strategy_ids = [s["id"] for s in strategies]
        apys = np.array([float(s["current_apy"]) for s in strategies])

        # Weight proportional to APY
        total_apy = apys.sum()
        if total_apy == 0:
            # Equal weight if all APYs are zero
            weights = np.ones(len(strategies)) / len(strategies)
        else:
            weights = apys / total_apy

        # Apply capacity constraints
        adjusted_weights = weights.copy()
        for i, strategy in enumerate(strategies):
            capacity = strategy.get("capacity")
            if capacity is not None:
                max_weight = float(capacity) / total_capital
                if adjusted_weights[i] > max_weight:
                    adjusted_weights[i] = max_weight

        # Renormalize to sum to 1
        adjusted_weights /= adjusted_weights.sum()

        allocations = {strategy_ids[i]: float(adjusted_weights[i]) for i in range(len(strategies))}

        # Compute metrics
        expected_apy = float(apys @ adjusted_weights)
        metrics = {
            "expected_apy": expected_apy,
            "portfolio_risk": None,
            "sharpe_ratio": None,
            "optimization_status": "fallback_proportional",
            "solver": "proportional_apy",
        }

        return allocations, metrics

    def check_drift(
        self,
        current_allocations: Dict[str, Decimal],
        target_allocations: Dict[str, Decimal],
    ) -> Tuple[Decimal, Dict[str, Decimal]]:
        """Compute allocation drift magnitude |W_current - W_target|.

        Parameters
        ----------
        current_allocations : Dict[str, Decimal]
            Current portfolio weights {strategy_id: weight}.
        target_allocations : Dict[str, Decimal]
            Target portfolio weights {strategy_id: weight}.

        Returns
        -------
        Tuple[Decimal, Dict[str, Decimal]]
            (max_drift, drift_per_strategy) where max_drift is the maximum
            absolute drift across all strategies.
        """
        all_strategies = set(current_allocations.keys()) | set(
            target_allocations.keys()
        )

        drifts = {}
        for strategy_id in all_strategies:
            current = current_allocations.get(strategy_id, Decimal("0"))
            target = target_allocations.get(strategy_id, Decimal("0"))
            drift = abs(current - target)
            drifts[strategy_id] = drift

        max_drift = max(drifts.values()) if drifts else Decimal("0")

        log.debug(
            "portfolio_optimizer.drift_computed",
            component="PortfolioOptimizer",
            max_drift=float(max_drift),
            strategy_count=len(all_strategies),
        )

        return max_drift, drifts


def create_portfolio_optimizer() -> PortfolioOptimizer:
    """Factory that builds a PortfolioOptimizer from environment variables.

    Environment variables:
    * PORTFOLIO_RISK_AVERSION — risk aversion parameter (default: 0.5)
    * PORTFOLIO_MAX_SINGLE_ALLOCATION — max single strategy weight (default: 0.4)
    * PORTFOLIO_MIN_ALLOCATION — min allocation weight (default: 0.01)

    Returns
    -------
    PortfolioOptimizer
        Configured optimizer instance.
    """
    risk_aversion = float(os.getenv("PORTFOLIO_RISK_AVERSION", "0.5"))
    max_single = float(os.getenv("PORTFOLIO_MAX_SINGLE_ALLOCATION", "0.4"))
    min_alloc = float(os.getenv("PORTFOLIO_MIN_ALLOCATION", "0.01"))

    return PortfolioOptimizer(
        risk_aversion=risk_aversion,
        max_single_allocation=max_single,
        min_allocation=min_alloc,
    )
