import cron from 'node-cron';
import { getDekRotationService } from '../services/dekRotationService';
import { logger } from '../utils/logger';

/**
 * DEK Rotation Scheduled Job
 * 
 * Runs automatic DEK rotation for all relayers on a daily schedule.
 * 
 * Schedule: Daily at 2:00 AM UTC
 * - Low-traffic time for most systems
 * - Allows time for monitoring before business hours
 * 
 * The job:
 * 1. Finds all relayers with overdue DEK rotations
 * 2. Rotates their DEKs sequentially
 * 3. Logs results for monitoring
 * 4. Alerts on failures
 */

let isJobRunning = false;
let scheduledJob: cron.ScheduledTask | null = null;

/**
 * Executes the DEK rotation job
 */
export async function runDekRotationJob(): Promise<void> {
  if (isJobRunning) {
    logger.warn('[DekRotationJob] Job already running, skipping this execution');
    return;
  }

  isJobRunning = true;
  const startTime = Date.now();

  try {
    logger.info('[DekRotationJob] Starting scheduled DEK rotation...');

    const rotationService = getDekRotationService();

    // Check for severely overdue rotations first (for alerting)
    const severelyOverdue = await rotationService.findSeverelyOverdueRelayers(24);
    if (severelyOverdue.length > 0) {
      logger.error(
        `[DekRotationJob] ALERT: ${severelyOverdue.length} relayers have severely overdue DEK rotations (>24h past due)`,
      );
      severelyOverdue.forEach((relayer) => {
        logger.error(
          `  - ${relayer.name} (ID: ${relayer.id}): scheduled for ${relayer.dekRotationScheduledAt?.toISOString()}`,
        );
      });
    }

    // Get rotation stats before running
    const statsBefore = await rotationService.getRotationStats();
    logger.info(
      `[DekRotationJob] Rotation stats: ${statsBefore.overdueCount} overdue, ${statsBefore.upcomingCount} upcoming (next 7 days)`,
    );

    // Run the rotation
    const summary = await rotationService.rotateAllOverdueDeks();

    const duration = Date.now() - startTime;

    if (summary.totalRelayers === 0) {
      logger.info('[DekRotationJob] No DEKs needed rotation');
    } else {
      logger.info(
        `[DekRotationJob] Rotation completed in ${duration}ms: ${summary.rotatedCount}/${summary.totalRelayers} succeeded`,
      );

      // Log failures for investigation
      if (summary.failedCount > 0) {
        logger.error(`[DekRotationJob] ${summary.failedCount} rotations failed:`);
        summary.results
          .filter((r) => !r.success)
          .forEach((result) => {
            logger.error(`  - ${result.relayerName} (ID: ${result.relayerId}): ${result.error}`);
          });
      }

      // Log successes at debug level
      if (summary.rotatedCount > 0) {
        logger.debug('[DekRotationJob] Successfully rotated DEKs for:');
        summary.results
          .filter((r) => r.success)
          .forEach((result) => {
            logger.debug(
              `  - ${result.relayerName} (ID: ${result.relayerId}): v${result.oldDekVersion} → v${result.newDekVersion}`,
            );
          });
      }
    }

    // Get stats after rotation
    const statsAfter = await rotationService.getRotationStats();
    logger.info(
      `[DekRotationJob] Post-rotation stats: ${statsAfter.overdueCount} overdue remaining, ${statsAfter.totalWithKeys} total with keys`,
    );

    // Alert if there are still overdue rotations after job completion
    if (statsAfter.overdueCount > 0) {
      logger.warn(
        `[DekRotationJob] WARNING: ${statsAfter.overdueCount} relayers still have overdue rotations after job completion`,
      );
    }
  } catch (error: any) {
    logger.error('[DekRotationJob] Job failed with error:', error);
    // Don't throw - we want the cron to continue running
  } finally {
    isJobRunning = false;
  }
}

/**
 * Starts the scheduled DEK rotation job
 * 
 * @param cronExpression - Optional custom cron expression (default: daily at 2 AM UTC)
 * @returns The scheduled task instance
 */
export function startDekRotationJob(cronExpression?: string): cron.ScheduledTask {
  // Default: Run daily at 2:00 AM UTC
  // Format: minute hour day month weekday
  const schedule = cronExpression || '0 2 * * *';

  if (scheduledJob) {
    logger.warn('[DekRotationJob] Job already scheduled, stopping previous instance');
    scheduledJob.stop();
  }

  logger.info(`[DekRotationJob] Scheduling DEK rotation job with cron: ${schedule}`);

  scheduledJob = cron.schedule(
    schedule,
    async () => {
      await runDekRotationJob();
    },
    {
      timezone: 'UTC',
      scheduled: true,
    },
  );

  logger.info('[DekRotationJob] DEK rotation job scheduled successfully');

  return scheduledJob;
}

/**
 * Stops the scheduled DEK rotation job
 */
export function stopDekRotationJob(): void {
  if (scheduledJob) {
    scheduledJob.stop();
    scheduledJob = null;
    logger.info('[DekRotationJob] DEK rotation job stopped');
  } else {
    logger.warn('[DekRotationJob] No job to stop');
  }
}

/**
 * Returns whether the job is currently running
 */
export function isDekRotationJobRunning(): boolean {
  return isJobRunning;
}

/**
 * Returns the scheduled task instance (for monitoring)
 */
export function getScheduledTask(): cron.ScheduledTask | null {
  return scheduledJob;
}

/**
 * Manually triggers the rotation job (for testing or manual intervention)
 */
export async function triggerManualRotation(): Promise<void> {
  logger.info('[DekRotationJob] Manual rotation triggered');
  await runDekRotationJob();
}
