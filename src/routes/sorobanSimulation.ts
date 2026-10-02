import { Request, Response, Router } from "express";
import { sendApiError } from "../lib/apiError.js";
import { sorobanTransactionSimulationService } from "../services/sorobanTransactionSimulationService";

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  const transaction = req.body?.transaction;
  if (typeof transaction !== "string" || transaction.trim().length === 0) {
    sendApiError(
      res,
      400,
      "VALIDATION_ERROR",
      "A base64-encoded 'transaction' envelope is required.",
    );
    return;
  }

  try {
    const simulation =
      await sorobanTransactionSimulationService.simulate(transaction);
    res.json({ success: true, data: simulation });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Simulation failed";
    sendApiError(res, 400, "SIMULATION_ERROR", message);
  }
});

export default router;