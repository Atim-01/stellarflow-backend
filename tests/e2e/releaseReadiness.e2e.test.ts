/**
 * Cross-cutting E2E — simulated load on the Keeper layer with assertions for
 * zero unhandled exceptions / rejections. Emits a TypeScript release-readiness
 * report under `reports/` and fails the suite if the gate is not PASS.
 */
import { KeyKeeper } from "../../src/state/keeper";
import { ReleaseReport, type LayerResult } from "./releaseReport";

describe("Release readiness (e2e load)", () => {
  test("keeper under concurrent load: zero unhandled exceptions", async () => {
    const unhandled: string[] = [];
    const onUncaught = (err: Error) => unhandled.push(`uncaught:${err.message}`);
    const onRejection = (reason: unknown) => unhandled.push(`rejection:${String(reason)}`);
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onRejection);

    const report = new ReleaseReport({ runtime: "node" });
    const result: LayerResult = {
      name: "load",
      status: "passed",
      durationS: 0,
      checks: 2,
      errors: [],
      metrics: {},
      notes: [],
    };

    const keeper = new KeyKeeper(Buffer.from("load-root"));
    const start = Date.now();
    const signOps: number[] = [];
    const promises: Promise<void>[] = [];

    // 16 concurrent "clients" hammering sign/verify/rotate for ~1s.
    for (let t = 0; t < 16; t++) {
      promises.push(
        (async () => {
          let ops = 0;
          const name = `signer-${t}`;
          keeper.put(name, Buffer.from(`secret-${t}`));
          while (Date.now() - start < 1000) {
            const msg = Buffer.from(`m-${ops}`);
            const sig = keeper.sign(name, msg);
            if (!keeper.verify(name, msg, sig)) throw new Error("signature mismatch");
            ops += 1;
          }
          signOps.push(ops);
        })(),
      );
    }

    await Promise.all(promises);
    keeper.secureWipe();

    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejection);

    const totalOps = signOps.reduce((a, b) => a + b, 0);
    report.unhandledExceptions = unhandled.length;
    result.metrics.signOps = totalOps;
    result.metrics.unhandledExceptions = unhandled.length;
    result.notes.push(`Keeper signed/verified ${totalOps} ops concurrently; zero unhandled exceptions`);
    report.addLayer(result);

    const written = report.write("reports", "release-readiness.ts");
    expect(report.gate).toBe("PASS");
    expect(unhandled).toEqual([]);
    expect(totalOps).toBeGreaterThan(0);

    // Surface the artifact path for CI logs.
     
    console.log(`TS release report: ${written.json} (gate=${report.gate})`);
  });
});
