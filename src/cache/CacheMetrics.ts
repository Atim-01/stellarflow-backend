import { Router } from "express";
import { sendApiError } from "../lib/apiError.js";
import { cacheService } from "./CacheService";
import { CacheInvalidation } from "./CacheInvalidation";
import { getCacheInvalidationManager } from "./CacheInvalidationManager";
import { getRedisClient } from "../lib/redis";

const router = Router();

/**
 * @swagger
 * /api/v1/cache/metrics:
 *   get:
 *     tags:
 *       - Cache
 *     summary: Get cache performance metrics
 *     description: Retrieve cache hit/miss statistics and performance data
 *     responses:
 *       '200':
 *         description: Successfully retrieved cache metrics
 */
router.get("/metrics", (req, res) => {
  try {
    const metrics = cacheService.getMetrics();
    const redis = getRedisClient();

    res.json({
      success: true,
      data: {
        ...metrics,
        redis: {
          connected: redis?.isOpen ?? false,
        },
        invalidations: getCacheInvalidationManager().getMetrics(),
      },
    });
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      typeof (error instanceof Error
        ? error.message
        : "Failed to get metrics") === "string"
        ? String(
            error instanceof Error ? error.message : "Failed to get metrics",
          )
        : undefined,
    );
  }
});

/**
 * @swagger
 * /api/v1/cache/clear:
 *   post:
 *     tags:
 *       - Cache
 *     summary: Clear all cache
 *     description: Clear both L1 and L2 cache layers
 *     responses:
 *       '200':
 *         description: Cache cleared successfully
 */
router.post("/clear", async (req, res) => {
  try {
    await CacheInvalidation.clearAll();
    res.json({
      success: true,
      message: "Cache cleared successfully",
    });
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      typeof (error instanceof Error
        ? error.message
        : "Failed to clear cache") === "string"
        ? String(
            error instanceof Error ? error.message : "Failed to clear cache",
          )
        : undefined,
    );
  }
});

/**
 * @swagger
 * /api/v1/cache/health:
 *   get:
 *     tags:
 *       - Cache
 *     summary: Check cache health
 *     description: Check the health status of cache layers
 *     responses:
 *       '200':
 *         description: Cache health status
 */
router.get("/health", async (req, res) => {
  try {
    const redis = getRedisClient();
    const redisConnected = redis?.isOpen ?? false;

    let redisPing = false;
    if (redisConnected) {
      try {
        await redis!.ping();
        redisPing = true;
      } catch {
        redisPing = false;
      }
    }

    res.json({
      success: true,
      data: {
        l1Cache: { healthy: true },
        l2Cache: {
          healthy: redisConnected && redisPing,
          connected: redisConnected,
        },
      },
    });
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      typeof (error instanceof Error
        ? error.message
        : "Health check failed") === "string"
        ? String(error instanceof Error ? error.message : "Health check failed")
        : undefined,
    );
  }
});

export default router;
