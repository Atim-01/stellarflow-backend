import { KMSClient } from "@aws-sdk/client-kms";
import { ISigner } from "./signer.interface";
import { KmsSignerService } from "./kms-signer.service";
import { LocalSignerService } from "./local-signer.service";
import { Pkcs11HsmSignerService } from "./pkcs11-signer.service";
import { IPkcs11Client } from "./pkcs11/pkcs11-client";

export interface SignerConfig {
  backend: "kms" | "local" | "pkcs11" | "hsm";
  kmsKeyId?: string | undefined;
  kmsRegion?: string | undefined;
  stellarPublicKey?: string | undefined;
  localSecret?: string | undefined;

  // PKCS#11 / HSM Specific Configuration
  hsmLibraryPath?: string | undefined;
  hsmSlotId?: number | undefined;
  hsmTokenLabel?: string | undefined;
  hsmPin?: string | undefined;
  hsmKeyLabel?: string | undefined;
  hsmKeyId?: string | undefined;
  hsmMechanism?: number | undefined;
  hsmClient?: IPkcs11Client | undefined;
}

/**
 * ConfigurationError — thrown when signer configuration is invalid or missing.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * createSigner — Factory function to instantiate the correct ISigner implementation.
 *
 * Reads the backend type and returns KmsSignerService, Pkcs11HsmSignerService, or LocalSignerService.
 * "pkcs11" / "hsm" → Pkcs11HsmSignerService (Hardware Security Module)
 * "kms"            → KmsSignerService (AWS KMS production)
 * "local"          → LocalSignerService (development/test only)
 *
 * @param config - The signer configuration object
 * @returns An instance of ISigner
 * @throws ConfigurationError if required fields are missing for the selected backend
 */
export function createSigner(config: SignerConfig): ISigner {
  if (config.backend === "pkcs11" || config.backend === "hsm") {
    return new Pkcs11HsmSignerService(
      {
        libraryPath: config.hsmLibraryPath,
        slotId: config.hsmSlotId,
        tokenLabel: config.hsmTokenLabel,
        pin: config.hsmPin,
        keyLabel: config.hsmKeyLabel || "stellar-relayer-key",
        keyId: config.hsmKeyId,
        stellarPublicKey: config.stellarPublicKey,
        mechanism: config.hsmMechanism,
      },
      config.hsmClient,
    );
  }

  if (config.backend === "kms") {
    if (!config.kmsKeyId) {
      throw new ConfigurationError("kmsKeyId is required when SIGNER_BACKEND=kms");
    }
    if (!config.stellarPublicKey) {
      throw new ConfigurationError("stellarPublicKey is required when SIGNER_BACKEND=kms");
    }

    const kmsClient = new KMSClient({ region: config.kmsRegion || "us-east-1" });

    return new KmsSignerService(
      config.kmsKeyId,
      config.stellarPublicKey,
      kmsClient,
    );
  }

  if (config.backend === "local") {
    if (!config.localSecret) {
      throw new ConfigurationError("localSecret is required when SIGNER_BACKEND=local");
    }

    if (process.env.NODE_ENV === "production") {
      throw new ConfigurationError("LocalSignerService is NOT allowed in production");
    }

    return new LocalSignerService(config.localSecret);
  }

  throw new ConfigurationError(`Unsupported SIGNER_BACKEND: ${config.backend}`);
}
