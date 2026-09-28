import dotenv from "dotenv";
import { createSigner, SignerConfig } from "./signer.factory";
import { ISigner } from "./signer.interface";
import { getSecretKey, getPublicKey } from "../services/secretManager";

dotenv.config();

const backendType = (process.env.SIGNER_BACKEND as
  | "kms"
  | "local"
  | "pkcs11"
  | "hsm") || "local";

const config: SignerConfig = {
  backend: backendType,
  kmsKeyId: process.env.AWS_KMS_KEY_ID,
  kmsRegion: process.env.AWS_REGION,
  stellarPublicKey: process.env.HSM_PUBLIC_KEY || getPublicKey(),
  localSecret:
    backendType === "kms" || backendType === "pkcs11" || backendType === "hsm"
      ? undefined
      : getSecretKey(),
  // PKCS#11 / HSM parameters
  hsmLibraryPath: process.env.HSM_LIBRARY_PATH || process.env.PKCS11_LIB_PATH,
  hsmSlotId: process.env.HSM_SLOT_ID
    ? parseInt(process.env.HSM_SLOT_ID, 10)
    : undefined,
  hsmTokenLabel: process.env.HSM_TOKEN_LABEL,
  hsmPin: process.env.HSM_PIN || process.env.PKCS11_PIN,
  hsmKeyLabel: process.env.HSM_KEY_LABEL || "stellar-relayer-key",
  hsmKeyId: process.env.HSM_KEY_ID,
};

export const signer: ISigner = createSigner(config);

export * from "./signer.interface";
export * from "./kms-signer.service";
export * from "./local-signer.service";
export * from "./pkcs11-signer.service";
export * from "./signer.factory";
export * from "./pkcs11/pkcs11.types";
export * from "./pkcs11/pkcs11-client";
export * from "./utils/secureMemory";
