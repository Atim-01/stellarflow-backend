import prisma from "../lib/prisma";
import { getRedisClient } from "../lib/redis";
import stellarProvider from "../lib/stellarProvider";
import { Pkcs11HsmSignerService } from "../signer/pkcs11-signer.service";
import { MockPkcs11Client } from "../signer/pkcs11/pkcs11-client";
import { signer } from "../signer";

export const READINESS_UNAVAILABLE_STATUS = 530;

export type ProbeName = "database" | "redis" | "rpc" | "hsm";

export interface ProbeResult {
  name: ProbeName;
  healthy: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

export interface ReadinessReport {
  ready: boolean;
  timestamp: string;
  checks: Partial<Record<ProbeName, boolean>>;
  errors: Partial<Record<ProbeName, string>>;
}

const DEFAULT_TIMEOUT_MS = 3_000;

function probeTimeoutMs(): number {
  const parsed = Number(process.env.HEALTH_PROBE_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

async function withTimeout<T>(
  label: ProbeName,
  work: () => Promise<T>,
): Promise<T> {
  const timeoutMs = probeTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${label} probe timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function probeDatabase(): Promise<ProbeResult> {
  try {
    await withTimeout("database", () => prisma.$queryRaw`SELECT 1`);
    return { name: "database", healthy: true };
  } catch (error) {
    return {
      name: "database",
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeRedis(): Promise<ProbeResult> {
  try {
    await withTimeout("redis", async () => {
      const redis = getRedisClient();
      if (!redis) {
        throw new Error("REDIS_URL is not configured");
      }
      if (!redis.isOpen) {
        throw new Error("Redis client is not connected");
      }
      const pong = await redis.ping();
      if (pong !== "PONG" && pong !== "pong") {
        throw new Error(`Unexpected Redis ping response: ${String(pong)}`);
      }
    });
    return { name: "redis", healthy: true };
  } catch (error) {
    return {
      name: "redis",
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeRpc(): Promise<ProbeResult> {
  try {
    await withTimeout("rpc", async () => {
      const health = await stellarProvider.getRpcServer().getHealth();
      const status =
        health && typeof health === "object" && "status" in health
          ? String((health as { status: unknown }).status).toLowerCase()
          : "";
      if (status && status !== "healthy") {
        throw new Error(`RPC status is ${status}`);
      }
    });
    return { name: "rpc", healthy: true };
  } catch (error) {
    return {
      name: "rpc",
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Automated health probe verifying PKCS#11 Hardware Security Module (HSM)
 * hardware status, token presence, authentication, and cryptographic readiness.
 */
export async function probeHsm(): Promise<ProbeResult> {
  try {
    const backend = process.env.SIGNER_BACKEND;
    const isHsm = backend === "pkcs11" || backend === "hsm";

    if (signer instanceof Pkcs11HsmSignerService) {
      const health = await withTimeout("hsm", () =>
        (signer as Pkcs11HsmSignerService).getHealth(),
      );
      return {
        name: "hsm",
        healthy: health.healthy,
        error: health.error,
        details: health as unknown as Record<string, unknown>,
      };
    }

    if (isHsm) {
      const client = new MockPkcs11Client();
      await client.initialize();
      const health = await withTimeout("hsm", () =>
        client.getHealth({
          slotId: process.env.HSM_SLOT_ID
            ? parseInt(process.env.HSM_SLOT_ID, 10)
            : 0,
          tokenLabel: process.env.HSM_TOKEN_LABEL,
          pin: process.env.HSM_PIN,
          keyLabel: process.env.HSM_KEY_LABEL || "stellar-relayer-key",
          keyId: process.env.HSM_KEY_ID,
        }),
      );
      return {
        name: "hsm",
        healthy: health.healthy,
        error: health.error,
        details: health as unknown as Record<string, unknown>,
      };
    }

    // If HSM backend is not explicitly enabled, probe passes
    return { name: "hsm", healthy: true };
  } catch (error) {
    return {
      name: "hsm",
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getReadinessReport(): Promise<ReadinessReport> {
  const backend = process.env.SIGNER_BACKEND;
  const isHsm = backend === "pkcs11" || backend === "hsm";

  const probePromises: Promise<ProbeResult>[] = [
    probeDatabase(),
    probeRedis(),
    probeRpc(),
  ];

  if (isHsm) {
    probePromises.push(probeHsm());
  }

  const probes = await Promise.all(probePromises);

  const checks: Partial<Record<ProbeName, boolean>> = {};
  const errors: Partial<Record<ProbeName, string>> = {};

  for (const probe of probes) {
    checks[probe.name] = probe.healthy;
    if (!probe.healthy && probe.error) {
      errors[probe.name] = probe.error;
    }
  }

  return {
    ready: probes.every((probe) => probe.healthy),
    timestamp: new Date().toISOString(),
    checks,
    errors,
  };
}
