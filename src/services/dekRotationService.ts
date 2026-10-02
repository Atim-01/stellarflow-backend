import { PrismaClient } from '@prisma/client';
import { getKmsEnvelopeService, KmsEnvelopeError } from './kmsEnvelopeService';
import { logger } from '../utils/logger';

/**
 * DEK Rotation Service
 * 
 * Manages automatic rotation of Data Encryption Keys (DEKs) for relayer private keys.
 * 
 * Rotation Policy:
 * - DEKs are rotated every 90 days
 * - Rotation happens automatically via scheduled job
 * - During rotation, relayer keys are re-encrypted with new DEKs
 * - Old DEKs are discarded (no key history is maintained)
 * 
 * Security Benefits:
 * - Limits the exposure window if a DEK is compromised
 * - Meets compliance requirements (PCI DSS, SOC 2, etc.)
 * - Reduces cryptographic wear on encryption keys
 */

const ROTATION_INTERVAL_DAYS = 90;
const ROTATION_GRACE_PERIOD_HOURS = 24; // Allow 24 hours past due date before alerting

export interface RotationResult {
  relayerId: number;
  relayerName: string;
  success: boolean;
  oldDekVersion: number;
  newDekVersion: number;
  error?: string;
}

export interface RotationSummary {
  totalRelayers: number;
  rotatedCount: number;
  failedCount: number;
  skippedCount: number;
  results: RotationResult[];
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
}

/**
 * DekRotationService — Handles automatic DEK rotation for all relayers
 */
export class DekRotationService {
  private readonly prisma: PrismaClient;
  private isRotating: boolean = false;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || new PrismaClient();
  }

  /**
   * Finds all relayers that need DEK rotation.
   * 
   * Criteria:
   * 1. Has encrypted private key stored
   * 2. dekRotationScheduledAt is in the past (overdue)
   * 3. OR dekRotationScheduledAt is null but dekEncryptedAt is > 90 days old
   * 
   * @returns Array of relayers needing rotation
   */
  async findRelayersNeedingRotation(): Promise<any[]> {
    const now = new Date();
    const ninetyDaysAgo = new Date(now.getTime() - ROTATION_INTERVAL_DAYS * 24 * 60 * 60 * 1000);

    const relayers = await this.prisma.relayer.findMany({
      where: {
        AND: [
          { encryptedPrivateKey: { not: null } },
          { encryptedDek: { not: null } },
          {
            OR: [
              // Scheduled rotation is overdue
              { dekRotationScheduledAt: { lte: now } },
              // No scheduled rotation but DEK is old
              {
                AND: [
                  { dekRotationScheduledAt: null },
                  { dekEncryptedAt: { lte: ninetyDaysAgo } },
                ],
              },
            ],
          },
        ],
      },
      select: {
        id: true,
        name: true,
        encryptedPrivateKey: true,
        encryptedDek: true,
        dekVersion: true,
        dekEncryptedAt: true,
        dekRotationScheduledAt: true,
      },
    });

    logger.info(`[DekRotationService] Found ${relayers.length} relayers needing DEK rotation`);

    return relayers;
  }

  /**
   * Rotates the DEK for a single relayer.
   * 
   * Process:
   * 1. Fetch current encrypted key data
   * 2. Re-encrypt with new DEK using KmsEnvelopeService
   * 3. Update database with new encrypted data
   * 4. Schedule next rotation (90 days from now)
   * 
   * @param relayerId - ID of the relayer to rotate
   * @returns Rotation result
   */
  async rotateRelayerDek(relayerId: number): Promise<RotationResult> {
    const relayer = await this.prisma.relayer.findUnique({
      where: { id: relayerId },
      select: {
        id: true,
        name: true,
        encryptedPrivateKey: true,
        encryptedDek: true,
        dekVersion: true,
      },
    });

    if (!relayer) {
      return {
        relayerId,
        relayerName: 'Unknown',
        success: false,
        oldDekVersion: 0,
        newDekVersion: 0,
        error: 'Relayer not found',
      };
    }

    if (!relayer.encryptedPrivateKey || !relayer.encryptedDek) {
      return {
        relayerId,
        relayerName: relayer.name,
        success: false,
        oldDekVersion: relayer.dekVersion || 0,
        newDekVersion: relayer.dekVersion || 0,
        error: 'No encrypted key data found',
      };
    }

    try {
      logger.info(`[DekRotationService] Rotating DEK for relayer: ${relayer.name} (ID: ${relayer.id})`);

      const envelopeService = getKmsEnvelopeService();
      const oldVersion = relayer.dekVersion || 1;
      const newVersion = oldVersion + 1;

      // Re-encrypt with new DEK
      const rotatedData = await envelopeService.rotateEncryption(
        {
          ciphertext: relayer.encryptedPrivateKey,
          encryptedDek: relayer.encryptedDek,
          dekVersion: oldVersion,
        },
        newVersion,
      );

      // Calculate next rotation date (90 days from now)
      const now = new Date();
      const nextRotation = new Date(now.getTime() + ROTATION_INTERVAL_DAYS * 24 * 60 * 60 * 1000);

      // Update database with new encrypted data
      await this.prisma.relayer.update({
        where: { id: relayer.id },
        data: {
          encryptedPrivateKey: rotatedData.ciphertext,
          encryptedDek: rotatedData.encryptedDek,
          dekVersion: newVersion,
          dekEncryptedAt: now,
          dekRotationScheduledAt: nextRotation,
        },
      });

      logger.info(
        `[DekRotationService] Successfully rotated DEK for ${relayer.name}: v${oldVersion} → v${newVersion}`,
      );

      return {
        relayerId: relayer.id,
        relayerName: relayer.name,
        success: true,
        oldDekVersion: oldVersion,
        newDekVersion: newVersion,
      };
    } catch (error: any) {
      logger.error(`[DekRotationService] Failed to rotate DEK for ${relayer.name}:`, error);

      return {
        relayerId: relayer.id,
        relayerName: relayer.name,
        success: false,
        oldDekVersion: relayer.dekVersion || 0,
        newDekVersion: relayer.dekVersion || 0,
        error: error.message,
      };
    }
  }

  /**
   * Rotates DEKs for all relayers that need rotation.
   * 
   * This is the main entry point for scheduled rotation jobs.
   * 
   * @param options - Rotation options
   * @returns Summary of rotation operation
   */
  async rotateAllOverdueDeks(options?: {
    dryRun?: boolean;
    maxRelayers?: number;
  }): Promise<RotationSummary> {
    const startedAt = new Date();

    if (this.isRotating) {
      logger.warn('[DekRotationService] Rotation already in progress, skipping');
      return {
        totalRelayers: 0,
        rotatedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        results: [],
        startedAt,
        completedAt: new Date(),
        durationMs: 0,
      };
    }

    this.isRotating = true;

    try {
      logger.info('[DekRotationService] Starting DEK rotation job...');

      // Find relayers needing rotation
      const relayers = await this.findRelayersNeedingRotation();
      const relayersToRotate = options?.maxRelayers
        ? relayers.slice(0, options.maxRelayers)
        : relayers;

      if (relayersToRotate.length === 0) {
        logger.info('[DekRotationService] No relayers need DEK rotation');
        return {
          totalRelayers: 0,
          rotatedCount: 0,
          failedCount: 0,
          skippedCount: 0,
          results: [],
          startedAt,
          completedAt: new Date(),
          durationMs: new Date().getTime() - startedAt.getTime(),
        };
      }

      if (options?.dryRun) {
        logger.info(`[DekRotationService] DRY RUN: Would rotate ${relayersToRotate.length} relayers`);
        relayersToRotate.forEach((r) => {
          logger.info(`  - ${r.name} (ID: ${r.id}, DEK v${r.dekVersion || 1})`);
        });

        return {
          totalRelayers: relayersToRotate.length,
          rotatedCount: 0,
          failedCount: 0,
          skippedCount: relayersToRotate.length,
          results: [],
          startedAt,
          completedAt: new Date(),
          durationMs: new Date().getTime() - startedAt.getTime(),
        };
      }

      // Rotate each relayer (sequential to avoid KMS rate limits)
      const results: RotationResult[] = [];
      for (const relayer of relayersToRotate) {
        const result = await this.rotateRelayerDek(relayer.id);
        results.push(result);

        // Add small delay between rotations to respect KMS rate limits
        await this.sleep(100);
      }

      const completedAt = new Date();
      const rotatedCount = results.filter((r) => r.success).length;
      const failedCount = results.filter((r) => !r.success).length;

      logger.info(
        `[DekRotationService] DEK rotation completed: ${rotatedCount} succeeded, ${failedCount} failed`,
      );

      return {
        totalRelayers: relayersToRotate.length,
        rotatedCount,
        failedCount,
        skippedCount: 0,
        results,
        startedAt,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      };
    } finally {
      this.isRotating = false;
    }
  }

  /**
   * Checks if any relayers have severely overdue DEK rotations.
   * 
   * @param gracePeriodHours - Hours past due date before considering "severely overdue"
   * @returns Array of overdue relayers
   */
  async findSeverelyOverdueRelayers(
    gracePeriodHours: number = ROTATION_GRACE_PERIOD_HOURS,
  ): Promise<any[]> {
    const cutoffDate = new Date(Date.now() - gracePeriodHours * 60 * 60 * 1000);

    const overdue = await this.prisma.relayer.findMany({
      where: {
        AND: [
          { encryptedPrivateKey: { not: null } },
          { dekRotationScheduledAt: { not: null } },
          { dekRotationScheduledAt: { lte: cutoffDate } },
        ],
      },
      select: {
        id: true,
        name: true,
        dekVersion: true,
        dekEncryptedAt: true,
        dekRotationScheduledAt: true,
      },
    });

    if (overdue.length > 0) {
      logger.warn(
        `[DekRotationService] Found ${overdue.length} relayers with severely overdue DEK rotations`,
      );
    }

    return overdue;
  }

  /**
   * Schedules the next rotation for a relayer (called after manual key updates).
   * 
   * @param relayerId - ID of the relayer
   * @param daysFromNow - Days until next rotation (default: 90)
   */
  async scheduleNextRotation(relayerId: number, daysFromNow: number = ROTATION_INTERVAL_DAYS): Promise<void> {
    const nextRotation = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);

    await this.prisma.relayer.update({
      where: { id: relayerId },
      data: { dekRotationScheduledAt: nextRotation },
    });

    logger.info(`[DekRotationService] Scheduled next rotation for relayer ${relayerId} at ${nextRotation.toISOString()}`);
  }

  /**
   * Returns rotation statistics for monitoring.
   */
  async getRotationStats(): Promise<{
    totalWithKeys: number;
    overdueCount: number;
    upcomingCount: number;
    neverRotatedCount: number;
  }> {
    const now = new Date();
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [totalWithKeys, overdueCount, upcomingCount, neverRotatedCount] = await Promise.all([
      this.prisma.relayer.count({
        where: {
          AND: [
            { encryptedPrivateKey: { not: null } },
            { encryptedDek: { not: null } },
          ],
        },
      }),
      this.prisma.relayer.count({
        where: {
          AND: [
            { encryptedPrivateKey: { not: null } },
            { dekRotationScheduledAt: { not: null } },
            { dekRotationScheduledAt: { lte: now } },
          ],
        },
      }),
      this.prisma.relayer.count({
        where: {
          AND: [
            { encryptedPrivateKey: { not: null } },
            { dekRotationScheduledAt: { not: null } },
            { dekRotationScheduledAt: { gt: now } },
            { dekRotationScheduledAt: { lte: sevenDaysFromNow } },
          ],
        },
      }),
      this.prisma.relayer.count({
        where: {
          AND: [
            { encryptedPrivateKey: { not: null } },
            { dekRotationScheduledAt: null },
          ],
        },
      }),
    ]);

    return {
      totalWithKeys,
      overdueCount,
      upcomingCount,
      neverRotatedCount,
    };
  }

  /**
   * Helper to sleep for rate limiting
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Returns the rotation interval in days
   */
  static getRotationIntervalDays(): number {
    return ROTATION_INTERVAL_DAYS;
  }

  /**
   * Closes the Prisma client connection
   */
  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

// Singleton instance
let rotationServiceInstance: DekRotationService | null = null;

/**
 * Gets or creates the singleton DekRotationService instance
 */
export function getDekRotationService(): DekRotationService {
  if (!rotationServiceInstance) {
    rotationServiceInstance = new DekRotationService();
  }
  return rotationServiceInstance;
}

/**
 * Sets a custom DekRotationService instance (for testing)
 */
export function setDekRotationService(service: DekRotationService): void {
  rotationServiceInstance = service;
}

/**
 * Resets the singleton instance (for testing)
 */
export function resetDekRotationService(): void {
  rotationServiceInstance = null;
}
