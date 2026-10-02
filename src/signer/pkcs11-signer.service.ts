import {
  Transaction,
  FeeBumpTransaction,
  Keypair,
  xdr,
} from "@stellar/stellar-sdk";
import { ISigner } from "./signer.interface";
import {
  IPkcs11Client,
  MockPkcs11Client,
  Pkcs11Error,
} from "./pkcs11/pkcs11-client";
import {
  CKM,
  CKU,
  Pkcs11HsmConfig,
  HsmHealthCheckResult,
} from "./pkcs11/pkcs11.types";
import { withSecureString } from "./utils/secureMemory";
import { logger } from "../utils/logger";

/**
 * Custom Error for PKCS#11 HSM Signing and Hardware Failures.
 */
export class HsmSigningError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "HsmSigningError";
  }
}

/**
 * Pkcs11HsmSignerService — Hardware Security Module (PKCS#11) implementation of ISigner.
 *
 * Provides cryptographic signing for Stellar & Soroban smart contract transactions
 * where private key material resides strictly inside a certified Hardware Security Module
 * (AWS CloudHSM, YubiHSM2, SoftHSM2, Thales Luna, etc.).
 *
 * Security Guarantees:
 * - Private keys NEVER exist unencrypted in host process memory.
 * - Private key objects are referenced solely by opaque hardware handles.
 * - PINs and transient buffers are zeroized immediately after authentication.
 * - Comprehensive automated health checks verify token presence and crypto sanity.
 */
export class Pkcs11HsmSignerService implements ISigner {
  private readonly config: Pkcs11HsmConfig;
  private readonly client: IPkcs11Client;
  private sessionHandle: number | null = null;
  private keyHandle: number | null = null;
  private resolvedPublicKey: string | null = null;
  private targetSlotId: number = 0;
  private isConnecting = false;

  constructor(config: Pkcs11HsmConfig, client?: IPkcs11Client) {
    this.config = {
      mechanism: CKM.CKM_EDDSA,
      keyLabel: "stellar-relayer-key",
      ...config,
    };
    this.client = client || new MockPkcs11Client();
  }

  /**
   * Initializes the PKCS#11 subsystem, opens a session, authenticates with PIN,
   * and binds the opaque private key handle.
   */
  public async initialize(): Promise<void> {
    if (this.sessionHandle && this.keyHandle) {
      return;
    }

    if (this.isConnecting) {
      while (this.isConnecting) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return;
    }

    this.isConnecting = true;

    try {
      if (!this.client.isInitialized()) {
        await this.client.initialize();
      }

      const slots = await this.client.getSlots(true);
      if (slots.length === 0) {
        throw new HsmSigningError("No PKCS#11 slots with tokens present detected");
      }

      // Resolve slot ID
      if (this.config.slotId !== undefined) {
        this.targetSlotId = this.config.slotId;
      } else if (this.config.tokenLabel) {
        let found = false;
        for (const s of slots) {
          const tokenInfo = await this.client.getTokenInfo(s.slotId);
          if (tokenInfo.label === this.config.tokenLabel) {
            this.targetSlotId = s.slotId;
            found = true;
            break;
          }
        }
        if (!found) {
          throw new HsmSigningError(
            `HSM Token with label '${this.config.tokenLabel}' not found`,
          );
        }
      } else {
        this.targetSlotId = slots[0].slotId;
      }

      // Open a session
      this.sessionHandle = await this.client.openSession(this.targetSlotId, true);

      // Authenticate with PIN if configured (PIN zeroized immediately after login)
      if (this.config.pin) {
        await withSecureString(this.config.pin, async (pinBuf) => {
          await this.client.login(this.sessionHandle!, CKU.CKU_USER, pinBuf);
        });
      }

      // Locate private key handle in hardware
      this.keyHandle = await this.client.findPrivateKey(
        this.sessionHandle,
        this.config.keyLabel,
        this.config.keyId,
      );

      // Resolve Stellar public key (G... address)
      if (this.config.stellarPublicKey) {
        this.resolvedPublicKey = this.config.stellarPublicKey;
      } else {
        const addr = await this.client.getPublicKeyAddress(
          this.sessionHandle,
          this.config.keyLabel,
          this.config.keyId,
        );
        if (!addr) {
          throw new HsmSigningError(
            "Could not determine Stellar public key from HSM token",
          );
        }
        this.resolvedPublicKey = addr;
      }

      logger.info(
        `[Pkcs11HsmSigner] Successfully authenticated with HSM Slot ${this.targetSlotId}. Public Key: ${this.resolvedPublicKey}`,
      );
    } catch (error: any) {
      logger.error("[Pkcs11HsmSigner] Failed to initialize HSM session:", error);
      await this.cleanupSession();
      throw new HsmSigningError(
        `HSM Initialization Failed: ${error.message || String(error)}`,
        error,
      );
    } finally {
      this.isConnecting = false;
    }
  }

  private async cleanupSession(): Promise<void> {
    if (this.sessionHandle) {
      try {
        await this.client.logout(this.sessionHandle);
      } catch (_) {
        // ignore logout errors on failed session
      }
      try {
        await this.client.closeSession(this.sessionHandle);
      } catch (_) {
        // ignore close errors
      }
      this.sessionHandle = null;
      this.keyHandle = null;
    }
  }

  /**
   * Returns the Stellar public key (G... address) corresponding to the HSM key.
   */
  public async getPublicKey(): Promise<string> {
    if (!this.resolvedPublicKey) {
      await this.initialize();
    }
    return this.resolvedPublicKey!;
  }

  /**
   * Signs a 32-byte transaction hash using the secure HSM enclave.
   * The private key NEVER leaves the hardware boundary.
   *
   * @param txHash - 32-byte transaction hash buffer
   * @returns 64-byte Ed25519 signature buffer
   */
  public async sign(txHash: Buffer): Promise<Buffer> {
    if (!Buffer.isBuffer(txHash) || txHash.length !== 32) {
      throw new HsmSigningError(
        `Invalid transaction hash: expected 32-byte Buffer, got ${txHash?.length ?? 0} bytes`,
      );
    }

    // Ensure session is ready
    if (!this.sessionHandle || !this.keyHandle) {
      await this.initialize();
    }

    try {
      const mechanism = this.config.mechanism ?? CKM.CKM_EDDSA;
      const signature = await this.client.sign(
        this.sessionHandle!,
        this.keyHandle!,
        mechanism,
        txHash,
      );

      if (!signature || signature.length !== 64) {
        throw new HsmSigningError(
          `Invalid signature length returned from HSM: expected 64 bytes, got ${signature?.length ?? 0}`,
        );
      }

      return signature;
    } catch (error: any) {
      logger.error("[Pkcs11HsmSigner] Signing failed on HSM:", error);

      // If session dropped, attempt single re-initialization and retry
      if (
        error instanceof Pkcs11Error &&
        (error.code === 0x000000b3 || error.code === 0x00000101)
      ) {
        logger.warn("[Pkcs11HsmSigner] Session expired, re-initializing session...");
        await this.cleanupSession();
        await this.initialize();
        const signature = await this.client.sign(
          this.sessionHandle!,
          this.keyHandle!,
          this.config.mechanism ?? CKM.CKM_EDDSA,
          txHash,
        );
        return signature;
      }

      throw new HsmSigningError(
        `HSM Signing operation failed: ${error.message || String(error)}`,
        error,
      );
    }
  }

  /**
   * Signs a Stellar / Soroban transaction using the HSM and appends the decorated signature.
   *
   * @param transaction - Stellar Transaction or FeeBumpTransaction to sign
   */
  public async signTransaction<T extends Transaction | FeeBumpTransaction>(
    transaction: T,
  ): Promise<T> {
    const txHash = transaction.hash();
    const signature = await this.sign(txHash);
    const publicKey = await this.getPublicKey();

    // Extract 4-byte signature hint from public key
    const kp = Keypair.fromPublicKey(publicKey);
    const rawPub = kp.rawPublicKey();
    const hint = rawPub.subarray(rawPub.length - 4);

    const decorated = new xdr.DecoratedSignature({
      hint,
      signature,
    });

    transaction.signatures.push(decorated);
    return transaction;
  }

  /**
   * Automated health check verifying HSM hardware status and token presence.
   */
  public async getHealth(): Promise<HsmHealthCheckResult> {
    const checkConfig: Pkcs11HsmConfig = {
      ...this.config,
      slotId: this.targetSlotId,
      stellarPublicKey: this.resolvedPublicKey ?? this.config.stellarPublicKey,
    };
    return this.client.getHealth(checkConfig);
  }

  /**
   * Gracefully shuts down the HSM session.
   */
  public async close(): Promise<void> {
    await this.cleanupSession();
    if (this.client.isInitialized()) {
      await this.client.finalize();
    }
  }
}
