import { PrismaClient, Relayer } from '@prisma/client';
import { Keypair } from '@stellar/stellar-sdk';
import { getKmsEnvelopeService, EncryptedData } from './kmsEnvelopeService';
import { getDekRotationService } from './dekRotationService';
import { vault, VaultContext } from '../crypto/vault';
import { logger } from '../utils/logger';
import * as crypto from 'crypto';

/**
 * Relayer Key Management Service
 * 
 * Manages the complete lifecycle of relayer Ed25519 key pairs:
 * - Generation of new key pairs
 * - Encryption using KMS envelope encryption
 * - Secure storage in database
 * - Decryption and retrieval for signing operations
 * - Key rotation
 * 
 * Security Features:
 * - All private keys encrypted with unique DEKs
 * - DEKs protected by AWS KMS
 * - Plaintext keys never touch disk
 * - Zero-wipe after use
 * - Audit logging for all key operations
 */

const VAULT_KEY_PREFIX = 'relayer-key-';
const ROTATION_INTERVAL_DAYS = 90;

export interface RelayerKeyPair {
  publicKey: string; // Stellar G... address
  privateKey: string; // Stellar S... secret key
}

export interface RelayerKeyInfo {
  relayerId: number;
  relayerName: string;
  publicKey: string;
  hasPrivateKey: boolean;
  dekVersion: number;
  keyGeneratedAt: Date | null;
  dekEncryptedAt: Date | null;
  dekRotationScheduledAt: Date | null;
}

/**
 * Custom error for relayer key operations
 */
export class RelayerKeyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly relayerId?: number,
  ) {
    super(message);
    this.name = 'RelayerKeyError';
  }
}

/**
 * RelayerKeyService — Manages encrypted Ed25519 keys for relayers
 */
export class RelayerKeyService {
  private readonly prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || new PrismaClient();
  }

  /**
   * Generates a new Ed25519 key pair for a relayer and stores it encrypted.
   * 
   * Process:
   * 1. Generate Ed25519 key pair using Stellar SDK
   * 2. Encrypt private key using KMS envelope encryption
   * 3. Store encrypted key + public key in database
   * 4. Schedule first DEK rotation (90 days from now)
   * 5. Return public key (private key is securely stored)
   * 
   * @param relayerId - ID of the relayer
   * @param options - Optional configuration
   * @returns Relayer key information
   * @throws RelayerKeyError if generation or storage fails
   */
  async generateAndStoreKeyPair(
    relayerId: number,
    options?: { force?: boolean },
  ): Promise<RelayerKeyInfo> {
    const relayer = await this.prisma.relayer.findUnique({
      where: { id: relayerId },
      select: {
        id: true,
        name: true,
        encryptedPrivateKey: true,
        publicKey: true,
      },
    });

    if (!relayer) {
      throw new RelayerKeyError('Relayer not found', 'RELAYER_NOT_FOUND', relayerId);
    }

    // Check if key already exists
    if (relayer.encryptedPrivateKey && !options?.force) {
      throw new RelayerKeyError(
        `Relayer '${relayer.name}' already has a key pair. Use force=true to regenerate.`,
        'KEY_ALREADY_EXISTS',
        relayerId,
      );
    }

    try {
      logger.info(`[RelayerKeyService] Generating new key pair for relayer: ${relayer.name} (ID: ${relayer.id})`);

      // Step 1: Generate Ed25519 key pair
      const keypair = Keypair.random();
      const publicKey = keypair.publicKey();
      const privateKeyHex = keypair.secret();

      // Step 2: Encrypt private key with envelope encryption
      const envelopeService = getKmsEnvelopeService();
      const encryptedData = await envelopeService.encrypt(privateKeyHex, 1);

      // Step 3: Calculate rotation schedule
      const now = new Date();
      const nextRotation = new Date(now.getTime() + ROTATION_INTERVAL_DAYS * 24 * 60 * 60 * 1000);

      // Step 4: Store in database
      const updated = await this.prisma.relayer.update({
        where: { id: relayer.id },
        data: {
          publicKey: publicKey,
          encryptedPrivateKey: encryptedData.ciphertext,
          encryptedDek: encryptedData.encryptedDek,
          dekVersion: encryptedData.dekVersion,
          dekEncryptedAt: now,
          dekRotationScheduledAt: nextRotation,
          keyGeneratedAt: now,
        },
      });

      logger.info(
        `[RelayerKeyService] Key pair generated and stored for ${relayer.name}. Public key: ${publicKey.substring(0, 8)}...`,
      );

      // Log audit event
      await this.logKeyOperation(relayer.id, relayer.name, 'KEY_GENERATED', {
        publicKey,
        dekVersion: encryptedData.dekVersion,
      });

      return {
        relayerId: updated.id,
        relayerName: updated.name,
        publicKey: updated.publicKey!,
        hasPrivateKey: true,
        dekVersion: updated.dekVersion || 1,
        keyGeneratedAt: updated.keyGeneratedAt,
        dekEncryptedAt: updated.dekEncryptedAt,
        dekRotationScheduledAt: updated.dekRotationScheduledAt,
      };
    } catch (error: any) {
      logger.error(`[RelayerKeyService] Failed to generate key pair for ${relayer.name}:`, error);
      throw new RelayerKeyError(
        `Failed to generate key pair: ${error.message}`,
        'KEY_GENERATION_FAILED',
        relayerId,
      );
    }
  }

  /**
   * Retrieves and decrypts a relayer's private key for signing operations.
   * 
   * Security:
   * - Key is loaded into secure vault (in-memory only)
   * - Vault access requires context token
   * - Caller must explicitly close context after use
   * - Key is zero-wiped when vault context is closed
   * 
   * @param relayerId - ID of the relayer
   * @returns Vault context for accessing the private key
   * @throws RelayerKeyError if key doesn't exist or decryption fails
   */
  async retrievePrivateKey(relayerId: number): Promise<VaultContext> {
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
      throw new RelayerKeyError('Relayer not found', 'RELAYER_NOT_FOUND', relayerId);
    }

    if (!relayer.encryptedPrivateKey || !relayer.encryptedDek) {
      throw new RelayerKeyError(
        `No private key found for relayer '${relayer.name}'`,
        'NO_PRIVATE_KEY',
        relayerId,
      );
    }

    try {
      logger.debug(`[RelayerKeyService] Retrieving private key for relayer: ${relayer.name}`);

      // Decrypt private key using envelope encryption
      const envelopeService = getKmsEnvelopeService();
      const privateKeyHex = await envelopeService.decrypt({
        ciphertext: relayer.encryptedPrivateKey,
        encryptedDek: relayer.encryptedDek,
        dekVersion: relayer.dekVersion || 1,
      });

      // Store in vault with scoped access
      const vaultKeyId = `${VAULT_KEY_PREFIX}${relayer.id}`;
      
      // Revoke any existing key first (in case of stale vault entry)
      try {
        vault.revoke(vaultKeyId);
      } catch {
        // Ignore if key doesn't exist
      }

      vault.register(vaultKeyId, privateKeyHex);

      // Create context for scoped access
      const context = vault.openContext(`relayer-${relayer.id}-signing`);

      logger.debug(`[RelayerKeyService] Private key loaded into vault for ${relayer.name}`);

      return context;
    } catch (error: any) {
      logger.error(`[RelayerKeyService] Failed to retrieve private key for ${relayer.name}:`, error);
      throw new RelayerKeyError(
        `Failed to retrieve private key: ${error.message}`,
        'KEY_RETRIEVAL_FAILED',
        relayerId,
      );
    }
  }

  /**
   * Gets the private key from vault using a context.
   * 
   * @param relayerId - ID of the relayer
   * @param context - Vault context from retrievePrivateKey()
   * @returns Private key (Stellar S... secret)
   */
  getPrivateKeyFromVault(relayerId: number, context: VaultContext): string {
    const vaultKeyId = `${VAULT_KEY_PREFIX}${relayerId}`;
    return vault.retrieve(vaultKeyId, context);
  }

  /**
   * Closes vault context and revokes private key from memory.
   * 
   * IMPORTANT: Always call this in a finally block after using a private key.
   * 
   * @param relayerId - ID of the relayer
   * @param context - Vault context to close
   */
  revokePrivateKey(relayerId: number, context: VaultContext): void {
    try {
      vault.closeContext(context);
      const vaultKeyId = `${VAULT_KEY_PREFIX}${relayerId}`;
      vault.revoke(vaultKeyId);
      logger.debug(`[RelayerKeyService] Private key revoked from vault for relayer ${relayerId}`);
    } catch (error: any) {
      logger.error(`[RelayerKeyService] Failed to revoke key for relayer ${relayerId}:`, error);
    }
  }

  /**
   * Helper method to use a private key with automatic cleanup.
   * 
   * Example:
   * ```typescript
   * const signature = await keyService.withPrivateKey(relayerId, async (privateKey) => {
   *   const keypair = Keypair.fromSecret(privateKey);
   *   return keypair.sign(txHash);
   * });
   * ```
   * 
   * @param relayerId - ID of the relayer
   * @param callback - Async function that uses the private key
   * @returns Result from callback
   */
  async withPrivateKey<T>(
    relayerId: number,
    callback: (privateKey: string) => Promise<T>,
  ): Promise<T> {
    const context = await this.retrievePrivateKey(relayerId);
    try {
      const privateKey = this.getPrivateKeyFromVault(relayerId, context);
      return await callback(privateKey);
    } finally {
      this.revokePrivateKey(relayerId, context);
    }
  }

  /**
   * Rotates a relayer's key pair (generates new keys, stores encrypted).
   * 
   * WARNING: This invalidates the old key pair. Ensure any pending
   * transactions using the old key are completed first.
   * 
   * @param relayerId - ID of the relayer
   * @returns New relayer key information
   */
  async rotateKeyPair(relayerId: number): Promise<RelayerKeyInfo> {
    const relayer = await this.prisma.relayer.findUnique({
      where: { id: relayerId },
      select: { id: true, name: true, publicKey: true },
    });

    if (!relayer) {
      throw new RelayerKeyError('Relayer not found', 'RELAYER_NOT_FOUND', relayerId);
    }

    logger.warn(
      `[RelayerKeyService] Rotating key pair for ${relayer.name}. Old public key: ${relayer.publicKey?.substring(0, 8)}...`,
    );

    const oldPublicKey = relayer.publicKey;

    // Generate new key pair (force=true to replace existing)
    const result = await this.generateAndStoreKeyPair(relayerId, { force: true });

    // Log audit event
    await this.logKeyOperation(relayer.id, relayer.name, 'KEY_ROTATED', {
      oldPublicKey,
      newPublicKey: result.publicKey,
    });

    logger.info(
      `[RelayerKeyService] Key rotation completed for ${relayer.name}. New public key: ${result.publicKey.substring(0, 8)}...`,
    );

    return result;
  }

  /**
   * Gets key information for a relayer (without decrypting private key).
   * 
   * @param relayerId - ID of the relayer
   * @returns Relayer key information
   */
  async getKeyInfo(relayerId: number): Promise<RelayerKeyInfo | null> {
    const relayer = await this.prisma.relayer.findUnique({
      where: { id: relayerId },
      select: {
        id: true,
        name: true,
        publicKey: true,
        encryptedPrivateKey: true,
        dekVersion: true,
        keyGeneratedAt: true,
        dekEncryptedAt: true,
        dekRotationScheduledAt: true,
      },
    });

    if (!relayer) {
      return null;
    }

    return {
      relayerId: relayer.id,
      relayerName: relayer.name,
      publicKey: relayer.publicKey || '',
      hasPrivateKey: !!relayer.encryptedPrivateKey,
      dekVersion: relayer.dekVersion || 0,
      keyGeneratedAt: relayer.keyGeneratedAt,
      dekEncryptedAt: relayer.dekEncryptedAt,
      dekRotationScheduledAt: relayer.dekRotationScheduledAt,
    };
  }

  /**
   * Lists all relayers with their key information.
   * 
   * @returns Array of relayer key information
   */
  async listAllKeys(): Promise<RelayerKeyInfo[]> {
    const relayers = await this.prisma.relayer.findMany({
      select: {
        id: true,
        name: true,
        publicKey: true,
        encryptedPrivateKey: true,
        dekVersion: true,
        keyGeneratedAt: true,
        dekEncryptedAt: true,
        dekRotationScheduledAt: true,
      },
      orderBy: { name: 'asc' },
    });

    return relayers.map((relayer) => ({
      relayerId: relayer.id,
      relayerName: relayer.name,
      publicKey: relayer.publicKey || '',
      hasPrivateKey: !!relayer.encryptedPrivateKey,
      dekVersion: relayer.dekVersion || 0,
      keyGeneratedAt: relayer.keyGeneratedAt,
      dekEncryptedAt: relayer.dekEncryptedAt,
      dekRotationScheduledAt: relayer.dekRotationScheduledAt,
    }));
  }

  /**
   * Validates that a relayer's encrypted key can be successfully decrypted.
   * 
   * @param relayerId - ID of the relayer
   * @returns true if validation succeeds
   * @throws RelayerKeyError if validation fails
   */
  async validateEncryptedKey(relayerId: number): Promise<boolean> {
    const context = await this.retrievePrivateKey(relayerId);
    try {
      const privateKey = this.getPrivateKeyFromVault(relayerId, context);
      
      // Validate it's a proper Stellar secret key
      const keypair = Keypair.fromSecret(privateKey);
      
      // Verify public key matches database
      const relayer = await this.prisma.relayer.findUnique({
        where: { id: relayerId },
        select: { publicKey: true },
      });

      if (relayer?.publicKey && keypair.publicKey() !== relayer.publicKey) {
        throw new Error('Public key mismatch: decrypted key does not match stored public key');
      }

      return true;
    } finally {
      this.revokePrivateKey(relayerId, context);
    }
  }

  /**
   * Deletes a relayer's key pair from the database.
   * 
   * WARNING: This is irreversible. The relayer will no longer be able to sign transactions.
   * 
   * @param relayerId - ID of the relayer
   */
  async deleteKeyPair(relayerId: number): Promise<void> {
    const relayer = await this.prisma.relayer.findUnique({
      where: { id: relayerId },
      select: { id: true, name: true, publicKey: true },
    });

    if (!relayer) {
      throw new RelayerKeyError('Relayer not found', 'RELAYER_NOT_FOUND', relayerId);
    }

    logger.warn(`[RelayerKeyService] Deleting key pair for relayer: ${relayer.name}`);

    await this.prisma.relayer.update({
      where: { id: relayerId },
      data: {
        publicKey: null,
        encryptedPrivateKey: null,
        encryptedDek: null,
        dekVersion: null,
        dekEncryptedAt: null,
        dekRotationScheduledAt: null,
        keyGeneratedAt: null,
      },
    });

    // Log audit event
    await this.logKeyOperation(relayer.id, relayer.name, 'KEY_DELETED', {
      publicKey: relayer.publicKey,
    });

    logger.info(`[RelayerKeyService] Key pair deleted for ${relayer.name}`);
  }

  /**
   * Logs key operations for audit trail.
   * 
   * @param relayerId - ID of the relayer
   * @param relayerName - Name of the relayer
   * @param operation - Type of operation
   * @param details - Additional details
   */
  private async logKeyOperation(
    relayerId: number,
    relayerName: string,
    operation: string,
    details: any,
  ): Promise<void> {
    try {
      // Log to audit log table if it exists
      // For now, just log to application logger
      logger.info(`[RelayerKeyService] AUDIT: ${operation} for ${relayerName} (ID: ${relayerId})`, {
        operation,
        relayerId,
        relayerName,
        details,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('[RelayerKeyService] Failed to write audit log:', error);
    }
  }

  /**
   * Closes the Prisma client connection
   */
  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

// Singleton instance
let keyServiceInstance: RelayerKeyService | null = null;

/**
 * Gets or creates the singleton RelayerKeyService instance
 */
export function getRelayerKeyService(): RelayerKeyService {
  if (!keyServiceInstance) {
    keyServiceInstance = new RelayerKeyService();
  }
  return keyServiceInstance;
}

/**
 * Sets a custom RelayerKeyService instance (for testing)
 */
export function setRelayerKeyService(service: RelayerKeyService): void {
  keyServiceInstance = service;
}

/**
 * Resets the singleton instance (for testing)
 */
export function resetRelayerKeyService(): void {
  keyServiceInstance = null;
}
