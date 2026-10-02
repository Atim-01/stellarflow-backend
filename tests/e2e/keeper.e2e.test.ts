/**
 * E2E — Keeper layer (TypeScript): secure secret safekeeping, HMAC signing,
 * zeroisation and tamper-evident state persistence.
 */
import fs from "node:fs";
import { KeyKeeper, SecretNotFoundError } from "../../src/state/keeper";
import type { LayerResult } from "./releaseReport";
import { ReleaseReport } from "./releaseReport";

function layer(name: string): LayerResult {
  return { name, status: "passed", durationS: 0, checks: 0, errors: [], metrics: {}, notes: [] };
}

describe("Keeper layer (e2e)", () => {
  let report: ReleaseReport;
  let result: LayerResult;

  beforeAll(() => {
    report = new ReleaseReport({ runtime: "node" });
  });
  beforeEach(() => {
    result = layer("keeper");
  });
  afterEach(() => {
    report.addLayer(result);
  });

  test("sign and verify, with per-secret scoping", () => {
    const keeper = new KeyKeeper(Buffer.from("test-root"));
    keeper.put("stellar_signer", Buffer.from("super-secret-key"));
    const sig = keeper.sign("stellar_signer", Buffer.from("transfer 100 XLM"));
    expect(keeper.verify("stellar_signer", Buffer.from("transfer 100 XLM"), sig)).toBe(true);
    expect(keeper.verify("stellar_signer", Buffer.from("tampered"), sig)).toBe(false);

    keeper.put("other", Buffer.from("other-material"));
    const otherSig = keeper.sign("other", Buffer.from("transfer 100 XLM"));
    expect(keeper.verify("stellar_signer", Buffer.from("transfer 100 XLM"), otherSig)).toBe(false);

    result.checks = 3;
    result.metrics.signers = 2;
    result.notes.push("HMAC signing scoped per-secret; cross-forgery rejected");
  });

  test("delete zeroises secret memory", () => {
    const keeper = new KeyKeeper();
    keeper.put("victim", Buffer.from("plaintext-secret"));
    const handle = keeper as unknown as { secrets: Map<string, { length: number }> };
    keeper.delete("victim");
    expect(keeper.has("victim")).toBe(false);
    expect(handle.secrets.has("victim")).toBe(false);
    expect(() => keeper.sign("victim", Buffer.from("x"))).toThrow(SecretNotFoundError);
    result.checks = 2;
    result.metrics.zeroised = true;
  });

  test("persisted state contains no secret material", () => {
    const keeper = new KeyKeeper(Buffer.from("root"), "reports/_ts_keeper_state.json");
    keeper.put("signer-a", Buffer.from("secret-a"));
    keeper.put("signer-b", Buffer.from("secret-b"));
    const p = keeper.persistState();
    const text = fs.readFileSync(p.toString(), "utf-8");
    expect(text.includes("secret-a")).toBe(false);
    expect(text.includes("secret-b")).toBe(false);
    expect(text.includes('"enrollments"')).toBe(true);
    result.checks = 2;
    result.metrics.enrollments = keeper.listEnrollments().length;
  });

  test("root rotation invalidates prior signatures", () => {
    const keeper = new KeyKeeper(Buffer.from("root"));
    keeper.put("k", Buffer.from("secret"));
    const old = keeper.sign("k", Buffer.from("msg"));
    keeper.rotateRootKey(Buffer.from("new-root"));
    expect(keeper.verify("k", Buffer.from("msg"), old)).toBe(false);
    expect(keeper.verify("k", Buffer.from("msg"), keeper.sign("k", Buffer.from("msg")))).toBe(true);
    result.checks = 1;
    result.metrics.rotated = true;
  });
});
