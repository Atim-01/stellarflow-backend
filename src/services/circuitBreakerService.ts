/**
 * Invariant Violation Automated Circuit Breaker System
 *
 * Off-chain workers detect balance invariant breaches and this service
 * triggers an automated contract pause sequence:
 *
 *   1. Invariant checker is hooked directly into the emergency multi-sig
 *      alert pipeline (same notification channel used for kill-switch alerts).
 *   2. A `pause()` transaction payload is auto-submitted to the Soroban
 *      contract, signed with the emergency keeper key.
 *   3. The security team is notified on the immediate high-priority channel.
 *
 * Every activation is recorded in the `CircuitBreakerEvent` audit table so
 * activations are traceable and de-duplicated across restarts.
 */
import dotenv from "dotenv";
import {
  Account,
  Horizon,
  Keypair,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
  xdr,
  rpc as SorobanRpc,
} from "@stellar/stellar-sdk";
import prisma from "../lib/prisma";
import stellarProvider from "../lib/stellarProvider";
import { getStellarNetworkPassphrase } from "../lib/stellarNetwork";
import { sequenceManager } from "./sequence-manager";
import { signer as defaultSigner } from "../signer";
import { ISigner } from "../signer/signer.interface";
import { notificationService } from "./notificationService";
import { isLockdownEnabled } from "../state/appState";
import {
  BalanceSnapshot,
  evaluateBalanceInvariants,
  InvariantViolation,
  requiresCircuitBreakerPause,
} from "./invariantChecker";

dotenv.config();

export type BalanceFetcher = (publicKey: string) => Promise<number | null>;
export type PauseSubmitter = (tx: Transaction) => Promise<string>;

export interface CircuitBreakerStatus {
  enabled: boolean;
  isRunning: boolean;
  contractId: string;
  minKeeperXlmBalance: number;
  checkIntervalMs: number;
  cooldownMs: number;
  lastCheckAt: string | null;
  lastViolation: string | null;
  lastPauseAt: string | null;
}

interface CircuitBreakerDeps {
  enabled?: boolean;
  contractId?: string;
  minKeeperXlmBalance?: number;
  checkIntervalMs?: number;
  cooldownMs?: number;
  keeperSigner?: ISigner;
  horizonServer?: Horizon.Server;
  rpcServer?: SorobanRpc.Server;
  balanceFetcher?: BalanceFetcher;
  pauseSubmitter?: PauseSubmitter;
  /** Stellar sequence provider, injectable for tests */
  sequenceProvider?: (publicKey: string) => Promise<string>;
  notifier?: (details: {
    breachType: string;
    reason: string;
    contractId?: string;
    txHash?: string;
  }) => Promise<boolean>;
  eventRecorder?: (event: {
    breachType: string;
    severity: string;
    reason: string;
    details: Record<string, number | string | boolean | null>;
    status: string;
    txHash?: string | null;
    keeperPublicKey: string;
  }) => Promise<unknown>;
  /** Persisted cooldown lookup, injectable for tests */
  persistedPauseFinder?: (breachType: string, since: Date) => Promise<boolean>;
}

const DEFAULT_MIN_KEEPER_XLM = 20;
const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between pause submissions
const PAUSE_MEMO_PREFIX = "SF-PAUSE-";

export class CircuitBreakerService {
  private readonly contractId: string;
  private readonly keeperSigner: ISigner;
  private readonly horizonServer: Horizon.Server;
  private readonly rpcServer: SorobanRpc.Server;
  private readonly minKeeperXlmBalance: number;
  private readonly checkIntervalMs: number;
  private readonly cooldownMs: number;
  private readonly enabled: boolean;
  private readonly balanceFetcher: BalanceFetcher;
  private readonly pauseSubmitter: PauseSubmitter;
  private readonly sequenceProvider: (publicKey: string) => Promise<string>;
  private readonly notifier: CircuitBreakerDeps["notifier"];
  private readonly eventRecorder: NonNullable<
    CircuitBreakerDeps["eventRecorder"]
  >;
  private readonly persistedPauseFinder: (
    breachType: string,
    since: Date,
  ) => Promise<boolean>;

  private isRunning = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCheckAt: Date | null = null;
  private lastViolation: string | null = null;
  private lastPauseAt: Date | null = null;
  private readonly lastPauseByBreachType = new Map<string, number>();

  constructor(deps: CircuitBreakerDeps = {}) {
    this.enabled =
      deps.enabled ?? process.env.CIRCUIT_BREAKER_ENABLED === "true";
    this.contractId = deps.contractId ?? process.env.CONTRACT_ID ?? "";
    this.keeperSigner = deps.keeperSigner ?? defaultSigner;

    this.horizonServer = deps.horizonServer ?? stellarProvider.getServer();
    this.rpcServer = deps.rpcServer ?? stellarProvider.getRpcServer();

    this.minKeeperXlmBalance =
      deps.minKeeperXlmBalance ??
      this.parsePositiveNumber(
        process.env.INVARIANT_MIN_KEEPER_XLM_BALANCE,
        DEFAULT_MIN_KEEPER_XLM,
      );
    this.checkIntervalMs =
      deps.checkIntervalMs ??
      this.parsePositiveNumber(
        process.env.CIRCUIT_BREAKER_CHECK_INTERVAL_MS,
        DEFAULT_CHECK_INTERVAL_MS,
      );
    this.cooldownMs =
      deps.cooldownMs ??
      this.parsePositiveNumber(
        process.env.CIRCUIT_BREAKER_COOLDOWN_MS,
        DEFAULT_COOLDOWN_MS,
      );

    this.balanceFetcher =
      deps.balanceFetcher ??
      ((publicKey) => this.fetchKeeperBalance(publicKey));
    this.pauseSubmitter =
      deps.pauseSubmitter ?? ((tx) => this.submitPauseTransaction(tx));
    this.sequenceProvider =
      deps.sequenceProvider ??
      ((publicKey) => sequenceManager.getNextSequence(publicKey));
    this.notifier =
      deps.notifier ??
      ((details) =>
        notificationService.sendInvariantBreachAlert({
          breachType: details.breachType,
          reason: details.reason,
          ...(details.contractId ? { contractId: details.contractId } : {}),
          ...(details.txHash ? { txHash: details.txHash } : {}),
          service: "circuit-breaker",
        }));
    this.eventRecorder =
      deps.eventRecorder ??
      ((event) => prisma.circuitBreakerEvent.create({ data: event }));
    this.persistedPauseFinder =
      deps.persistedPauseFinder ??
      ((breachType, since) =>
        prisma.circuitBreakerEvent
          .findFirst({
            where: {
              breachType,
              status: "PAUSE_SUBMITTED",
              detectedAt: { gte: since },
            },
            select: { id: true },
          })
          .then((row) => row !== null));
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Start the background invariant monitor. Runs an initial check and then
   * polls on the configured interval.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn("[CircuitBreaker] Service is already running");
      return;
    }
    if (!this.enabled) {
      console.info("[CircuitBreaker] Disabled via CIRCUIT_BREAKER_ENABLED");
      return;
    }
    if (!this.contractId) {
      console.warn(
        "[CircuitBreaker] CONTRACT_ID not configured — automated pause disabled",
      );
      return;
    }

    this.isRunning = true;
    console.info(
      `[CircuitBreaker] Started (interval: ${this.checkIntervalMs}ms, keeper XLM floor: ${this.minKeeperXlmBalance} XLM, contract: ${this.contractId})`,
    );

    await this.runCheck().catch((error) => {
      console.error("[CircuitBreaker] Initial check error:", error);
    });

    this.timer = setInterval(() => {
      this.runCheck().catch((error) => {
        console.error("[CircuitBreaker] Background check error:", error);
      });
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    console.info("[CircuitBreaker] Stopped");
  }

  // ------------------------------------------------------------------
  // Invariant check → circuit breaker pipeline
  // ------------------------------------------------------------------

  /**
   * Runs one invariant evaluation round. Fetches the keeper balance, evaluates
   * balance invariants, and triggers the automated pause sequence for any
   * CRITICAL violation. HIGH violations are notified without pausing.
   */
  async runCheck(): Promise<InvariantViolation[]> {
    if (!this.enabled || !this.contractId) {
      return [];
    }

    // Respect the existing lockdown safety mechanism — when the operator has
    // locked signing, the automated breaker stands down.
    if (await isLockdownEnabled()) {
      return [];
    }

    const keeperPublicKey = await this.keeperSigner.getPublicKey();
    const keeperXlmBalance = await this.balanceFetcher(keeperPublicKey);
    this.lastCheckAt = new Date();

    const snapshot: BalanceSnapshot = {
      keeperXlmBalance,
      keeperPublicKey,
    };
    const violations = evaluateBalanceInvariants(snapshot, {
      minKeeperXlmBalance: this.minKeeperXlmBalance,
    });

    if (violations.length === 0) {
      return [];
    }

    this.lastViolation = violations.map((v) => v.breachType).join(",");

    const critical = requiresCircuitBreakerPause(violations);
    const notifyOnly = violations.filter((v) => v.severity !== "CRITICAL");

    for (const violation of notifyOnly) {
      await this.notifyOnly(violation);
    }

    for (const violation of critical) {
      await this.triggerPause(violation);
    }

    return violations;
  }

  // ------------------------------------------------------------------
  // Automated pause() sequence
  // ------------------------------------------------------------------

  /**
   * Executes the automated circuit breaker sequence for a CRITICAL invariant
   * violation:
   *   1. De-duplicate within the cooldown window (in-memory + persisted).
   *   2. Record a DETECTED audit event.
   *   3. Build + sign the `pause()` transaction payload with the keeper key.
   *   4. Submit it to the network.
   *   5. Notify the security team on the high-priority channel.
   */
  async triggerPause(violation: InvariantViolation): Promise<{
    skipped: boolean;
    reason?: string;
    txHash?: string;
  }> {
    const now = Date.now();

    if (await this.isWithinCooldown(violation.breachType, now)) {
      console.warn(
        `[CircuitBreaker] Pause for ${violation.breachType} skipped — within cooldown window`,
      );
      return { skipped: true, reason: "cooldown" };
    }

    const keeperPublicKey = await this.keeperSigner.getPublicKey();

    await this.eventRecorder({
      breachType: violation.breachType,
      severity: violation.severity,
      reason: violation.message,
      details: violation.details,
      status: "DETECTED",
      keeperPublicKey,
    });

    let txHash: string | undefined;
    try {
      txHash = await this.buildSignAndSubmitPause(violation, keeperPublicKey);
      this.lastPauseAt = new Date();
      this.lastPauseByBreachType.set(violation.breachType, now);

      console.warn(
        `[CircuitBreaker] 🚨 pause() submitted for ${violation.breachType} - TxHash: ${txHash}`,
      );

      await this.eventRecorder({
        breachType: violation.breachType,
        severity: violation.severity,
        reason: violation.message,
        details: violation.details,
        status: "PAUSE_SUBMITTED",
        txHash: txHash ?? null,
        keeperPublicKey,
      });
    } catch (error) {
      console.error(
        `[CircuitBreaker] pause() submission failed for ${violation.breachType}:`,
        error,
      );
      await this.eventRecorder({
        breachType: violation.breachType,
        severity: violation.severity,
        reason: violation.message,
        details: violation.details,
        status: "PAUSE_FAILED",
        keeperPublicKey,
      });
      throw error;
    }

    // Notify the security team on the immediate high-priority channel.
    await this.notifier?.({
      breachType: violation.breachType,
      reason: violation.message,
      contractId: this.contractId,
      ...(txHash ? { txHash } : {}),
    });

    return { skipped: false, txHash };
  }

  // ------------------------------------------------------------------
  // Transaction construction
  // ------------------------------------------------------------------

  /**
   * Builds the raw `pause()` Soroban transaction payload for the configured
   * contract. Exposed (and kept I/O-free) so it can be unit tested.
   */
  buildPauseTransaction(
    sourceAccount: Account,
    networkPassphrase: string,
    memoText?: string,
  ): Transaction {
    return new TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.contractId,
          function: "pause",
          args: [],
        }),
      )
      .addMemo(Memo.text(memoText ?? `${PAUSE_MEMO_PREFIX}CIRCUIT`))
      .setTimeout(30)
      .build();
  }

  // ------------------------------------------------------------------
  // Status
  // ------------------------------------------------------------------

  getStatus(): CircuitBreakerStatus {
    return {
      enabled: this.enabled,
      isRunning: this.isRunning,
      contractId: this.contractId,
      minKeeperXlmBalance: this.minKeeperXlmBalance,
      checkIntervalMs: this.checkIntervalMs,
      cooldownMs: this.cooldownMs,
      lastCheckAt: this.lastCheckAt?.toISOString() ?? null,
      lastViolation: this.lastViolation,
      lastPauseAt: this.lastPauseAt?.toISOString() ?? null,
    };
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private async notifyOnly(violation: InvariantViolation): Promise<void> {
    console.warn(
      `[CircuitBreaker] Invariant violation (notify only): ${violation.breachType} — ${violation.message}`,
    );
    await this.notifier?.({
      breachType: violation.breachType,
      reason: violation.message,
      contractId: this.contractId,
    });
  }

  private async buildSignAndSubmitPause(
    violation: InvariantViolation,
    publicKey: string,
  ): Promise<string> {
    const nextSequence = await this.sequenceProvider(publicKey);
    const sourceAccount = new Account(publicKey, nextSequence);
    const memo = `${PAUSE_MEMO_PREFIX}${violation.breachType.slice(0, 14)}`;

    const raw = this.buildPauseTransaction(
      sourceAccount,
      getStellarNetworkPassphrase(),
      memo,
    );

    return this.pauseSubmitter(raw);
  }

  /**
   * Default pause submitter: simulate via RPC to obtain auth entries, assemble,
   * sign with the emergency keeper key, and submit to the network.
   */
  private async submitPauseTransaction(raw: Transaction): Promise<string> {
    const simulation = await this.rpcServer.simulateTransaction(raw);
    if (SorobanRpc.Api.isSimulationError(simulation)) {
      throw new Error(`pause() simulation failed: ${simulation.error}`);
    }

    const assembled = SorobanRpc.assembleTransaction(raw, simulation).build();
    const txHash = assembled.hash();
    const signature = await this.keeperSigner.sign(txHash);
    const keypair = Keypair.fromPublicKey(
      await this.keeperSigner.getPublicKey(),
    );

    assembled.signatures.push(
      new xdr.DecoratedSignature({
        hint: keypair.signatureHint(),
        signature,
      }),
    );

    const response = await this.rpcServer.sendTransaction(assembled);
    const accepted = new Set(["PENDING", "DUPLICATE", "TRY_AGAIN_LATER"]);
    if (!accepted.has(response.status)) {
      throw new Error(
        `pause() submission rejected with status "${response.status}"${response.errorResult ? `: ${response.errorResult.result().toString()}` : ""}`,
      );
    }

    return assembled.hash().toString("hex");
  }

  /**
   * Cooldown de-duplication: skips re-triggering the pause sequence for the
   * same breach type within the cooldown window. Combines in-memory state with
   * persisted CircuitBreakerEvent rows so dedupe survives restarts.
   */
  private async isWithinCooldown(
    breachType: string,
    now: number,
  ): Promise<boolean> {
    const lastInMemory = this.lastPauseByBreachType.get(breachType) ?? 0;
    if (now - lastInMemory < this.cooldownMs) {
      return true;
    }

    return this.persistedPauseFinder(
      breachType,
      new Date(now - this.cooldownMs),
    );
  }

  private async fetchKeeperBalance(publicKey: string): Promise<number | null> {
    try {
      const account = await this.horizonServer.loadAccount(publicKey);
      const native = account.balances.find(
        (balance) => balance.asset_type === "native",
      );
      return native ? parseFloat(native.balance) : null;
    } catch (error) {
      console.error(
        `[CircuitBreaker] Failed to load keeper balance for ${publicKey}:`,
        error,
      );
      return null;
    }
  }

  private parsePositiveNumber(
    raw: string | undefined,
    fallback: number,
  ): number {
    const parsed = Number.parseInt(raw ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}

// Lazy singleton factory — avoids constructing the service (and touching
// stellarProvider / signer) at import time, matching the pattern used by
// gasBalanceMonitorService.
let _instance: CircuitBreakerService | null = null;

export function getCircuitBreakerService(): CircuitBreakerService {
  if (!_instance) {
    _instance = new CircuitBreakerService();
  }
  return _instance;
}
