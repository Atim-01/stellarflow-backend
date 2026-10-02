import { Account, Keypair } from "@stellar/stellar-sdk";
import type { ISigner } from "../src/signer/signer.interface";

let passed = 0;
let failed = 0;

function assert(description: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.log(`  ✗ ${description}`);
    failed++;
  }
}

function assertEqual(description: string, actual: unknown, expected: unknown) {
  const ok =
    actual === expected ||
    (typeof actual === "number" &&
      typeof expected === "number" &&
      Number.isNaN(actual) &&
      Number.isNaN(expected));
  if (ok) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.log(`  ✗ ${description} — expected ${expected}, got ${actual}`);
    failed++;
  }
}

interface TestHarness {
  service: import("../src/services/circuitBreakerService").CircuitBreakerService;
  events: Array<Record<string, any>>;
  submittedTxs: Array<import("@stellar/stellar-sdk").Transaction>;
  notified: number;
}

function makeHarness(
  breakerCtor: typeof import("../src/services/circuitBreakerService").CircuitBreakerService,
  opts: {
    balance?: number | null;
    cooldownMs?: number;
    enabled?: boolean;
    persistedPause?: boolean;
  },
): TestHarness {
  const events: Array<Record<string, any>> = [];
  const submittedTxs: Array<import("@stellar/stellar-sdk").Transaction> = [];
  let notified = 0;

  const keeper = Keypair.random();
  const fakeSigner: ISigner = {
    getPublicKey: async () => keeper.publicKey(),
    sign: async (txHash: Buffer) => keeper.sign(txHash),
  };

  const service = new breakerCtor({
    enabled: opts.enabled ?? true,
    contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    keeperSigner: fakeSigner,
    minKeeperXlmBalance: 20,
    cooldownMs: opts.cooldownMs ?? 60_000,
    checkIntervalMs: 60_000,
    balanceFetcher: async () =>
      opts.balance === undefined ? 100 : opts.balance,
    pauseSubmitter: async (tx) => {
      submittedTxs.push(tx);
      return "fake-tx-hash-123";
    },
    sequenceProvider: async () => "100",
    notifier: async () => {
      notified++;
      return true;
    },
    eventRecorder: async (event) => {
      events.push(event);
    },
    persistedPauseFinder: async () => opts.persistedPause === true,
  });

  return {
    service,
    events,
    submittedTxs,
    get notified() {
      return notified;
    },
  };
}

async function run() {
  const testSecret = Keypair.random().secret();
  process.env.STELLAR_SECRET = testSecret;
  process.env.SIGNER_BACKEND = "local";
  delete process.env.ENCRYPTED_STELLAR_SECRET;

  const { evaluateBalanceInvariants, requiresCircuitBreakerPause } =
    await import("../src/services/invariantChecker");
  const { CircuitBreakerService } =
    await import("../src/services/circuitBreakerService");

  console.log("🧪 Testing invariant checker...\n");

  assert(
    "healthy balance produces no violations",
    evaluateBalanceInvariants(
      { keeperXlmBalance: 100, keeperPublicKey: "GABC" },
      { minKeeperXlmBalance: 20 },
    ).length === 0,
  );

  assert(
    "balance exactly at floor produces no violations",
    evaluateBalanceInvariants(
      { keeperXlmBalance: 20, keeperPublicKey: "GABC" },
      { minKeeperXlmBalance: 20 },
    ).length === 0,
  );

  const breach = evaluateBalanceInvariants(
    { keeperXlmBalance: 5, keeperPublicKey: "GABC" },
    { minKeeperXlmBalance: 20 },
  );
  assertEqual("below-floor balance yields one violation", breach.length, 1);
  assertEqual(
    "below-floor breach type",
    breach[0]?.breachType,
    "KEEPER_XLM_BALANCE_BELOW_FLOOR",
  );
  assertEqual(
    "below-floor severity is CRITICAL",
    breach[0]?.severity,
    "CRITICAL",
  );

  const unreadable = evaluateBalanceInvariants(
    { keeperXlmBalance: null, keeperPublicKey: "GABC" },
    { minKeeperXlmBalance: 20 },
  );
  assertEqual("unreadable balance yields one violation", unreadable.length, 1);
  assertEqual(
    "unreadable breach type",
    unreadable[0]?.breachType,
    "KEEPER_BALANCE_UNREADABLE",
  );
  assertEqual("unreadable severity is HIGH", unreadable[0]?.severity, "HIGH");

  assert(
    "requiresCircuitBreakerPause filters out HIGH-only violations",
    requiresCircuitBreakerPause(unreadable).length === 0,
  );
  assert(
    "requiresCircuitBreakerPause keeps CRITICAL violations",
    requiresCircuitBreakerPause(breach).length === 1,
  );

  console.log("\n🧪 Testing pause() payload construction...\n");

  const keeper = Keypair.random();
  const service = new CircuitBreakerService({
    enabled: true,
    contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    keeperSigner: {
      getPublicKey: async () => keeper.publicKey(),
      sign: async (txHash: Buffer) => keeper.sign(txHash),
    },
    minKeeperXlmBalance: 20,
    balanceFetcher: async () => 100,
    pauseSubmitter: async (tx) => tx.hash().toString("hex"),
    sequenceProvider: async () => "100",
    notifier: async () => true,
    eventRecorder: async () => {},
    persistedPauseFinder: async () => false,
  });

  const source = new Account(keeper.publicKey(), "100");
  const pauseTx = service.buildPauseTransaction(
    source,
    "Test SDF Network ; September 2015",
    "SF-PAUSE-TEST",
  );
  assertEqual(
    "pause tx has exactly one operation",
    pauseTx.operations.length,
    1,
  );
  const op = pauseTx.operations[0] as any;
  assertEqual("operation is invokeHostFunction", op.type, "invokeHostFunction");
  assertEqual(
    "host function invokes a contract",
    op.func.switch().name,
    "hostFunctionTypeInvokeContract",
  );
  assertEqual(
    "invoked method is pause",
    op.func.value().functionName().toString(),
    "pause",
  );
  assertEqual("memo is set", pauseTx.memo.value, "SF-PAUSE-TEST");

  console.log("\n🧪 Testing circuit breaker flow...\n");

  const healthy = makeHarness(CircuitBreakerService, { balance: 100 });
  const healthyViolations = await healthy.service.runCheck();
  assertEqual(
    "healthy check yields no violations",
    healthyViolations.length,
    0,
  );
  assertEqual("healthy check records no events", healthy.events.length, 0);
  assertEqual("healthy check does not notify", healthy.notified, 0);

  const breached = makeHarness(CircuitBreakerService, { balance: 5 });
  const breachedViolations = await breached.service.runCheck();
  assertEqual(
    "breached check yields one violation",
    breachedViolations.length,
    1,
  );
  assertEqual(
    "breached check submits exactly one pause tx",
    breached.submittedTxs.length,
    1,
  );
  const statuses = breached.events.map((e) => e.status);
  assert(
    "breach is recorded as DETECTED then PAUSE_SUBMITTED",
    statuses.includes("DETECTED") && statuses.includes("PAUSE_SUBMITTED"),
  );
  assertEqual("breach notifies the security team", breached.notified, 1);
  assertEqual(
    "pause memo embeds the breach type",
    (breached.submittedTxs[0] as any)?.memo.value,
    "SF-PAUSE-KEEPER_XLM_BAL",
  );

  const cooldown = makeHarness(CircuitBreakerService, {
    balance: 5,
    cooldownMs: 60_000,
  });
  await cooldown.service.runCheck();
  const second = await cooldown.service.triggerPause({
    breachType: "KEEPER_XLM_BALANCE_BELOW_FLOOR",
    severity: "CRITICAL",
    message: "re-trigger",
    details: {},
  });
  assertEqual("second pause within cooldown is skipped", second.skipped, true);
  assertEqual(
    "cooldown skip does not submit another tx",
    cooldown.submittedTxs.length,
    1,
  );

  const persisted = makeHarness(CircuitBreakerService, {
    balance: 5,
    persistedPause: true,
  });
  const persistedResult = await persisted.service.triggerPause({
    breachType: "KEEPER_XLM_BALANCE_BELOW_FLOOR",
    severity: "CRITICAL",
    message: "persisted dedupe",
    details: {},
  });
  assertEqual(
    "persisted PAUSE_SUBMITTED row triggers cooldown skip",
    persistedResult.skipped,
    true,
  );

  const unreadableHarness = makeHarness(CircuitBreakerService, {
    balance: null,
  });
  const unreadableViolations = await unreadableHarness.service.runCheck();
  assertEqual(
    "unreadable balance yields one violation",
    unreadableViolations.length,
    1,
  );
  assertEqual(
    "unreadable balance does not auto-pause",
    unreadableHarness.submittedTxs.length,
    0,
  );
  assertEqual(
    "unreadable balance still notifies",
    unreadableHarness.notified,
    1,
  );

  const disabled = makeHarness(CircuitBreakerService, {
    balance: 5,
    enabled: false,
  });
  const disabledViolations = await disabled.service.runCheck();
  assertEqual(
    "disabled service performs no checks",
    disabledViolations.length,
    0,
  );
  assertEqual(
    "disabled service submits nothing",
    disabled.submittedTxs.length,
    0,
  );

  const status = breached.service.getStatus();
  assertEqual("status reports enabled", status.enabled, true);
  assertEqual(
    "status reports last violation",
    status.lastViolation,
    "KEEPER_XLM_BALANCE_BELOW_FLOOR",
  );
  assert("status reports last pause time", status.lastPauseAt !== null);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
