#!/usr/bin/env tsx
/**
 * Verification Script: Ensure Zero Unencrypted Private Keys in Database
 * 
 * This script verifies that:
 * 1. No plaintext private keys exist in the Relayer table
 * 2. All private keys are properly encrypted with KMS envelope encryption
 * 3. Database dumps would contain only encrypted data
 * 
 * Usage:
 *   tsx scripts/verify-no-plaintext-keys.ts
 *   
 * Exit codes:
 *   0 - All checks passed
 *   1 - Plaintext keys detected or validation failed
 */

import { PrismaClient } from '@prisma/client';
import { getRelayerKeyService } from '../src/services/relayerKeyService';
import { logger } from '../src/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

interface VerificationResult {
  passed: boolean;
  totalRelayers: number;
  relayersWithKeys: number;
  relayersWithEncryptedKeys: number;
  relayersWithPlaintextKeys: number;
  validationFailures: string[];
  warnings: string[];
}

/**
 * Check if a string looks like a Stellar secret key (S...)
 */
function looksLikeStellarSecret(value: string): boolean {
  if (!value) return false;
  return value.startsWith('S') && value.length === 56;
}

/**
 * Check if a string looks like plaintext (not encrypted)
 */
function looksLikePlaintext(value: string): boolean {
  if (!value) return false;
  // Encrypted data should be hex (for ciphertext) or base64 (for DEK)
  // and should be much longer than raw keys
  if (value.length < 100) return true; // Encrypted keys are much longer
  if (looksLikeStellarSecret(value)) return true;
  return false;
}

/**
 * Verify all relayers have properly encrypted keys
 */
async function verifyEncryptedKeys(): Promise<VerificationResult> {
  const result: VerificationResult = {
    passed: true,
    totalRelayers: 0,
    relayersWithKeys: 0,
    relayersWithEncryptedKeys: 0,
    relayersWithPlaintextKeys: 0,
    validationFailures: [],
    warnings: [],
  };

  try {
    logger.info('[KeyVerification] Starting verification of encrypted keys...');

    // Get all relayers
    const relayers = await prisma.relayer.findMany({
      select: {
        id: true,
        name: true,
        publicKey: true,
        encryptedPrivateKey: true,
        encryptedDek: true,
        dekVersion: true,
        dekEncryptedAt: true,
        dekRotationScheduledAt: true,
      },
    });

    result.totalRelayers = relayers.length;

    for (const relayer of relayers) {
      // Check if relayer has any key data
      const hasKeyData =
        relayer.publicKey ||
        relayer.encryptedPrivateKey ||
        relayer.encryptedDek;

      if (!hasKeyData) {
        // No keys at all - this is OK for relayers that haven't been provisioned yet
        continue;
      }

      result.relayersWithKeys++;

      // Check for plaintext private keys (critical security issue)
      if (relayer.encryptedPrivateKey) {
        if (looksLikePlaintext(relayer.encryptedPrivateKey)) {
          result.relayersWithPlaintextKeys++;
          result.validationFailures.push(
            `CRITICAL: Relayer '${relayer.name}' (ID: ${relayer.id}) has PLAINTEXT private key!`,
          );
          result.passed = false;
        } else {
          result.relayersWithEncryptedKeys++;
        }
      }

      // Validate encrypted key structure
      if (relayer.encryptedPrivateKey && !relayer.encryptedDek) {
        result.validationFailures.push(
          `ERROR: Relayer '${relayer.name}' (ID: ${relayer.id}) has encryptedPrivateKey but missing encryptedDek`,
        );
        result.passed = false;
      }

      if (relayer.encryptedDek && !relayer.encryptedPrivateKey) {
        result.warnings.push(
          `WARNING: Relayer '${relayer.name}' (ID: ${relayer.id}) has encryptedDek but missing encryptedPrivateKey`,
        );
      }

      // Validate public key format
      if (relayer.publicKey) {
        if (!relayer.publicKey.startsWith('G') || relayer.publicKey.length !== 56) {
          result.warnings.push(
            `WARNING: Relayer '${relayer.name}' (ID: ${relayer.id}) has invalid public key format`,
          );
        }
      }

      // Check for missing rotation schedule
      if (relayer.encryptedPrivateKey && !relayer.dekRotationScheduledAt) {
        result.warnings.push(
          `WARNING: Relayer '${relayer.name}' (ID: ${relayer.id}) has no DEK rotation scheduled`,
        );
      }

      // Check for overdue rotations
      if (relayer.dekRotationScheduledAt) {
        const now = new Date();
        if (relayer.dekRotationScheduledAt < now) {
          const daysOverdue = Math.floor(
            (now.getTime() - relayer.dekRotationScheduledAt.getTime()) / (1000 * 60 * 60 * 24),
          );
          result.warnings.push(
            `WARNING: Relayer '${relayer.name}' (ID: ${relayer.id}) has overdue DEK rotation (${daysOverdue} days overdue)`,
          );
        }
      }
    }

    logger.info('[KeyVerification] Verification complete');
    logger.info(`  - Total relayers: ${result.totalRelayers}`);
    logger.info(`  - Relayers with keys: ${result.relayersWithKeys}`);
    logger.info(`  - Relayers with encrypted keys: ${result.relayersWithEncryptedKeys}`);
    logger.info(`  - Relayers with PLAINTEXT keys: ${result.relayersWithPlaintextKeys}`);

    return result;
  } catch (error: any) {
    logger.error('[KeyVerification] Verification failed:', error);
    result.passed = false;
    result.validationFailures.push(`FATAL: Verification error: ${error.message}`);
    return result;
  }
}

/**
 * Simulate a database dump and check for plaintext keys
 */
async function verifyDatabaseDump(): Promise<boolean> {
  logger.info('[KeyVerification] Simulating database dump scan...');

  try {
    // Query raw data as it would appear in a pg_dump
    const rawData = await prisma.$queryRaw<any[]>`
      SELECT 
        id, 
        name, 
        "publicKey",
        "encryptedPrivateKey",
        "encryptedDek"
      FROM "Relayer"
      WHERE "encryptedPrivateKey" IS NOT NULL
    `;

    let foundPlaintext = false;

    for (const row of rawData) {
      const dump = JSON.stringify(row);

      // Check if dump contains Stellar secret key pattern
      if (dump.match(/S[A-Z0-9]{55}/)) {
        logger.error(
          `[KeyVerification] CRITICAL: Found plaintext Stellar secret in dump for relayer ${row.name} (ID: ${row.id})`,
        );
        foundPlaintext = true;
      }

      // Verify encryptedPrivateKey is hex-encoded (IV + ciphertext + tag)
      if (row.encryptedPrivateKey) {
        // Should be at least: 12 bytes IV (24 hex) + ciphertext + 16 bytes tag (32 hex) = >56 hex chars
        if (
          !/^[0-9a-f]+$/i.test(row.encryptedPrivateKey) ||
          row.encryptedPrivateKey.length < 100
        ) {
          logger.error(
            `[KeyVerification] ERROR: encryptedPrivateKey for ${row.name} doesn't look properly encrypted`,
          );
          foundPlaintext = true;
        }
      }

      // Verify encryptedDek is base64
      if (row.encryptedDek) {
        if (!/^[A-Za-z0-9+/]+=*$/.test(row.encryptedDek)) {
          logger.error(
            `[KeyVerification] ERROR: encryptedDek for ${row.name} doesn't look like base64`,
          );
          foundPlaintext = true;
        }
      }
    }

    if (!foundPlaintext) {
      logger.info('[KeyVerification] ✅ Database dump verification passed - no plaintext keys found');
    }

    return !foundPlaintext;
  } catch (error: any) {
    logger.error('[KeyVerification] Database dump verification failed:', error);
    return false;
  }
}

/**
 * Test key decryption for a sample relayer (if any exist)
 */
async function testKeyDecryption(): Promise<boolean> {
  logger.info('[KeyVerification] Testing key decryption...');

  try {
    const keyService = getRelayerKeyService();
    const keys = await keyService.listAllKeys();

    const relayersWithKeys = keys.filter((k) => k.hasPrivateKey);

    if (relayersWithKeys.length === 0) {
      logger.info('[KeyVerification] No relayers with keys to test');
      return true;
    }

    // Test first relayer with keys
    const testRelayer = relayersWithKeys[0];
    logger.info(`[KeyVerification] Testing decryption for relayer: ${testRelayer.relayerName}`);

    const isValid = await keyService.validateEncryptedKey(testRelayer.relayerId);

    if (isValid) {
      logger.info('[KeyVerification] ✅ Key decryption test passed');
    } else {
      logger.error('[KeyVerification] ❌ Key decryption test failed');
    }

    return isValid;
  } catch (error: any) {
    logger.error('[KeyVerification] Key decryption test failed:', error);
    return false;
  }
}

/**
 * Main verification function
 */
async function main() {
  console.log('\n🔒 KMS Envelope Encryption Verification\n');
  console.log('This script verifies that all relayer private keys are encrypted');
  console.log('and that no plaintext keys would exist in database dumps.\n');

  try {
    // Run all verification checks
    const [encryptedKeysResult, dumpVerified, decryptionWorked] = await Promise.all([
      verifyEncryptedKeys(),
      verifyDatabaseDump(),
      testKeyDecryption(),
    ]);

    // Display results
    console.log('\n📊 Verification Results:\n');
    console.log(`Total relayers: ${encryptedKeysResult.totalRelayers}`);
    console.log(`Relayers with keys: ${encryptedKeysResult.relayersWithKeys}`);
    console.log(`Relayers with encrypted keys: ${encryptedKeysResult.relayersWithEncryptedKeys}`);
    console.log(
      `Relayers with PLAINTEXT keys: ${encryptedKeysResult.relayersWithPlaintextKeys}`,
    );

    // Show failures
    if (encryptedKeysResult.validationFailures.length > 0) {
      console.log('\n❌ VALIDATION FAILURES:');
      encryptedKeysResult.validationFailures.forEach((failure) => console.log(`  ${failure}`));
    }

    // Show warnings
    if (encryptedKeysResult.warnings.length > 0) {
      console.log('\n⚠️  WARNINGS:');
      encryptedKeysResult.warnings.forEach((warning) => console.log(`  ${warning}`));
    }

    // Final verdict
    const allPassed =
      encryptedKeysResult.passed &&
      dumpVerified &&
      decryptionWorked &&
      encryptedKeysResult.relayersWithPlaintextKeys === 0;

    console.log('\n' + '='.repeat(60));
    if (allPassed) {
      console.log('✅ VERIFICATION PASSED');
      console.log('All private keys are properly encrypted.');
      console.log('Database dumps will contain ZERO unencrypted keys.');
      console.log('='.repeat(60) + '\n');
      process.exit(0);
    } else {
      console.log('❌ VERIFICATION FAILED');
      console.log('Plaintext keys detected or validation errors found.');
      console.log('Database dumps may contain unencrypted sensitive data!');
      console.log('='.repeat(60) + '\n');
      process.exit(1);
    }
  } catch (error: any) {
    console.error('\n❌ FATAL ERROR during verification:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run verification
main();
