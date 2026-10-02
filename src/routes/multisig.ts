import express, { Request, Response } from "express";
import { sendApiError } from "../lib/apiError";
import { multiSigService } from "../services/multiSigService";
import { isLockdownError } from "../state/appState";
import { sanitizeSignatureRequest } from "../middleware/payloadSanitizer";

const router = express.Router();

/**
 * POST /api/v1/multisig/sign
 * Collect a partial signature for a multi-sig administration account.
 *
 * Accepts a signature payload, validates it against the required signer
 * threshold, and once the threshold is met, broadcasts the fully signed
 * transaction envelope to the Soroban RPC.
 *
 * Request body:
 * {
 *   multiSigPriceId: number,
 *   signature: string,
 *   signerPublicKey: string,
 *   signerName?: string
 * }
 */
router.post(
  "/sign",
  sanitizeSignatureRequest,
  async (req: Request, res: Response) => {
    try {
      const { multiSigPriceId, signature, signerPublicKey, signerName } =
        req.body;

      const result = await multiSigService.collectSignature({
        multiSigPriceId,
        signature,
        signerPublicKey,
        signerName,
      });

      res.json({
        success: true,
        data: {
          multiSigPriceId,
          collectedSignatures: result.collectedSignatures,
          requiredSignatures: result.requiredSignatures,
          thresholdMet: result.thresholdMet,
          broadcast: result.broadcast ?? null,
        },
      });
    } catch (error) {
      console.error("[API] Multi-sig signature collection failed:", error);
      res.status(isLockdownError(error) ? error.statusCode : 400).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

export default router;
