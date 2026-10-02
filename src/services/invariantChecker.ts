/**
 * Invariant violation evaluation for the automated circuit breaker system.
 *
 * Off-chain workers snapshot on-chain state (balances, contract state) and feed
 * it into `evaluateBalanceInvariants`, which decides whether a balance
 * invariant has been breached. Breaches are then routed into the emergency
 * multi-sig alert pipeline (see `circuitBreakerService.ts`).
 *
 * Keeping this module pure (no I/O) makes the breach rules easy to unit test
 * and reason about.
 */

export type InvariantSeverity = "HIGH" | "CRITICAL";

export interface InvariantViolation {
  /** Stable machine-readable breach identifier, e.g. "KEEPER_XLM_BALANCE_BELOW_FLOOR" */
  breachType: string;
  /** CRITICAL breaches trigger the automated pause() sequence; HIGH only notifies */
  severity: InvariantSeverity;
  /** Human readable description of the violation */
  message: string;
  /** Extra context attached to alerts and audit records */
  details: Record<string, number | string | boolean>;
}

/** On-chain balance snapshot collected by the off-chain worker. */
export interface BalanceSnapshot {
  /** XLM balance of the keeper/admin account, or null when it could not be read */
  keeperXlmBalance: number | null;
  /** Stellar public key the snapshot was loaded for */
  keeperPublicKey: string;
}

export interface InvariantCheckOptions {
  /** Minimum XLM the keeper account must hold to cover transaction fees */
  minKeeperXlmBalance: number;
}

/**
 * Evaluates balance invariants against a snapshot.
 *
 * Rules:
 *  - A keeper balance that cannot be read is a HIGH severity violation
 *    (state unknown → escalate to humans, but do not auto-pause).
 *  - A keeper balance below the configured floor is a CRITICAL violation
 *    (the keeper can no longer pay fees → auto-pause).
 *
 * Returns an empty array when every invariant holds.
 */
export function evaluateBalanceInvariants(
  snapshot: BalanceSnapshot,
  options: InvariantCheckOptions,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  if (snapshot.keeperXlmBalance === null) {
    violations.push({
      breachType: "KEEPER_BALANCE_UNREADABLE",
      severity: "HIGH",
      message:
        "Keeper account balance could not be read — invariant state is unknown.",
      details: {
        keeperPublicKey: snapshot.keeperPublicKey,
        minKeeperXlmBalance: options.minKeeperXlmBalance,
      },
    });
    return violations;
  }

  if (snapshot.keeperXlmBalance < options.minKeeperXlmBalance) {
    violations.push({
      breachType: "KEEPER_XLM_BALANCE_BELOW_FLOOR",
      severity: "CRITICAL",
      message: `Keeper XLM balance ${snapshot.keeperXlmBalance} is below the invariant floor of ${options.minKeeperXlmBalance} XLM.`,
      details: {
        keeperPublicKey: snapshot.keeperPublicKey,
        balance: snapshot.keeperXlmBalance,
        minKeeperXlmBalance: options.minKeeperXlmBalance,
      },
    });
  }

  return violations;
}

/**
 * Filters out violations that require the automated pause() sequence.
 * HIGH severity violations (e.g. unreadable state) are surfaced to humans
 * but must not freeze the contract on their own.
 */
export function requiresCircuitBreakerPause(
  violations: InvariantViolation[],
): InvariantViolation[] {
  return violations.filter((v) => v.severity === "CRITICAL");
}
