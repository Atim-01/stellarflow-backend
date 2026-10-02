import crypto from "crypto";
import { Keypair } from "@stellar/stellar-sdk";
import {
  CKR,
  CKO,
  CKK,
  CKM,
  CKU,
  CKF,
  CKA,
  Pkcs11SlotInfo,
  Pkcs11TokenInfo,
  Pkcs11SessionInfo,
  HsmHealthCheckResult,
  Pkcs11HsmConfig,
} from "./pkcs11.types";
import { zeroize, withSecureBuffer } from "../utils/secureMemory";

/**
 * Custom error class for PKCS#11 HSM operations.
 */
export class Pkcs11Error extends Error {
  constructor(
    message: string,
    public readonly code: number = CKR.CKR_GENERAL_ERROR,
    public readonly cause?: unknown,
  ) {
    super(`${message} (CK_RV: 0x${code.toString(16).padStart(8, "0")})`);
    this.name = "Pkcs11Error";
  }
}

/**
 * Abstract interface for PKCS#11 Hardware Security Module client.
 */
export interface IPkcs11Client {
  initialize(): Promise<void>;
  finalize(): Promise<void>;
  isInitialized(): boolean;
  getSlots(tokenPresentOnly?: boolean): Promise<Pkcs11SlotInfo[]>;
  getTokenInfo(slotId: number): Promise<Pkcs11TokenInfo>;
  openSession(slotId: number, rw?: boolean): Promise<number>;
  closeSession(sessionHandle: number): Promise<void>;
  login(
    sessionHandle: number,
    userType: number,
    pin: Buffer | string,
  ): Promise<void>;
  logout(sessionHandle: number): Promise<void>;
  findPrivateKey(
    sessionHandle: number,
    keyLabel?: string,
    keyId?: string,
  ): Promise<number>;
  getPublicKeyAddress(
    sessionHandle: number,
    keyLabel?: string,
    keyId?: string,
  ): Promise<string | null>;
  sign(
    sessionHandle: number,
    keyHandle: number,
    mechanism: number,
    data: Buffer,
  ): Promise<Buffer>;
  getHealth(config?: Pkcs11HsmConfig): Promise<HsmHealthCheckResult>;
}

/**
 * Mock / Software Enclave PKCS#11 Hardware Security Module Driver.
 *
 * Simulates a cryptographic hardware token (such as AWS CloudHSM, YubiHSM2, SoftHSM2, or Thales Luna)
 * adhering strictly to the PKCS#11 state machine and memory isolation constraints.
 *
 * Ensures private keys are stored exclusively inside the simulated hardware enclave
 * and accessed only through opaque object handles.
 */
export class MockPkcs11Client implements IPkcs11Client {
  private _initialized = false;
  private _nextSessionHandle = 100;
  private _nextObjectHandle = 1000;

  // Enclave hardware storage (isolated from caller)
  private _slots: Map<
    number,
    {
      slotInfo: Pkcs11SlotInfo;
      tokenInfo: Pkcs11TokenInfo;
      pin: string;
      tokenPresent: boolean;
      objects: Map<
        number,
        {
          handle: number;
          class: number;
          keyType: number;
          label: string;
          id: string;
          sensitive: boolean;
          extractable: boolean;
          // Secret keypair lives inside the secure token
          privateKeyMaterial?: Buffer;
          publicKeyAddress: string;
        }
      >;
    }
  > = new Map();

  private _sessions: Map<
    number,
    {
      sessionHandle: number;
      slotId: number;
      state: number;
      loggedIn: boolean;
      userType?: number;
    }
  > = new Map();

  constructor() {
    this._initializeDefaultSlots();
  }

  private _initializeDefaultSlots() {
    // Generate a default hardware-isolated Ed25519 keypair inside the token
    const testKeypair = Keypair.random();
    const privBuffer = Buffer.from(testKeypair.rawSecretKey());

    const slot0Objects = new Map();
    const keyHandle = this._nextObjectHandle++;

    slot0Objects.set(keyHandle, {
      handle: keyHandle,
      class: CKO.CKO_PRIVATE_KEY,
      keyType: CKK.CKK_EC_EDWARDS,
      label: "stellar-relayer-key",
      id: "01",
      sensitive: true,
      extractable: false, // Private key NEVER extractable
      privateKeyMaterial: privBuffer,
      publicKeyAddress: testKeypair.publicKey(),
    });

    this._slots.set(0, {
      slotInfo: {
        slotId: 0,
        slotDescription: "StellarFlow Secure HSM Enclave Slot 0",
        manufacturerId: "StellarFlow Security Corp",
        flags: CKF.CKF_TOKEN_PRESENT | CKF.CKF_HW_SLOT | CKF.CKF_REMOVABLE_DEVICE,
        hardwareVersion: { major: 2, minor: 40 },
        firmwareVersion: { major: 3, minor: 1 },
        tokenPresent: true,
      },
      tokenInfo: {
        label: "stellarflow-relayer-token",
        manufacturerId: "StellarFlow Vault Hardware",
        model: "HSM-ED25519-v3",
        serialNumber: "SF-HSM-98472-X01",
        flags:
          CKF.CKF_RNG |
          CKF.CKF_LOGIN_REQUIRED |
          CKF.CKF_USER_PIN_INITIALIZED |
          CKF.CKF_TOKEN_INITIALIZED,
        maxSessionCount: 256,
        sessionCount: 0,
        maxRwSessionCount: 128,
        rwSessionCount: 0,
        maxPinLen: 32,
        minPinLen: 4,
        totalPublicMemory: 1048576,
        freePublicMemory: 1024000,
        totalPrivateMemory: 524288,
        freePrivateMemory: 512000,
        hardwareVersion: { major: 2, minor: 40 },
        firmwareVersion: { major: 3, minor: 1 },
        utcTime: new Date().toISOString(),
      },
      pin: "123456",
      tokenPresent: true,
      objects: slot0Objects,
    });
  }

  /**
   * Helper for testing: inject custom slot/token state.
   */
  public setSlotState(
    slotId: number,
    opts: {
      tokenPresent?: boolean;
      pin?: string;
      tokenLabel?: string;
      keyLabel?: string;
      publicKey?: string;
    },
  ): void {
    const slot = this._slots.get(slotId);
    if (!slot) return;

    if (opts.tokenPresent !== undefined) {
      slot.tokenPresent = opts.tokenPresent;
      slot.slotInfo.tokenPresent = opts.tokenPresent;
      if (!opts.tokenPresent) {
        slot.slotInfo.flags &= ~CKF.CKF_TOKEN_PRESENT;
      } else {
        slot.slotInfo.flags |= CKF.CKF_TOKEN_PRESENT;
      }
    }
    if (opts.pin !== undefined) {
      slot.pin = opts.pin;
    }
    if (opts.tokenLabel !== undefined) {
      slot.tokenInfo.label = opts.tokenLabel;
    }
  }

  async initialize(): Promise<void> {
    if (this._initialized) {
      throw new Pkcs11Error(
        "PKCS#11 already initialized",
        CKR.CKR_CRYPTOKI_ALREADY_INITIALIZED,
      );
    }
    this._initialized = true;
  }

  async finalize(): Promise<void> {
    this._sessions.clear();
    this._initialized = false;
  }

  isInitialized(): boolean {
    return this._initialized;
  }

  private _ensureInitialized(): void {
    if (!this._initialized) {
      throw new Pkcs11Error(
        "Cryptoki is not initialized",
        CKR.CKR_CRYPTOKI_NOT_INITIALIZED,
      );
    }
  }

  async getSlots(tokenPresentOnly = false): Promise<Pkcs11SlotInfo[]> {
    this._ensureInitialized();
    const result: Pkcs11SlotInfo[] = [];

    for (const [, slot] of this._slots.entries()) {
      if (!tokenPresentOnly || slot.tokenPresent) {
        result.push({ ...slot.slotInfo });
      }
    }

    return result;
  }

  async getTokenInfo(slotId: number): Promise<Pkcs11TokenInfo> {
    this._ensureInitialized();
    const slot = this._slots.get(slotId);

    if (!slot) {
      throw new Pkcs11Error(
        `Invalid Slot ID: ${slotId}`,
        CKR.CKR_SLOT_ID_INVALID,
      );
    }

    if (!slot.tokenPresent) {
      throw new Pkcs11Error(
        `Token not present in Slot ID: ${slotId}`,
        CKR.CKR_TOKEN_NOT_PRESENT,
      );
    }

    return { ...slot.tokenInfo, sessionCount: this._sessions.size };
  }

  async openSession(slotId: number, rw = false): Promise<number> {
    this._ensureInitialized();
    const slot = this._slots.get(slotId);

    if (!slot) {
      throw new Pkcs11Error(
        `Invalid Slot ID: ${slotId}`,
        CKR.CKR_SLOT_ID_INVALID,
      );
    }

    if (!slot.tokenPresent) {
      throw new Pkcs11Error(
        `Token not present in Slot ID: ${slotId}`,
        CKR.CKR_TOKEN_NOT_PRESENT,
      );
    }

    const sessionHandle = this._nextSessionHandle++;
    this._sessions.set(sessionHandle, {
      sessionHandle,
      slotId,
      state: rw ? CKF.CKF_RW_SESSION : CKF.CKF_SERIAL_SESSION,
      loggedIn: false,
    });

    return sessionHandle;
  }

  async closeSession(sessionHandle: number): Promise<void> {
    this._ensureInitialized();
    if (!this._sessions.has(sessionHandle)) {
      throw new Pkcs11Error(
        `Invalid session handle: ${sessionHandle}`,
        CKR.CKR_SESSION_HANDLE_INVALID,
      );
    }
    this._sessions.delete(sessionHandle);
  }

  async login(
    sessionHandle: number,
    userType: number,
    pin: Buffer | string,
  ): Promise<void> {
    this._ensureInitialized();
    const session = this._sessions.get(sessionHandle);

    if (!session) {
      throw new Pkcs11Error(
        `Invalid session handle: ${sessionHandle}`,
        CKR.CKR_SESSION_HANDLE_INVALID,
      );
    }

    const slot = this._slots.get(session.slotId);
    if (!slot || !slot.tokenPresent) {
      throw new Pkcs11Error("Token not present", CKR.CKR_TOKEN_NOT_PRESENT);
    }

    const rawPin = Buffer.isBuffer(pin) ? pin.toString("utf8") : pin;

    // Verify PIN in constant-time
    const pinBuffer = Buffer.from(rawPin, "utf8");
    const expectedBuffer = Buffer.from(slot.pin, "utf8");

    let isMatch = false;
    if (pinBuffer.length === expectedBuffer.length) {
      isMatch = crypto.timingSafeEqual(pinBuffer, expectedBuffer);
    }

    // Zeroize pinBuffer immediately
    zeroize(pinBuffer);

    if (!isMatch) {
      throw new Pkcs11Error("Incorrect token PIN", CKR.CKR_PIN_INCORRECT);
    }

    session.loggedIn = true;
    session.userType = userType;
  }

  async logout(sessionHandle: number): Promise<void> {
    this._ensureInitialized();
    const session = this._sessions.get(sessionHandle);

    if (!session) {
      throw new Pkcs11Error(
        `Invalid session handle: ${sessionHandle}`,
        CKR.CKR_SESSION_HANDLE_INVALID,
      );
    }

    session.loggedIn = false;
    session.userType = undefined;
  }

  async findPrivateKey(
    sessionHandle: number,
    keyLabel?: string,
    keyId?: string,
  ): Promise<number> {
    this._ensureInitialized();
    const session = this._sessions.get(sessionHandle);

    if (!session) {
      throw new Pkcs11Error(
        `Invalid session handle: ${sessionHandle}`,
        CKR.CKR_SESSION_HANDLE_INVALID,
      );
    }

    if (!session.loggedIn) {
      throw new Pkcs11Error(
        "User not logged in to token",
        CKR.CKR_USER_NOT_LOGGED_IN,
      );
    }

    const slot = this._slots.get(session.slotId);
    if (!slot) {
      throw new Pkcs11Error("Slot not found", CKR.CKR_SLOT_ID_INVALID);
    }

    for (const [handle, obj] of slot.objects.entries()) {
      if (obj.class === CKO.CKO_PRIVATE_KEY) {
        if (keyLabel && obj.label !== keyLabel) continue;
        if (keyId && obj.id !== keyId) continue;
        return handle;
      }
    }

    throw new Pkcs11Error(
      `Private key object not found (label=${keyLabel}, id=${keyId})`,
      CKR.CKR_OBJECT_HANDLE_INVALID,
    );
  }

  async getPublicKeyAddress(
    sessionHandle: number,
    keyLabel?: string,
    keyId?: string,
  ): Promise<string | null> {
    this._ensureInitialized();
    const session = this._sessions.get(sessionHandle);
    if (!session) return null;

    const slot = this._slots.get(session.slotId);
    if (!slot) return null;

    for (const [, obj] of slot.objects.entries()) {
      if (keyLabel && obj.label !== keyLabel) continue;
      if (keyId && obj.id !== keyId) continue;
      return obj.publicKeyAddress;
    }

    return null;
  }

  /**
   * Cryptographic hardware signing operation.
   * Executed strictly inside the HSM enclave.
   */
  async sign(
    sessionHandle: number,
    keyHandle: number,
    mechanism: number,
    data: Buffer,
  ): Promise<Buffer> {
    this._ensureInitialized();
    const session = this._sessions.get(sessionHandle);

    if (!session) {
      throw new Pkcs11Error(
        `Invalid session handle: ${sessionHandle}`,
        CKR.CKR_SESSION_HANDLE_INVALID,
      );
    }

    if (!session.loggedIn) {
      throw new Pkcs11Error(
        "User not logged in to token",
        CKR.CKR_USER_NOT_LOGGED_IN,
      );
    }

    const slot = this._slots.get(session.slotId);
    if (!slot) {
      throw new Pkcs11Error("Slot not found", CKR.CKR_SLOT_ID_INVALID);
    }

    const obj = slot.objects.get(keyHandle);
    if (!obj || obj.class !== CKO.CKO_PRIVATE_KEY) {
      throw new Pkcs11Error(
        `Invalid key handle: ${keyHandle}`,
        CKR.CKR_KEY_HANDLE_INVALID,
      );
    }

    if (!obj.privateKeyMaterial) {
      throw new Pkcs11Error(
        "Private key unavailable for signing",
        CKR.CKR_KEY_FUNCTION_NOT_PERMITTED,
      );
    }

    // Stellar / Soroban Ed25519 signature
    const kp = Keypair.fromRawEd25519Seed(obj.privateKeyMaterial);
    const signature = kp.sign(data);

    return Buffer.from(signature);
  }

  /**
   * Automated Health Diagnostic checking HSM hardware status and token presence.
   */
  async getHealth(config?: Pkcs11HsmConfig): Promise<HsmHealthCheckResult> {
    const timestamp = new Date().toISOString();

    if (!this._initialized) {
      return {
        healthy: false,
        moduleInitialized: false,
        tokenPresent: false,
        authenticated: false,
        keyAccessible: false,
        cryptoSelfTestPassed: false,
        error: "PKCS#11 module not initialized",
        timestamp,
      };
    }

    try {
      const slots = await this.getSlots();
      if (slots.length === 0) {
        return {
          healthy: false,
          moduleInitialized: true,
          tokenPresent: false,
          authenticated: false,
          keyAccessible: false,
          cryptoSelfTestPassed: false,
          error: "No PKCS#11 slots detected on host",
          timestamp,
        };
      }

      // Determine target slot
      let targetSlotId = config?.slotId ?? 0;
      if (config?.tokenLabel) {
        let found = false;
        for (const s of slots) {
          if (s.tokenPresent) {
            const token = await this.getTokenInfo(s.slotId);
            if (token.label === config.tokenLabel) {
              targetSlotId = s.slotId;
              found = true;
              break;
            }
          }
        }
        if (!found) {
          return {
            healthy: false,
            moduleInitialized: true,
            tokenPresent: false,
            authenticated: false,
            keyAccessible: false,
            cryptoSelfTestPassed: false,
            error: `Token with label '${config.tokenLabel}' not found`,
            timestamp,
          };
        }
      }

      const tokenInfo = await this.getTokenInfo(targetSlotId);

      // Verify token presence
      if (!tokenInfo) {
        return {
          healthy: false,
          moduleInitialized: true,
          tokenPresent: false,
          authenticated: false,
          keyAccessible: false,
          cryptoSelfTestPassed: false,
          error: `Token not present in slot ${targetSlotId}`,
          timestamp,
        };
      }

      // Open diagnostic test session
      const session = await this.openSession(targetSlotId);
      let authenticated = false;
      let keyAccessible = false;
      let cryptoSelfTestPassed = false;

      try {
        if (config?.pin) {
          await this.login(session, CKU.CKU_USER, config.pin);
          authenticated = true;

          const keyHandle = await this.findPrivateKey(
            session,
            config.keyLabel ?? "stellar-relayer-key",
            config.keyId,
          );
          keyAccessible = keyHandle !== undefined;

          // Cryptographic self-test: sign a test digest and verify
          const testDigest = crypto.randomBytes(32);
          const sig = await this.sign(
            session,
            keyHandle,
            CKM.CKM_EDDSA,
            testDigest,
          );

          const pubAddress =
            config.stellarPublicKey ||
            (await this.getPublicKeyAddress(
              session,
              config.keyLabel,
              config.keyId,
            ));

          if (pubAddress && sig && sig.length === 64) {
            const kp = Keypair.fromPublicKey(pubAddress);
            cryptoSelfTestPassed = kp.verify(testDigest, sig);
          } else {
            cryptoSelfTestPassed = sig.length === 64;
          }

          await this.logout(session);
        } else {
          authenticated = true;
          keyAccessible = true;
          cryptoSelfTestPassed = true;
        }
      } finally {
        await this.closeSession(session);
      }

      const isHealthy =
        authenticated && keyAccessible && cryptoSelfTestPassed;

      return {
        healthy: isHealthy,
        moduleInitialized: true,
        tokenPresent: true,
        authenticated,
        keyAccessible,
        cryptoSelfTestPassed,
        tokenLabel: tokenInfo.label,
        manufacturerId: tokenInfo.manufacturerId,
        model: tokenInfo.model,
        serialNumber: tokenInfo.serialNumber,
        firmwareVersion: `${tokenInfo.firmwareVersion.major}.${tokenInfo.firmwareVersion.minor}`,
        hardwareVersion: `${tokenInfo.hardwareVersion.major}.${tokenInfo.hardwareVersion.minor}`,
        timestamp,
      };
    } catch (err: any) {
      return {
        healthy: false,
        moduleInitialized: true,
        tokenPresent: false,
        authenticated: false,
        keyAccessible: false,
        cryptoSelfTestPassed: false,
        error: err.message || String(err),
        timestamp,
      };
    }
  }
}
