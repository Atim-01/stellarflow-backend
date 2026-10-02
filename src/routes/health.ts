import { Router } from "express";
import {
  getReadinessReport,
  probeHsm,
  READINESS_UNAVAILABLE_STATUS,
  type ReadinessReport,
  type ProbeResult,
} from "../services/healthProbeService";

export function createHealthRouter(
  loadReadiness: () => Promise<ReadinessReport> = getReadinessReport,
  loadHsmHealth: () => Promise<ProbeResult> = probeHsm,
) {
  const router = Router();

  router.get("/liveness", (_req, res) => {
    res.status(200).json({
      success: true,
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  router.get("/readiness", async (_req, res) => {
    const report = await loadReadiness();

    if (!report.ready) {
      res.status(READINESS_UNAVAILABLE_STATUS).json({
        success: false,
        status: "unavailable",
        timestamp: report.timestamp,
        checks: report.checks,
        errors: report.errors,
        error: {
          code: "DEPENDENCY_UNAVAILABLE",
          message: "One or more core dependencies failed readiness probes",
          timestamp: report.timestamp,
        },
      });
      return;
    }

    res.status(200).json({
      success: true,
      status: "ready",
      timestamp: report.timestamp,
      checks: report.checks,
    });
  });

  /**
   * Automated HSM Hardware Status & Token Presence Probe endpoint
   */
  router.get("/hsm", async (_req, res) => {
    const result = await loadHsmHealth();

    if (!result.healthy) {
      res.status(503).json({
        success: false,
        status: "unhealthy",
        error: result.error || "HSM hardware or token check failed",
        details: result.details,
      });
      return;
    }

    res.status(200).json({
      success: true,
      status: "healthy",
      details: result.details,
    });
  });

  return router;
}

export default createHealthRouter();
