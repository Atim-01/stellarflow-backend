import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import express from "express";
import { createServer, Server } from "http";
import type { AddressInfo } from "net";
import crypto from "crypto";
import {
  Keypair,
  TransactionBuilder,
  Account,
  Networks,
  Operation,
} from "@stellar/stellar-sdk";

import {
  Pkcs11HsmSignerService,
  HsmSigningError,
} from "../src/signer/pkcs11-signer.service";
import {
  MockPkcs11Client,
  Pkcs11Error,
} from "../src/signer/pkcs11/pkcs11-client";
import {
  CKR,
  CKM,
  CKU,
  CKF,
  CKO,
  CKK,
} from "../src/signer/pkcs11/pkcs11.types";
import { createSigner, ConfigurationError } from "../src/signer/signer.factory";
import { zeroize, withSecureBuffer, withSecureString } from "../src/signer/utils/secureMemory";
import { createHealthRouter } from "../src/routes/health";
import { probeHsm } from "../src/services/healthProbeService";

describe("PKCS#11 Hardware Security Module (HSM) Key Signing", () => {
  let mockClient: MockPkcs11Client;
  let signerService: Pkcs11HsmSignerService;

  beforeEach(async () => {
    mockClient = new MockPkcs11Client();
    signerService = new Pkcs11HsmSignerService(
      {
        slotId: 0,
        pin: "123456",
        keyLabel: "stellar-relayer-key",
      },
      mockClient,
    );
    await signerService.initialize();
  });

  afterEach(async () => {
    await signerService.close();
  });

  describe("Memory Security & Zeroization (No Private Keys in Host Memory)", () => {
    it("zeroizes sensitive memory buffers completely", () => {
      const sensitiveBuf = Buffer.from("super-secret-hsm-pin-12345", "utf8");
      expect(sensitiveBuf.toString("utf8")).toBe("super-secret-hsm-pin-12345");

      zeroize(sensitiveBuf);

      // Verify buffer has been overwritten with 0s
      expect(sensitiveBuf.every((byte) => byte === 0)).toBe(true);
    });

    it("guarantees zeroization inside withSecureBuffer even if an exception is thrown", async () => {
      const pinBuf = Buffer.from("temp-auth-pin", "utf8");

      await expect(
        withSecureBuffer(pinBuf, async (buf) => {
          expect(buf.toString("utf8")).toBe("temp-auth-pin");
          throw new Error("Simulated auth failure");
        }),
      ).rejects.toThrow("Simulated auth failure");

      // Verify pinBuf is zeroized despite exception
      expect(pinBuf.every((b) => b === 0)).toBe(true);
    });

    it("guarantees withSecureString zeroizes transient buffer", async () => {
      let inspectedBuf: Buffer | null = null;
      await withSecureString("hsm-token-pin-999", (buf) => {
        inspectedBuf = buf;
        expect(buf.toString("utf8")).toBe("hsm-token-pin-999");
      });

      expect(inspectedBuf).not.toBeNull();
      expect(inspectedBuf!.every((b) => b === 0)).toBe(true);
    });
  });

  describe("PKCS#11 Token Lifecycle & Hardware Isolation", () => {
    it("discovers PKCS#11 slots and verifies token presence", async () => {
      const slots = await mockClient.getSlots(true);
      expect(slots.length).toBeGreaterThan(0);
      expect(slots[0].tokenPresent).toBe(true);
      expect(slots[0].flags & CKF.CKF_TOKEN_PRESENT).toBeTruthy();

      const tokenInfo = await mockClient.getTokenInfo(slots[0].slotId);
      expect(tokenInfo.label).toBe("stellarflow-relayer-token");
      expect(tokenInfo.model).toBe("HSM-ED25519-v3");
      expect(tokenInfo.serialNumber).toBe("SF-HSM-98472-X01");
    });

    it("authenticates session using PIN and resolves public key G... address", async () => {
      const publicKey = await signerService.getPublicKey();
      expect(publicKey).toMatch(/^G[A-Z0-9]{55}$/);
    });

    it("fails initialization if wrong PIN is provided", async () => {
      const badSigner = new Pkcs11HsmSignerService(
        {
          slotId: 0,
          pin: "wrong-pin-0000",
          keyLabel: "stellar-relayer-key",
        },
        mockClient,
      );

      await expect(badSigner.initialize()).rejects.toThrow(
        /HSM Initialization Failed.*Incorrect token PIN/,
      );
    });

    it("fails initialization if target key label does not exist on HSM token", async () => {
      const missingKeySigner = new Pkcs11HsmSignerService(
        {
          slotId: 0,
          pin: "123456",
          keyLabel: "non-existent-key-label",
        },
        mockClient,
      );

      await expect(missingKeySigner.initialize()).rejects.toThrow(
        /Private key object not found/,
      );
    });
  });

  describe("Soroban & Stellar Transaction Signing via HSM", () => {
    it("signs raw 32-byte transaction hash and produces verifiable Ed25519 signature", async () => {
      const txHash = crypto.randomBytes(32);
      const signature = await signerService.sign(txHash);

      expect(signature).toBeInstanceOf(Buffer);
      expect(signature.length).toBe(64);

      // Verify signature against public key
      const publicKey = await signerService.getPublicKey();
      const kp = Keypair.fromPublicKey(publicKey);
      const isValid = kp.verify(txHash, signature);

      expect(isValid).toBe(true);
    });

    it("rejects invalid transaction hash lengths", async () => {
      const invalidHash = crypto.randomBytes(16); // Not 32 bytes
      await expect(signerService.sign(invalidHash)).rejects.toThrow(
        /Invalid transaction hash: expected 32-byte Buffer/,
      );
    });

    it("signs full Stellar & Soroban Transaction with decorated signature envelope", async () => {
      const publicKey = await signerService.getPublicKey();
      const account = new Account(publicKey, "100");

      const tx = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: "GBPBBD477W5P7S7CV5XJHQ3Z4G3EQP7TPL6Z25CVGWRT2S3LBLWRTYUS",
            asset: { isNative: () => true } as any,
            amount: "10",
          }),
        )
        .setTimeout(30)
        .build();

      expect(tx.signatures.length).toBe(0);

      // Sign transaction with HSM
      await signerService.signTransaction(tx);

      expect(tx.signatures.length).toBe(1);
      const decoratedSig = tx.signatures[0];

      expect(decoratedSig.hint().length).toBe(4);
      expect(decoratedSig.signature().length).toBe(64);

      // Verify transaction envelope signature
      const kp = Keypair.fromPublicKey(publicKey);
      const txHash = tx.hash();
      const isSigValid = kp.verify(txHash, decoratedSig.signature());

      expect(isSigValid).toBe(true);
    });
  });

  describe("Signer Factory Integration", () => {
    it("creates Pkcs11HsmSignerService when backend is 'pkcs11' or 'hsm'", () => {
      const signer1 = createSigner({
        backend: "pkcs11",
        hsmSlotId: 0,
        hsmPin: "123456",
        hsmKeyLabel: "stellar-relayer-key",
        hsmClient: mockClient,
      });

      expect(signer1).toBeInstanceOf(Pkcs11HsmSignerService);

      const signer2 = createSigner({
        backend: "hsm",
        hsmSlotId: 0,
        hsmPin: "123456",
        hsmKeyLabel: "stellar-relayer-key",
        hsmClient: mockClient,
      });

      expect(signer2).toBeInstanceOf(Pkcs11HsmSignerService);
    });

    it("throws ConfigurationError for unsupported backends", () => {
      expect(() =>
        createSigner({
          backend: "invalid-backend" as any,
        }),
      ).toThrow(ConfigurationError);
    });
  });

  describe("Automated Health Check (HSM Hardware Status & Token Presence)", () => {
    it("returns healthy: true with full hardware telemetry when token is active", async () => {
      const health = await signerService.getHealth();

      expect(health.healthy).toBe(true);
      expect(health.moduleInitialized).toBe(true);
      expect(health.tokenPresent).toBe(true);
      expect(health.authenticated).toBe(true);
      expect(health.keyAccessible).toBe(true);
      expect(health.cryptoSelfTestPassed).toBe(true);
      expect(health.tokenLabel).toBe("stellarflow-relayer-token");
      expect(health.model).toBe("HSM-ED25519-v3");
      expect(health.serialNumber).toBe("SF-HSM-98472-X01");
      expect(health.firmwareVersion).toBe("3.1");
      expect(health.hardwareVersion).toBe("2.40");
    });

    it("returns healthy: false when token is removed from hardware slot", async () => {
      // Simulate token removal from slot 0
      mockClient.setSlotState(0, { tokenPresent: false });

      const health = await mockClient.getHealth({ slotId: 0 });

      expect(health.healthy).toBe(false);
      expect(health.tokenPresent).toBe(false);
      expect(health.error).toBeDefined();
    });

    it("integrates with /health/hsm HTTP diagnostic route", async () => {
      const app = express();
      app.use(
        "/health",
        createHealthRouter(
          undefined,
          async () => {
            const h = await signerService.getHealth();
            return {
              name: "hsm",
              healthy: h.healthy,
              details: h as unknown as Record<string, unknown>,
            };
          },
        ),
      );

      const server: Server = createServer(app);
      server.listen(0);
      await new Promise((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        const res = await fetch(`${baseUrl}/health/hsm`);
        expect(res.status).toBe(200);

        const body = (await res.json()) as any;
        expect(body.success).toBe(true);
        expect(body.status).toBe("healthy");
        expect(body.details.tokenPresent).toBe(true);
        expect(body.details.cryptoSelfTestPassed).toBe(true);
        expect(body.details.model).toBe("HSM-ED25519-v3");
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it("returns 530 / 503 when HSM health probe fails", async () => {
      const app = express();
      app.use(
        "/health",
        createHealthRouter(
          undefined,
          async () => ({
            name: "hsm",
            healthy: false,
            error: "Token removed from HSM slot",
          }),
        ),
      );

      const server: Server = createServer(app);
      server.listen(0);
      await new Promise((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        const res = await fetch(`${baseUrl}/health/hsm`);
        expect(res.status).toBe(503);

        const body = (await res.json()) as any;
        expect(body.success).toBe(false);
        expect(body.status).toBe("unhealthy");
        expect(body.error).toContain("Token removed from HSM slot");
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
