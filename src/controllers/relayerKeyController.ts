import { Request, Response } from 'express';
import { sendApiError } from '../lib/apiError.js';
import { getRelayerKeyService, RelayerKeyError } from '../services/relayerKeyService';
import { getDekRotationService } from '../services/dekRotationService';
import { triggerManualRotation } from '../jobs/dekRotationJob';
import { logger } from '../utils/logger';

/**
 * Admin API Controller for Relayer Key Management
 * 
 * Endpoints:
 * - POST   /admin/relayers/:id/keys         - Generate new key pair
 * - GET    /admin/relayers/:id/keys         - Get key information
 * - PUT    /admin/relayers/:id/keys/rotate  - Rotate key pair
 * - DELETE /admin/relayers/:id/keys         - Delete key pair
 * - POST   /admin/relayers/:id/keys/validate - Validate encrypted key
 * - GET    /admin/relayers/keys             - List all relayer keys
 * - GET    /admin/relayers/keys/rotation-stats - Get DEK rotation statistics
 * - POST   /admin/relayers/keys/rotate-deks - Trigger manual DEK rotation
 */

/**
 * POST /admin/relayers/:id/keys
 * Generate and store a new Ed25519 key pair for a relayer
 */
export const generateRelayerKeys = async (req: Request, res: Response): Promise<void> => {
  try {
    const relayerId = parseInt(req.params.id);
    const { force } = req.query;

    if (isNaN(relayerId)) {
      sendApiError(res, 400, 'INVALID_RELAYER_ID', 'Relayer ID must be a number');
      return;
    }

    logger.info(`[RelayerKeyController] Generating keys for relayer ${relayerId} (force=${force})`);

    const keyService = getRelayerKeyService();
    const keyInfo = await keyService.generateAndStoreKeyPair(relayerId, {
      force: force === 'true',
    });

    res.status(201).json({
      success: true,
      message: 'Key pair generated and stored successfully',
      data: {
        relayerId: keyInfo.relayerId,
        relayerName: keyInfo.relayerName,
        publicKey: keyInfo.publicKey,
        dekVersion: keyInfo.dekVersion,
        keyGeneratedAt: keyInfo.keyGeneratedAt,
        dekRotationScheduledAt: keyInfo.dekRotationScheduledAt,
      },
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to generate keys:', error);

    if (error instanceof RelayerKeyError) {
      if (error.code === 'RELAYER_NOT_FOUND') {
        sendApiError(res, 404, 'RELAYER_NOT_FOUND', error.message);
      } else if (error.code === 'KEY_ALREADY_EXISTS') {
        sendApiError(res, 409, 'KEY_ALREADY_EXISTS', error.message);
      } else {
        sendApiError(res, 500, error.code, error.message);
      }
    } else {
      sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to generate key pair');
    }
  }
};

/**
 * GET /admin/relayers/:id/keys
 * Get key information for a relayer (without exposing private key)
 */
export const getRelayerKeyInfo = async (req: Request, res: Response): Promise<void> => {
  try {
    const relayerId = parseInt(req.params.id);

    if (isNaN(relayerId)) {
      sendApiError(res, 400, 'INVALID_RELAYER_ID', 'Relayer ID must be a number');
      return;
    }

    const keyService = getRelayerKeyService();
    const keyInfo = await keyService.getKeyInfo(relayerId);

    if (!keyInfo) {
      sendApiError(res, 404, 'RELAYER_NOT_FOUND', `Relayer ${relayerId} not found`);
      return;
    }

    res.json({
      success: true,
      data: {
        relayerId: keyInfo.relayerId,
        relayerName: keyInfo.relayerName,
        publicKey: keyInfo.publicKey,
        hasPrivateKey: keyInfo.hasPrivateKey,
        dekVersion: keyInfo.dekVersion,
        keyGeneratedAt: keyInfo.keyGeneratedAt,
        dekEncryptedAt: keyInfo.dekEncryptedAt,
        dekRotationScheduledAt: keyInfo.dekRotationScheduledAt,
      },
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to get key info:', error);
    sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to retrieve key information');
  }
};

/**
 * PUT /admin/relayers/:id/keys/rotate
 * Rotate a relayer's key pair (generates new keys)
 */
export const rotateRelayerKeys = async (req: Request, res: Response): Promise<void> => {
  try {
    const relayerId = parseInt(req.params.id);

    if (isNaN(relayerId)) {
      sendApiError(res, 400, 'INVALID_RELAYER_ID', 'Relayer ID must be a number');
      return;
    }

    logger.warn(`[RelayerKeyController] Rotating key pair for relayer ${relayerId}`);

    const keyService = getRelayerKeyService();
    const keyInfo = await keyService.rotateKeyPair(relayerId);

    res.json({
      success: true,
      message: 'Key pair rotated successfully',
      data: {
        relayerId: keyInfo.relayerId,
        relayerName: keyInfo.relayerName,
        publicKey: keyInfo.publicKey,
        dekVersion: keyInfo.dekVersion,
        keyGeneratedAt: keyInfo.keyGeneratedAt,
        dekRotationScheduledAt: keyInfo.dekRotationScheduledAt,
      },
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to rotate keys:', error);

    if (error instanceof RelayerKeyError) {
      if (error.code === 'RELAYER_NOT_FOUND') {
        sendApiError(res, 404, 'RELAYER_NOT_FOUND', error.message);
      } else {
        sendApiError(res, 500, error.code, error.message);
      }
    } else {
      sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to rotate key pair');
    }
  }
};

/**
 * DELETE /admin/relayers/:id/keys
 * Delete a relayer's key pair (irreversible)
 */
export const deleteRelayerKeys = async (req: Request, res: Response): Promise<void> => {
  try {
    const relayerId = parseInt(req.params.id);
    const { confirm } = req.query;

    if (isNaN(relayerId)) {
      sendApiError(res, 400, 'INVALID_RELAYER_ID', 'Relayer ID must be a number');
      return;
    }

    if (confirm !== 'true') {
      sendApiError(
        res,
        400,
        'CONFIRMATION_REQUIRED',
        'Add ?confirm=true to confirm key deletion',
      );
      return;
    }

    logger.warn(`[RelayerKeyController] Deleting key pair for relayer ${relayerId}`);

    const keyService = getRelayerKeyService();
    await keyService.deleteKeyPair(relayerId);

    res.json({
      success: true,
      message: 'Key pair deleted successfully',
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to delete keys:', error);

    if (error instanceof RelayerKeyError) {
      if (error.code === 'RELAYER_NOT_FOUND') {
        sendApiError(res, 404, 'RELAYER_NOT_FOUND', error.message);
      } else {
        sendApiError(res, 500, error.code, error.message);
      }
    } else {
      sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to delete key pair');
    }
  }
};

/**
 * POST /admin/relayers/:id/keys/validate
 * Validate that encrypted key can be decrypted successfully
 */
export const validateRelayerKey = async (req: Request, res: Response): Promise<void> => {
  try {
    const relayerId = parseInt(req.params.id);

    if (isNaN(relayerId)) {
      sendApiError(res, 400, 'INVALID_RELAYER_ID', 'Relayer ID must be a number');
      return;
    }

    logger.info(`[RelayerKeyController] Validating encrypted key for relayer ${relayerId}`);

    const keyService = getRelayerKeyService();
    const isValid = await keyService.validateEncryptedKey(relayerId);

    res.json({
      success: true,
      message: 'Key validation successful',
      data: {
        relayerId,
        isValid,
      },
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Key validation failed:', error);

    if (error instanceof RelayerKeyError) {
      if (error.code === 'RELAYER_NOT_FOUND') {
        sendApiError(res, 404, 'RELAYER_NOT_FOUND', error.message);
      } else if (error.code === 'NO_PRIVATE_KEY') {
        sendApiError(res, 404, 'NO_PRIVATE_KEY', error.message);
      } else {
        sendApiError(res, 500, 'VALIDATION_FAILED', error.message);
      }
    } else {
      sendApiError(res, 500, 'VALIDATION_FAILED', 'Key validation failed');
    }
  }
};

/**
 * GET /admin/relayers/keys
 * List all relayers with their key information
 */
export const listAllRelayerKeys = async (req: Request, res: Response): Promise<void> => {
  try {
    const keyService = getRelayerKeyService();
    const keys = await keyService.listAllKeys();

    res.json({
      success: true,
      data: {
        total: keys.length,
        relayers: keys.map((key) => ({
          relayerId: key.relayerId,
          relayerName: key.relayerName,
          publicKey: key.publicKey,
          hasPrivateKey: key.hasPrivateKey,
          dekVersion: key.dekVersion,
          keyGeneratedAt: key.keyGeneratedAt,
          dekEncryptedAt: key.dekEncryptedAt,
          dekRotationScheduledAt: key.dekRotationScheduledAt,
        })),
      },
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to list keys:', error);
    sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to list relayer keys');
  }
};

/**
 * GET /admin/relayers/keys/rotation-stats
 * Get DEK rotation statistics for monitoring
 */
export const getRotationStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const rotationService = getDekRotationService();
    const stats = await rotationService.getRotationStats();

    // Find severely overdue relayers
    const severelyOverdue = await rotationService.findSeverelyOverdueRelayers(24);

    res.json({
      success: true,
      data: {
        totalWithKeys: stats.totalWithKeys,
        overdueCount: stats.overdueCount,
        upcomingCount: stats.upcomingCount,
        neverRotatedCount: stats.neverRotatedCount,
        severelyOverdue: severelyOverdue.map((r) => ({
          id: r.id,
          name: r.name,
          dekVersion: r.dekVersion,
          dekEncryptedAt: r.dekEncryptedAt,
          dekRotationScheduledAt: r.dekRotationScheduledAt,
        })),
      },
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to get rotation stats:', error);
    sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to retrieve rotation statistics');
  }
};

/**
 * POST /admin/relayers/keys/rotate-deks
 * Manually trigger DEK rotation for all overdue relayers
 */
export const triggerDekRotation = async (req: Request, res: Response): Promise<void> => {
  try {
    const { dryRun, maxRelayers } = req.query;

    logger.info(
      `[RelayerKeyController] Manual DEK rotation triggered (dryRun=${dryRun}, maxRelayers=${maxRelayers})`,
    );

    const rotationService = getDekRotationService();
    const summary = await rotationService.rotateAllOverdueDeks({
      dryRun: dryRun === 'true',
      maxRelayers: maxRelayers ? parseInt(maxRelayers as string) : undefined,
    });

    res.json({
      success: true,
      message:
        summary.totalRelayers === 0
          ? 'No relayers need DEK rotation'
          : `DEK rotation completed: ${summary.rotatedCount}/${summary.totalRelayers} succeeded`,
      data: {
        totalRelayers: summary.totalRelayers,
        rotatedCount: summary.rotatedCount,
        failedCount: summary.failedCount,
        skippedCount: summary.skippedCount,
        durationMs: summary.durationMs,
        startedAt: summary.startedAt,
        completedAt: summary.completedAt,
        results: summary.results,
      },
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to trigger DEK rotation:', error);
    sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to trigger DEK rotation');
  }
};

/**
 * GET /admin/relayers/:id/public-key
 * Get public key for a relayer (convenience endpoint for signature verification)
 */
export const getRelayerPublicKey = async (req: Request, res: Response): Promise<void> => {
  try {
    const relayerId = parseInt(req.params.id);

    if (isNaN(relayerId)) {
      sendApiError(res, 400, 'INVALID_RELAYER_ID', 'Relayer ID must be a number');
      return;
    }

    const keyService = getRelayerKeyService();
    const keyInfo = await keyService.getKeyInfo(relayerId);

    if (!keyInfo) {
      sendApiError(res, 404, 'RELAYER_NOT_FOUND', `Relayer ${relayerId} not found`);
      return;
    }

    if (!keyInfo.publicKey) {
      sendApiError(res, 404, 'NO_PUBLIC_KEY', `Relayer ${keyInfo.relayerName} has no public key`);
      return;
    }

    res.json({
      success: true,
      data: {
        relayerId: keyInfo.relayerId,
        relayerName: keyInfo.relayerName,
        publicKey: keyInfo.publicKey,
      },
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to get public key:', error);
    sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to retrieve public key');
  }
};
